#!/usr/bin/env python3
"""
Nebraska APA Audit Data Extractor — Standalone CLI Script
=========================================================
Reads a CSV file of PDF URLs, downloads and extracts financial data from each
audit report using the Anthropic Claude API, and writes a formatted Excel file.

Usage:
    python extract_audits.py urls.csv
    python extract_audits.py urls.csv --output results.xlsx --max-pages 15
    python extract_audits.py urls.csv --workers 3 --cache-dir ./my_cache

Environment variables:
    ANTHROPIC_API_KEY   Required. Your Anthropic API key.
    PDF_CACHE_DIR       Optional. Directory for caching downloaded PDFs.
"""

import os
import sys
import csv
import argparse
import logging
from datetime import datetime
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

import pandas as pd
from tqdm import tqdm
from dotenv import load_dotenv
from openpyxl import Workbook
from openpyxl.styles import (
    Font, PatternFill, Alignment, Border, Side
)
from openpyxl.utils import get_column_letter

# Local library
sys.path.insert(0, str(Path(__file__).parent))
from lib.extractor import (
    extract_audit,
    estimate_cost,
    FIELDS,
    COLUMN_HEADERS,
    CURRENCY_FIELDS,
    DEFAULT_CACHE_DIR,
    DEFAULT_MAX_PAGES,
    DEFAULT_MODEL,
)

load_dotenv()

logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Excel Formatting
# ---------------------------------------------------------------------------

HEADER_FILL = PatternFill("solid", fgColor="1F3864")  # Dark navy blue
HEADER_FONT = Font(name="Arial", bold=True, color="FFFFFF", size=10)
DATA_FONT = Font(name="Arial", size=10)
ALT_FILL = PatternFill("solid", fgColor="EBF0F7")  # Light blue-grey
CURRENCY_FORMAT = '_($* #,##0_);_($* (#,##0);_($* "-"_);_(@_)'
ZERO_DASH_FORMAT = '_($* #,##0_);_($* (#,##0);_($* "-"_);_(@_)'

THIN_BORDER = Border(
    left=Side(style="thin", color="D0D0D0"),
    right=Side(style="thin", color="D0D0D0"),
    top=Side(style="thin", color="D0D0D0"),
    bottom=Side(style="thin", color="D0D0D0"),
)


def write_excel(records: list[dict], output_path: Path) -> None:
    """Write audit records to a formatted Excel workbook."""
    wb = Workbook()

    # ---- Main Data Sheet ----
    ws = wb.active
    ws.title = "Audit Data"

    headers = [COLUMN_HEADERS.get(f, f) for f in FIELDS]
    ws.append(headers)

    # Style header row
    for col_idx, _ in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=col_idx)
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = THIN_BORDER

    ws.row_dimensions[1].height = 30
    ws.freeze_panes = "A2"

    # Write data rows
    for row_idx, record in enumerate(records, start=2):
        alt = (row_idx % 2 == 0)
        for col_idx, field in enumerate(FIELDS, start=1):
            val = record.get(field)
            cell = ws.cell(row=row_idx, column=col_idx, value=val)
            cell.font = DATA_FONT
            cell.border = THIN_BORDER
            cell.alignment = Alignment(vertical="center")
            if alt and field not in ("source_url",):
                cell.fill = ALT_FILL

            if field in CURRENCY_FIELDS and val is not None:
                try:
                    cell.value = float(val)
                    cell.number_format = CURRENCY_FORMAT
                except (ValueError, TypeError):
                    pass
            elif field == "number_of_findings" and val is not None:
                try:
                    cell.value = int(val)
                except (ValueError, TypeError):
                    pass
            elif field in ("material_weakness", "significant_deficiency"):
                if val is True:
                    cell.value = "Yes"
                    cell.font = Font(name="Arial", size=10, bold=True, color="C00000")
                elif val is False:
                    cell.value = "No"

    # Auto-size columns (cap at reasonable widths)
    col_widths = {
        "source_url": 50,
        "entity_name": 35,
        "auditor_name": 30,
        "extraction_status": 20,
    }
    for col_idx, field in enumerate(FIELDS, start=1):
        letter = get_column_letter(col_idx)
        if field in col_widths:
            ws.column_dimensions[letter].width = col_widths[field]
        elif field in CURRENCY_FIELDS:
            ws.column_dimensions[letter].width = 18
        else:
            ws.column_dimensions[letter].width = 16

    # ---- Summary Sheet ----
    ws2 = wb.create_sheet("Summary")
    _write_summary_sheet(ws2, records)

    wb.save(output_path)
    print(f"\nExcel saved: {output_path}")


def _write_summary_sheet(ws, records: list[dict]) -> None:
    """Populate the Summary worksheet."""
    ws.column_dimensions["A"].width = 35
    ws.column_dimensions["B"].width = 20

    def section_header(row, text):
        cell = ws.cell(row=row, column=1, value=text)
        cell.font = Font(name="Arial", bold=True, color="FFFFFF", size=11)
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(horizontal="left", vertical="center")
        ws.row_dimensions[row].height = 22
        # Merge across two columns
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=2)

    def data_row(row, label, value):
        c1 = ws.cell(row=row, column=1, value=label)
        c2 = ws.cell(row=row, column=2, value=value)
        c1.font = Font(name="Arial", size=10)
        c2.font = Font(name="Arial", size=10, bold=True)
        c2.alignment = Alignment(horizontal="right")

    row = 1
    section_header(row, "Processing Summary")
    row += 1

    total = len(records)
    successes = sum(1 for r in records if r.get("extraction_status") == "success")
    errors = total - successes

    data_row(row, "Total Entities Processed", total); row += 1
    data_row(row, "Successful Extractions", successes); row += 1
    data_row(row, "Failed Extractions", errors); row += 1
    data_row(row, "Generated On", datetime.now().strftime("%Y-%m-%d %H:%M:%S")); row += 1

    # By entity type
    row += 1
    section_header(row, "Breakdown by Entity Type"); row += 1
    type_counts: dict[str, int] = {}
    for r in records:
        et = r.get("entity_type") or "Unknown"
        type_counts[et] = type_counts.get(et, 0) + 1
    for et, count in sorted(type_counts.items(), key=lambda x: -x[1]):
        data_row(row, et, count); row += 1

    # By audit opinion
    row += 1
    section_header(row, "Breakdown by Audit Opinion"); row += 1
    opinion_counts: dict[str, int] = {}
    for r in records:
        op = r.get("audit_opinion") or "Unknown"
        opinion_counts[op] = opinion_counts.get(op, 0) + 1
    for op, count in sorted(opinion_counts.items(), key=lambda x: -x[1]):
        data_row(row, op, count); row += 1

    # Findings summary
    row += 1
    section_header(row, "Findings Summary"); row += 1
    total_findings = sum(
        int(r.get("number_of_findings") or 0)
        for r in records
        if r.get("number_of_findings") is not None
    )
    mw_count = sum(1 for r in records if r.get("material_weakness") is True)
    sd_count = sum(1 for r in records if r.get("significant_deficiency") is True)
    data_row(row, "Total Number of Findings", total_findings); row += 1
    data_row(row, "Entities with Material Weakness", mw_count); row += 1
    data_row(row, "Entities with Significant Deficiency", sd_count); row += 1


# ---------------------------------------------------------------------------
# Processing Log
# ---------------------------------------------------------------------------

def write_processing_log(records: list[dict], log_path: Path) -> None:
    """Write a CSV processing log."""
    with open(log_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["url", "entity_name", "status", "timestamp"])
        writer.writeheader()
        for r in records:
            writer.writerow({
                "url": r.get("source_url", ""),
                "entity_name": r.get("entity_name", ""),
                "status": r.get("extraction_status", ""),
                "timestamp": datetime.now().isoformat(),
            })
    print(f"Processing log saved: {log_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def load_urls(csv_path: Path) -> list[str]:
    """Load URLs from a CSV file. Column must be named 'url'."""
    urls = []
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        if "url" not in (reader.fieldnames or []):
            sys.exit(
                f"ERROR: CSV must have a column named 'url'. "
                f"Found: {reader.fieldnames}"
            )
        for row in reader:
            u = row["url"].strip()
            if u:
                urls.append(u)
    return urls


def main():
    parser = argparse.ArgumentParser(
        description="Extract financial data from Nebraska APA audit PDFs."
    )
    parser.add_argument("csv_file", help="Path to CSV file with 'url' column")
    parser.add_argument(
        "--output", "-o",
        default=None,
        help="Output Excel filename (default: audit_results_YYYYMMDD_HHMMSS.xlsx)"
    )
    parser.add_argument(
        "--cache-dir", default=str(DEFAULT_CACHE_DIR),
        help=f"Directory to cache PDFs (default: {DEFAULT_CACHE_DIR})"
    )
    parser.add_argument(
        "--max-pages", type=int, default=DEFAULT_MAX_PAGES,
        help=f"Max PDF pages to send to API (default: {DEFAULT_MAX_PAGES})"
    )
    parser.add_argument(
        "--model", default=DEFAULT_MODEL,
        help=f"Claude model to use (default: {DEFAULT_MODEL})"
    )
    parser.add_argument(
        "--workers", type=int, default=1,
        help="Parallel workers (default: 1). Be careful with API rate limits."
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Process only the first N URLs (for testing)"
    )
    parser.add_argument(
        "--estimate-only", action="store_true",
        help="Print cost estimate and exit without processing"
    )
    args = parser.parse_args()

    # API key
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        sys.exit("ERROR: ANTHROPIC_API_KEY environment variable not set.")

    csv_path = Path(args.csv_file)
    if not csv_path.exists():
        sys.exit(f"ERROR: File not found: {csv_path}")

    urls = load_urls(csv_path)
    if args.limit:
        urls = urls[: args.limit]

    print(f"Loaded {len(urls)} URLs from {csv_path}")

    # Cost estimate
    estimate = estimate_cost(len(urls), max_pages=args.max_pages)
    print(
        f"Estimated API cost: ${estimate['low_estimate_usd']} – "
        f"${estimate['high_estimate_usd']} USD "
        f"(~${estimate['estimated_total_usd']} mid estimate)"
    )

    if args.estimate_only:
        return

    cache_dir = Path(args.cache_dir)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = Path(args.output) if args.output else Path(f"audit_results_{timestamp}.xlsx")
    log_path = Path(f"processing_log.csv")

    records = []

    if args.workers > 1:
        # Parallel processing
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = {
                executor.submit(
                    extract_audit,
                    url=url,
                    api_key=api_key,
                    cache_dir=cache_dir,
                    model=args.model,
                    max_pages=args.max_pages,
                ): url
                for url in urls
            }
            with tqdm(total=len(urls), desc="Extracting", unit="PDF") as pbar:
                for future in as_completed(futures):
                    url = futures[future]
                    try:
                        result = future.result()
                    except Exception as e:
                        result = {field: None for field in FIELDS}
                        result["source_url"] = url
                        result["extraction_status"] = f"exception: {str(e)[:80]}"
                    records.append(result)
                    status = result.get("extraction_status", "?")
                    name = result.get("entity_name") or "Unknown"
                    pbar.set_postfix({"last": f"{name[:25]} [{status}]"})
                    pbar.update(1)
    else:
        # Sequential processing
        with tqdm(total=len(urls), desc="Extracting", unit="PDF") as pbar:
            for url in urls:
                result = extract_audit(
                    url=url,
                    api_key=api_key,
                    cache_dir=cache_dir,
                    model=args.model,
                    max_pages=args.max_pages,
                )
                records.append(result)
                status = result.get("extraction_status", "?")
                name = result.get("entity_name") or "Unknown"
                pbar.set_postfix({"last": f"{name[:25]} [{status}]"})
                pbar.update(1)

    print(f"\nProcessed {len(records)} entities.")
    successes = sum(1 for r in records if r.get("extraction_status") == "success")
    print(f"  Success: {successes}  |  Errors: {len(records) - successes}")

    write_excel(records, output_path)
    write_processing_log(records, log_path)


if __name__ == "__main__":
    main()
