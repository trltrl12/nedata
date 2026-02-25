"""
Nebraska APA Audit Data Extractor - Core Library
Shared extraction logic for both local runs and Vercel deployment.
"""

import os
import json
import base64
import hashlib
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import Optional, Callable

import httpx
import fitz  # PyMuPDF
from anthropic import Anthropic
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DEFAULT_MODEL = "claude-sonnet-4-6"
DEFAULT_MAX_PAGES = 15
DEFAULT_MAX_RETRIES = 3
DEFAULT_CACHE_DIR = Path("./pdf_cache")

FIELDS = [
    "entity_name",
    "entity_type",
    "fiscal_year_end",
    "audit_date",
    "auditor_name",
    "audit_opinion",
    "number_of_findings",
    "material_weakness",
    "significant_deficiency",
    "total_receipts",
    "total_disbursements",
    "net_change_in_fund_balance",
    "total_assets",
    "fund_balance_end_of_year",
    "fund_balance_beginning_of_year",
    "cash_and_investments",
    "tax_revenue_total",
    "property_tax",
    "intergovernmental_revenue",
    "charges_for_services",
    "investment_income",
    "miscellaneous_revenue",
    "general_govt_disbursements",
    "public_safety_disbursements",
    "public_works_disbursements",
    "education_disbursements",
    "debt_service_disbursements",
    "capital_outlay_disbursements",
    "total_long_term_debt",
    "general_fund_balance",
    "road_bridge_fund_balance",
    "source_url",
    "extraction_status",
]

COLUMN_HEADERS = {
    "entity_name": "Entity Name",
    "entity_type": "Entity Type",
    "fiscal_year_end": "Fiscal Year End",
    "audit_date": "Audit Date",
    "auditor_name": "Auditor Name",
    "audit_opinion": "Audit Opinion",
    "number_of_findings": "Number of Findings",
    "material_weakness": "Material Weakness",
    "significant_deficiency": "Significant Deficiency",
    "total_receipts": "Total Receipts",
    "total_disbursements": "Total Disbursements",
    "net_change_in_fund_balance": "Net Change in Fund Balance",
    "total_assets": "Total Assets",
    "fund_balance_end_of_year": "Fund Balance (End of Year)",
    "fund_balance_beginning_of_year": "Fund Balance (Beginning of Year)",
    "cash_and_investments": "Cash and Investments",
    "tax_revenue_total": "Tax Revenue Total",
    "property_tax": "Property Tax",
    "intergovernmental_revenue": "Intergovernmental Revenue",
    "charges_for_services": "Charges for Services",
    "investment_income": "Investment Income",
    "miscellaneous_revenue": "Miscellaneous Revenue",
    "general_govt_disbursements": "General Govt Disbursements",
    "public_safety_disbursements": "Public Safety Disbursements",
    "public_works_disbursements": "Public Works Disbursements",
    "education_disbursements": "Education Disbursements",
    "debt_service_disbursements": "Debt Service Disbursements",
    "capital_outlay_disbursements": "Capital Outlay Disbursements",
    "total_long_term_debt": "Total Long-Term Debt",
    "general_fund_balance": "General Fund Balance",
    "road_bridge_fund_balance": "Road/Bridge Fund Balance",
    "source_url": "Source URL",
    "extraction_status": "Extraction Status",
}

CURRENCY_FIELDS = {
    "total_receipts",
    "total_disbursements",
    "net_change_in_fund_balance",
    "total_assets",
    "fund_balance_end_of_year",
    "fund_balance_beginning_of_year",
    "cash_and_investments",
    "tax_revenue_total",
    "property_tax",
    "intergovernmental_revenue",
    "charges_for_services",
    "investment_income",
    "miscellaneous_revenue",
    "general_govt_disbursements",
    "public_safety_disbursements",
    "public_works_disbursements",
    "education_disbursements",
    "debt_service_disbursements",
    "capital_outlay_disbursements",
    "total_long_term_debt",
    "general_fund_balance",
    "road_bridge_fund_balance",
}

EXTRACTION_PROMPT = """You are an expert at extracting financial data from Nebraska government audit reports.
Analyze the provided audit report PDF pages and extract ALL of the following fields.

Return ONLY a valid JSON object with exactly these keys. Use null for any field not found.
For boolean fields (material_weakness, significant_deficiency), return true or false.
For numeric/currency fields, return numbers only (no $ signs, no commas).
For audit_opinion, use exactly one of: "Unmodified", "Modified", "Adverse", "Disclaimer".

{
  "entity_name": "Full legal name of the audited entity",
  "entity_type": "County | School District | Village | City | Fire District | ESU | NRD | Other",
  "fiscal_year_end": "MM/DD/YYYY or YYYY-MM-DD",
  "audit_date": "MM/DD/YYYY or YYYY-MM-DD",
  "auditor_name": "Name of auditor or audit firm",
  "audit_opinion": "Unmodified | Modified | Adverse | Disclaimer",
  "number_of_findings": integer or null,
  "material_weakness": true/false or null,
  "significant_deficiency": true/false or null,
  "total_receipts": numeric or null,
  "total_disbursements": numeric or null,
  "net_change_in_fund_balance": numeric or null,
  "total_assets": numeric or null,
  "fund_balance_end_of_year": numeric or null,
  "fund_balance_beginning_of_year": numeric or null,
  "cash_and_investments": numeric or null,
  "tax_revenue_total": numeric or null,
  "property_tax": numeric or null,
  "intergovernmental_revenue": numeric or null,
  "charges_for_services": numeric or null,
  "investment_income": numeric or null,
  "miscellaneous_revenue": numeric or null,
  "general_govt_disbursements": numeric or null,
  "public_safety_disbursements": numeric or null,
  "public_works_disbursements": numeric or null,
  "education_disbursements": numeric or null,
  "debt_service_disbursements": numeric or null,
  "capital_outlay_disbursements": numeric or null,
  "total_long_term_debt": numeric or null,
  "general_fund_balance": numeric or null,
  "road_bridge_fund_balance": numeric or null
}

Document pages follow. Extract carefully — documents vary widely in structure."""


# ---------------------------------------------------------------------------
# PDF Download & Caching
# ---------------------------------------------------------------------------

def get_cache_path(url: str, cache_dir: Path) -> Path:
    """Return a deterministic cache path for a URL."""
    url_hash = hashlib.md5(url.encode()).hexdigest()
    return cache_dir / f"{url_hash}.pdf"


def download_pdf(url: str, cache_dir: Path = DEFAULT_CACHE_DIR) -> Optional[bytes]:
    """Download a PDF, using local cache if available."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = get_cache_path(url, cache_dir)

    if cache_path.exists():
        logger.debug(f"Cache hit: {url}")
        return cache_path.read_bytes()

    logger.debug(f"Downloading: {url}")
    try:
        with httpx.Client(timeout=60.0, follow_redirects=True) as client:
            response = client.get(url)
            response.raise_for_status()
            pdf_bytes = response.content
            cache_path.write_bytes(pdf_bytes)
            return pdf_bytes
    except Exception as e:
        logger.error(f"Failed to download {url}: {e}")
        return None


# ---------------------------------------------------------------------------
# PDF → Images (first N pages)
# ---------------------------------------------------------------------------

def pdf_to_page_images(pdf_bytes: bytes, max_pages: int = DEFAULT_MAX_PAGES) -> list[dict]:
    """Convert PDF pages to base64 PNG images for Claude vision."""
    images = []
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        n_pages = min(len(doc), max_pages)
        for i in range(n_pages):
            page = doc[i]
            mat = fitz.Matrix(1.5, 1.5)  # 1.5x zoom for readability
            pix = page.get_pixmap(matrix=mat)
            img_bytes = pix.tobytes("png")
            images.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": base64.standard_b64encode(img_bytes).decode("utf-8"),
                },
            })
        doc.close()
    except Exception as e:
        logger.error(f"Failed to render PDF pages: {e}")
    return images


# ---------------------------------------------------------------------------
# Claude API Extraction
# ---------------------------------------------------------------------------

@retry(
    stop=stop_after_attempt(DEFAULT_MAX_RETRIES),
    wait=wait_exponential(multiplier=1, min=2, max=30),
    retry=retry_if_exception_type(Exception),
    reraise=True,
)
def extract_with_claude(
    pdf_bytes: bytes,
    url: str,
    api_key: str,
    model: str = DEFAULT_MODEL,
    max_pages: int = DEFAULT_MAX_PAGES,
) -> dict:
    """Send PDF pages to Claude and extract structured audit data."""
    client = Anthropic(api_key=api_key)

    page_images = pdf_to_page_images(pdf_bytes, max_pages=max_pages)
    if not page_images:
        raise ValueError("No pages could be rendered from PDF")

    content = page_images + [{"type": "text", "text": EXTRACTION_PROMPT}]

    message = client.messages.create(
        model=model,
        max_tokens=4096,
        messages=[{"role": "user", "content": content}],
    )

    raw_text = message.content[0].text.strip()

    # Strip markdown code fences if present
    if raw_text.startswith("```"):
        lines = raw_text.split("\n")
        raw_text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    data = json.loads(raw_text)
    return data


# ---------------------------------------------------------------------------
# Main Extraction Orchestrator
# ---------------------------------------------------------------------------

def extract_audit(
    url: str,
    api_key: str,
    cache_dir: Path = DEFAULT_CACHE_DIR,
    model: str = DEFAULT_MODEL,
    max_pages: int = DEFAULT_MAX_PAGES,
    progress_callback: Optional[Callable[[str], None]] = None,
) -> dict:
    """
    Full pipeline: download PDF → extract data → return result dict.
    Returns a dict with all FIELDS plus source_url and extraction_status.
    """
    result = {field: None for field in FIELDS}
    result["source_url"] = url
    result["extraction_status"] = "error"

    def log(msg: str):
        logger.info(msg)
        if progress_callback:
            progress_callback(msg)

    # 1. Download
    log(f"Downloading PDF: {url}")
    pdf_bytes = download_pdf(url, cache_dir=cache_dir)
    if pdf_bytes is None:
        result["extraction_status"] = "download_failed"
        log(f"ERROR: Download failed for {url}")
        return result

    # 2. Extract
    log(f"Extracting data from {url} ({len(pdf_bytes) // 1024} KB)")
    try:
        extracted = extract_with_claude(
            pdf_bytes=pdf_bytes,
            url=url,
            api_key=api_key,
            model=model,
            max_pages=max_pages,
        )
        # Merge extracted fields into result
        for field in FIELDS:
            if field in extracted:
                result[field] = extracted[field]
        result["extraction_status"] = "success"
        log(f"SUCCESS: {result.get('entity_name', 'Unknown')} extracted from {url}")
    except json.JSONDecodeError as e:
        result["extraction_status"] = "parse_error"
        log(f"ERROR: JSON parse failed for {url}: {e}")
    except Exception as e:
        result["extraction_status"] = f"error: {str(e)[:100]}"
        log(f"ERROR: Extraction failed for {url}: {e}")

    return result


# ---------------------------------------------------------------------------
# Cost Estimation
# ---------------------------------------------------------------------------

# Approximate token cost for claude-sonnet-4-6 (per 1M tokens)
COST_PER_IMAGE_INPUT = 0.0048   # ~4800 tokens per image at $3/1M input
COST_PER_TEXT_OUTPUT = 0.015    # $15/1M output tokens, ~1000 tokens output

def estimate_cost(num_urls: int, max_pages: int = DEFAULT_MAX_PAGES) -> dict:
    """Estimate API cost for processing a batch of PDFs."""
    # Average pages actually rendered (many PDFs have fewer than max_pages)
    avg_pages = min(max_pages, 8)
    cost_per_pdf = (avg_pages * COST_PER_IMAGE_INPUT) + COST_PER_TEXT_OUTPUT
    total = cost_per_pdf * num_urls
    return {
        "num_urls": num_urls,
        "avg_pages_per_pdf": avg_pages,
        "cost_per_pdf_usd": round(cost_per_pdf, 4),
        "estimated_total_usd": round(total, 2),
        "low_estimate_usd": round(total * 0.7, 2),
        "high_estimate_usd": round(total * 1.4, 2),
    }
