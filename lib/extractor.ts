/**
 * Nebraska APA Audit Data Extractor — TypeScript Core Library
 * Replaces extract_audits.py + lib/extractor.py for Vercel deployment.
 * Uses the Anthropic API's native PDF document support (no Python/PyMuPDF needed).
 */

import Anthropic from "@anthropic-ai/sdk";
import ExcelJS from "exceljs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = "claude-sonnet-4-6";

export const FIELDS = [
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
] as const;

export const COLUMN_HEADERS: Record<string, string> = {
  entity_name: "Entity Name",
  entity_type: "Entity Type",
  fiscal_year_end: "Fiscal Year End",
  audit_date: "Audit Date",
  auditor_name: "Auditor Name",
  audit_opinion: "Audit Opinion",
  number_of_findings: "Number of Findings",
  material_weakness: "Material Weakness",
  significant_deficiency: "Significant Deficiency",
  total_receipts: "Total Receipts",
  total_disbursements: "Total Disbursements",
  net_change_in_fund_balance: "Net Change in Fund Balance",
  total_assets: "Total Assets",
  fund_balance_end_of_year: "Fund Balance (End of Year)",
  fund_balance_beginning_of_year: "Fund Balance (Beginning of Year)",
  cash_and_investments: "Cash and Investments",
  tax_revenue_total: "Tax Revenue Total",
  property_tax: "Property Tax",
  intergovernmental_revenue: "Intergovernmental Revenue",
  charges_for_services: "Charges for Services",
  investment_income: "Investment Income",
  miscellaneous_revenue: "Miscellaneous Revenue",
  general_govt_disbursements: "General Govt Disbursements",
  public_safety_disbursements: "Public Safety Disbursements",
  public_works_disbursements: "Public Works Disbursements",
  education_disbursements: "Education Disbursements",
  debt_service_disbursements: "Debt Service Disbursements",
  capital_outlay_disbursements: "Capital Outlay Disbursements",
  total_long_term_debt: "Total Long-Term Debt",
  general_fund_balance: "General Fund Balance",
  road_bridge_fund_balance: "Road/Bridge Fund Balance",
  source_url: "Source URL",
  extraction_status: "Extraction Status",
};

export const CURRENCY_FIELDS = new Set([
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
]);

const EXTRACTION_PROMPT = `You are an expert at extracting financial data from Nebraska government audit reports.
Analyze the provided audit report PDF and extract ALL of the following fields.

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

The document follows. Extract carefully — documents vary widely in structure.`;

// ---------------------------------------------------------------------------
// PDF Download
// ---------------------------------------------------------------------------

export async function downloadPdf(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; audit-extractor/1.0)" },
    });
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Claude API Extraction (uses native PDF document support — no image conversion)
// ---------------------------------------------------------------------------

async function extractWithClaude(
  pdfBuffer: Buffer,
  apiKey: string,
  model: string
): Promise<Record<string, unknown>> {
  const client = new Anthropic({ apiKey });
  const base64Pdf = pdfBuffer.toString("base64");

  const message = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: base64Pdf,
            },
          },
          {
            type: "text",
            text: EXTRACTION_PROMPT,
          },
        ] as Parameters<Anthropic["messages"]["create"]>[0]["messages"][0]["content"],
      },
    ],
  });

  let rawText = (message.content[0] as { type: string; text: string }).text.trim();

  // Strip markdown code fences if present
  if (rawText.startsWith("```")) {
    const lines = rawText.split("\n");
    rawText = lines.slice(1, lines[lines.length - 1].trim() === "```" ? -1 : undefined).join("\n");
  }

  return JSON.parse(rawText) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Main Extraction Orchestrator
// ---------------------------------------------------------------------------

export async function extractAudit(
  url: string,
  apiKey: string,
  model: string = DEFAULT_MODEL,
  log: (msg: string) => void = () => {}
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const field of FIELDS) result[field] = null;
  result["source_url"] = url;
  result["extraction_status"] = "error";

  log(`Downloading PDF: ${url}`);
  const pdfBuffer = await downloadPdf(url);
  if (!pdfBuffer) {
    result["extraction_status"] = "download_failed";
    log(`ERROR: Download failed for ${url}`);
    return result;
  }

  log(`Extracting data (${Math.round(pdfBuffer.length / 1024)} KB)...`);
  try {
    const extracted = await extractWithClaude(pdfBuffer, apiKey, model);
    for (const field of FIELDS) {
      if (field in extracted) result[field] = extracted[field];
    }
    result["extraction_status"] = "success";
    log(`SUCCESS: ${String(result["entity_name"] || "Unknown")} extracted`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result["extraction_status"] = `error: ${msg.slice(0, 100)}`;
    log(`ERROR: Extraction failed for ${url}: ${msg}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Excel Generation
// ---------------------------------------------------------------------------

export async function generateExcel(
  records: Record<string, unknown>[],
  outputPath: string
): Promise<void> {
  const workbook = new ExcelJS.Workbook();

  // ---- Main Data Sheet ----
  const ws = workbook.addWorksheet("Audit Data");
  ws.addRow(FIELDS.map((f) => COLUMN_HEADERS[f] ?? f));

  const headerRow = ws.getRow(1);
  headerRow.height = 30;
  headerRow.eachCell((cell) => {
    cell.font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: "FFD0D0D0" } },
      left: { style: "thin", color: { argb: "FFD0D0D0" } },
      bottom: { style: "thin", color: { argb: "FFD0D0D0" } },
      right: { style: "thin", color: { argb: "FFD0D0D0" } },
    };
  });

  ws.views = [{ state: "frozen", ySplit: 1 }];

  for (let rowIdx = 0; rowIdx < records.length; rowIdx++) {
    const record = records[rowIdx];
    const alt = rowIdx % 2 === 0;

    const rowValues: unknown[] = FIELDS.map((field) => {
      let val = record[field];
      if (CURRENCY_FIELDS.has(field) && val != null) {
        return parseFloat(String(val)) || null;
      }
      if (field === "number_of_findings" && val != null) {
        return parseInt(String(val), 10) || null;
      }
      if (field === "material_weakness" || field === "significant_deficiency") {
        if (val === true) return "Yes";
        if (val === false) return "No";
      }
      return val ?? null;
    });

    const excelRow = ws.addRow(rowValues);

    excelRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const field = FIELDS[colNumber - 1];
      cell.font = { name: "Arial", size: 10 };
      cell.border = {
        top: { style: "thin", color: { argb: "FFD0D0D0" } },
        left: { style: "thin", color: { argb: "FFD0D0D0" } },
        bottom: { style: "thin", color: { argb: "FFD0D0D0" } },
        right: { style: "thin", color: { argb: "FFD0D0D0" } },
      };
      cell.alignment = { vertical: "middle" };

      if (alt && field !== "source_url") {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEBF0F7" } };
      }
      if (CURRENCY_FIELDS.has(field) && cell.value != null) {
        cell.numFmt = '_($* #,##0_);_($* (#,##0);_($* "-"_);_(@_)';
      }
      if (
        (field === "material_weakness" || field === "significant_deficiency") &&
        cell.value === "Yes"
      ) {
        cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFC00000" } };
      }
    });
  }

  // Column widths
  FIELDS.forEach((field, idx) => {
    const col = ws.getColumn(idx + 1);
    if (field === "source_url") col.width = 50;
    else if (field === "entity_name") col.width = 35;
    else if (field === "auditor_name") col.width = 30;
    else if (field === "extraction_status") col.width = 20;
    else if (CURRENCY_FIELDS.has(field)) col.width = 18;
    else col.width = 16;
  });

  // ---- Summary Sheet ----
  const ws2 = workbook.addWorksheet("Summary");
  ws2.getColumn(1).width = 35;
  ws2.getColumn(2).width = 20;

  const successes = records.filter((r) => r["extraction_status"] === "success").length;
  const typeCounts: Record<string, number> = {};
  const opinionCounts: Record<string, number> = {};
  let totalFindings = 0;
  let mwCount = 0;
  let sdCount = 0;

  for (const r of records) {
    const et = String(r["entity_type"] || "Unknown");
    typeCounts[et] = (typeCounts[et] || 0) + 1;
    const op = String(r["audit_opinion"] || "Unknown");
    opinionCounts[op] = (opinionCounts[op] || 0) + 1;
    if (r["number_of_findings"] != null) totalFindings += Number(r["number_of_findings"]) || 0;
    if (r["material_weakness"] === true || r["material_weakness"] === "Yes") mwCount++;
    if (r["significant_deficiency"] === true || r["significant_deficiency"] === "Yes") sdCount++;
  }

  const addSectionHeader = (row: number, text: string) => {
    const cell = ws2.getCell(row, 1);
    cell.value = text;
    cell.font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
    cell.alignment = { horizontal: "left", vertical: "middle" };
    ws2.getRow(row).height = 22;
    ws2.mergeCells(row, 1, row, 2);
  };

  const addDataRow = (row: number, label: string, value: unknown) => {
    const c1 = ws2.getCell(row, 1);
    const c2 = ws2.getCell(row, 2);
    c1.value = label;
    c2.value = value as ExcelJS.CellValue;
    c1.font = { name: "Arial", size: 10 };
    c2.font = { name: "Arial", size: 10, bold: true };
    c2.alignment = { horizontal: "right" };
  };

  let row = 1;
  addSectionHeader(row++, "Processing Summary");
  addDataRow(row++, "Total Entities Processed", records.length);
  addDataRow(row++, "Successful Extractions", successes);
  addDataRow(row++, "Failed Extractions", records.length - successes);
  addDataRow(row++, "Generated On", new Date().toISOString().replace("T", " ").slice(0, 19));

  row++;
  addSectionHeader(row++, "Breakdown by Entity Type");
  for (const [et, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    addDataRow(row++, et, count);
  }

  row++;
  addSectionHeader(row++, "Breakdown by Audit Opinion");
  for (const [op, count] of Object.entries(opinionCounts).sort((a, b) => b[1] - a[1])) {
    addDataRow(row++, op, count);
  }

  row++;
  addSectionHeader(row++, "Findings Summary");
  addDataRow(row++, "Total Number of Findings", totalFindings);
  addDataRow(row++, "Entities with Material Weakness", mwCount);
  addDataRow(row++, "Entities with Significant Deficiency", sdCount);

  await workbook.xlsx.writeFile(outputPath);
}
