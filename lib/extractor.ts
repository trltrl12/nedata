/**
 * Nebraska APA Audit Data Extractor — TypeScript Core Library
 * Uses Anthropic API's native PDF document support (no Python/PyMuPDF needed).
 * Large PDFs are trimmed with pdf-lib to stay within the 100-page API limit.
 */

import Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdf-lib";
import ExcelJS from "exceljs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = "claude-haiku-4-5-20251001"; // ~4x cheaper than Sonnet
export const SONNET_MODEL  = "claude-sonnet-4-6";

/**
 * Page strategy for large PDFs:
 *   - Take the first FRONT_PAGES (cover → financial statements)
 *   - Take the last  BACK_PAGES  (findings / compliance opinions)
 *   - Total must stay ≤ API_PAGE_LIMIT (Anthropic hard limit)
 *   - Dense GAAP county audits run ~2,100 tokens/page, so 70 pages ≈ 147k tokens,
 *     safely under the 200k context limit with headroom for the prompt.
 */
const MAX_FRONT_PAGES = 50;
const MAX_BACK_PAGES = 20;
const API_PAGE_LIMIT = 100; // Anthropic hard limit (page count)

export const FIELDS = [
  // --- Identity ---
  "entity_name",
  "entity_type",
  "fiscal_year_end",
  "audit_date",
  "auditor_name",

  // --- Audit opinion & compliance ---
  "audit_opinion",
  "number_of_findings",
  "material_weakness",
  "significant_deficiency",

  // --- High-level financial totals ---
  "total_receipts",
  "total_disbursements",
  "net_change_in_fund_balance",
  "total_assets",
  "total_liabilities",
  "cash_and_investments",
  "fund_balance_end_of_year",
  "fund_balance_beginning_of_year",

  // --- Debt totals ---
  "total_long_term_debt",
  "bonds_payable",
  "notes_payable",
  "net_pension_liability",

  // --- Revenue breakdown ---
  "tax_revenue_total",
  "property_tax",
  "sales_tax",
  "motor_vehicle_tax",
  "intergovernmental_revenue",
  "charges_for_services",
  "investment_income",
  "miscellaneous_revenue",

  // --- Expenditure breakdown ---
  "general_govt_disbursements",
  "public_safety_disbursements",
  "public_works_disbursements",
  "health_welfare_disbursements",
  "culture_recreation_disbursements",
  "education_disbursements",
  "debt_service_disbursements",
  "capital_outlay_disbursements",

  // --- Fund balance / reserves ---
  "general_fund_balance",
  "road_bridge_fund_balance",
  "restricted_fund_balance",
  "unassigned_fund_balance",

  // --- Metadata ---
  "source_url",
  "extraction_status",
] as const;

export const COLUMN_HEADERS: Record<string, string> = {
  // Identity
  entity_name: "Entity Name",
  entity_type: "Entity Type",
  fiscal_year_end: "Fiscal Year End",
  audit_date: "Audit Date",
  auditor_name: "Auditor Name",
  // Audit
  audit_opinion: "Audit Opinion",
  number_of_findings: "# Findings",
  material_weakness: "Material Weakness",
  significant_deficiency: "Significant Deficiency",
  // Totals
  total_receipts: "Total Receipts / Revenues",
  total_disbursements: "Total Disbursements / Expenditures",
  net_change_in_fund_balance: "Net Change in Fund Balance",
  total_assets: "Total Assets",
  total_liabilities: "Total Liabilities",
  cash_and_investments: "Cash & Investments",
  fund_balance_end_of_year: "Fund Balance — End of Year",
  fund_balance_beginning_of_year: "Fund Balance — Beginning of Year",
  // Debt
  total_long_term_debt: "Total Long-Term Debt",
  bonds_payable: "Bonds Payable",
  notes_payable: "Notes / Loans Payable",
  net_pension_liability: "Net Pension Liability",
  // Revenue breakdown
  tax_revenue_total: "Tax Revenue — Total",
  property_tax: "Property Tax",
  sales_tax: "Sales / Occupation Tax",
  motor_vehicle_tax: "Motor Vehicle Tax / Fees",
  intergovernmental_revenue: "Intergovernmental Revenue",
  charges_for_services: "Charges for Services",
  investment_income: "Investment Income",
  miscellaneous_revenue: "Miscellaneous Revenue",
  // Expenditure breakdown
  general_govt_disbursements: "General Government",
  public_safety_disbursements: "Public Safety",
  public_works_disbursements: "Public Works / Roads",
  health_welfare_disbursements: "Health & Welfare",
  culture_recreation_disbursements: "Culture & Recreation",
  education_disbursements: "Education",
  debt_service_disbursements: "Debt Service",
  capital_outlay_disbursements: "Capital Outlay",
  // Fund balances / reserves
  general_fund_balance: "General Fund Balance",
  road_bridge_fund_balance: "Road/Bridge Fund Balance",
  restricted_fund_balance: "Restricted Fund Balance",
  unassigned_fund_balance: "Unassigned Fund Balance",
  // Metadata
  source_url: "Source URL",
  extraction_status: "Extraction Status",
};

export const CURRENCY_FIELDS = new Set([
  // Totals
  "total_receipts",
  "total_disbursements",
  "net_change_in_fund_balance",
  "total_assets",
  "total_liabilities",
  "cash_and_investments",
  "fund_balance_end_of_year",
  "fund_balance_beginning_of_year",
  // Debt
  "total_long_term_debt",
  "bonds_payable",
  "notes_payable",
  "net_pension_liability",
  // Revenue
  "tax_revenue_total",
  "property_tax",
  "sales_tax",
  "motor_vehicle_tax",
  "intergovernmental_revenue",
  "charges_for_services",
  "investment_income",
  "miscellaneous_revenue",
  // Expenditure
  "general_govt_disbursements",
  "public_safety_disbursements",
  "public_works_disbursements",
  "health_welfare_disbursements",
  "culture_recreation_disbursements",
  "education_disbursements",
  "debt_service_disbursements",
  "capital_outlay_disbursements",
  // Fund balances
  "general_fund_balance",
  "road_bridge_fund_balance",
  "restricted_fund_balance",
  "unassigned_fund_balance",
]);

// ---------------------------------------------------------------------------
// Extraction Prompt
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are an expert at extracting financial data from Nebraska government audit reports
produced by the Nebraska Auditor of Public Accounts (APA).

ACCOUNTING BASIS — Nebraska APA audits use two main formats:
1. CASH BASIS (smaller entities — villages, small counties, small school districts):
   Financial statements use "Receipts" and "Disbursements."
2. GAAP / ACCRUAL (larger entities — large counties, cities, larger school districts):
   Financial statements use "Revenues" and "Expenditures."
   Large entities also have Government-Wide statements (Statement of Net Position +
   Statement of Activities) in addition to fund-based statements.

KEY EXTRACTION RULES:
- For financial totals, use the ALL FUNDS total, TOTAL GOVERNMENTAL FUNDS column,
  or TOTAL column when multiple funds are shown side by side.
- For GAAP audits: "Revenues" maps to total_receipts; "Expenditures" maps to total_disbursements.
- Numbers in parentheses (123,456) represent negative values — return them as negative numbers.
- Strip all dollar signs ($), commas, and formatting — return raw numbers only.
- Use null for any field not found or not clearly determinable.

SPECIFIC FIELD GUIDANCE:

entity_name: Full legal name from cover page (e.g., "Douglas County, Nebraska").
entity_type: One of — County | School District | Village | City | Fire District | ESU | NRD | Other
fiscal_year_end: The "year ended" date from the cover page or financial statement headers. Format MM/DD/YYYY.
audit_date: The date the Independent Auditor's Report was signed. Format MM/DD/YYYY.
auditor_name: The auditing firm or individual CPA name (often "State of Nebraska Auditor of Public Accounts" or a CPA firm name).
audit_opinion:
  - "Unmodified" — report says "present fairly, in all material respects" with no exception
  - "Modified" — report says "except for" something
  - "Adverse" — report says "do not present fairly"
  - "Disclaimer" — report says "we do not express an opinion" or "unable to obtain sufficient evidence"
number_of_findings: Count findings listed in the Schedule of Findings and Responses section.
  Each numbered finding = 1. Return 0 if the section says "no findings."
material_weakness: true if auditor's report on internal control mentions a "material weakness"; false if
  "no material weaknesses"; null if not discussed.
significant_deficiency: true if report mentions a "significant deficiency"; false if explicitly states
  "no significant deficiencies"; null if not discussed.

HIGH-LEVEL FINANCIAL TOTALS:
total_receipts: "Total Receipts" (cash basis) OR "Total Revenues" (GAAP). Use All Funds / Total Governmental Funds total column.
total_disbursements: "Total Disbursements" (cash basis) OR "Total Expenditures" (GAAP). All Funds total.
net_change_in_fund_balance: "Net Change in Fund Balance(s)" or "Net Change in Cash and Investments." Total all funds.
total_assets: Total assets from the Balance Sheet (GAAP) or Statement of Assets/Cash (cash basis). Total all governmental funds.
total_liabilities: Total liabilities from the Balance Sheet or Statement of Net Position. Include all current and long-term liabilities. Total all governmental funds. For cash basis entities this is usually null.
cash_and_investments: "Cash and Investments" or "Cash and Cash Equivalents" — from Balance Sheet, total.
fund_balance_end_of_year: "Fund Balance, End of Year" or "Fund Balances, [Date]" — Total Governmental Funds ending balance.
fund_balance_beginning_of_year: "Fund Balance, Beginning of Year" — Total Governmental Funds beginning balance.

DEBT:
total_long_term_debt: From Notes to Financial Statements — total long-term debt outstanding at year-end (sum of all bonds, notes, loans, leases).
bonds_payable: General obligation bonds or revenue bonds outstanding at year-end, from the long-term debt schedule or notes. Separate from notes/loans if listed.
notes_payable: Notes payable, loans payable, or installment contracts outstanding at year-end. Null if not separately stated.
net_pension_liability: Net Pension Liability (NPL) disclosed under GASB 68 in the Notes to Financial Statements. Return null for cash basis entities or if not disclosed.

REVENUE BREAKDOWN (from the Statement of Revenues/Receipts — Total Governmental Funds):
tax_revenue_total: Sum of all tax-related revenues. Often labeled "Total Taxes" or "Tax Revenue."
property_tax: "Property Tax," "Real Property Tax," "Ad Valorem Tax," or "Real and Personal Property Taxes."
sales_tax: "Local Option Sales Tax," "Occupation Tax," "Sales and Use Tax," or "General Sales Tax." Return null if not present.
motor_vehicle_tax: "Motor Vehicle Tax," "Motor Vehicle Registration," "Motor Vehicle Fees," or "Vehicle License Fees." Often listed separately under taxes.
intergovernmental_revenue: "Intergovernmental" revenues — state aid, federal grants, CARES, highway allocation, etc.
charges_for_services: "Charges for Services," "Fees and Charges," or "Service Charges."
investment_income: "Investment Income," "Interest Income," "Interest on Investments," or "Interest on Deposits."
miscellaneous_revenue: "Miscellaneous," "Other Revenue," or catch-all revenue not elsewhere classified.

EXPENDITURE / DISBURSEMENT BREAKDOWN (by function — Total Governmental Funds):
general_govt_disbursements: "General Government," "General Administration," or "Legislative / Executive" function total.
public_safety_disbursements: "Public Safety," "Law Enforcement," "Sheriff," "Corrections," or "Emergency Services" total.
public_works_disbursements: "Public Works," "Highways and Streets," "Roads," or "Transportation" function total.
health_welfare_disbursements: "Health," "Public Health," "Human Services," "Welfare," "Social Services," or "County Social Services" function total. Return null if not present as a separate function.
culture_recreation_disbursements: "Culture and Recreation," "Parks and Recreation," "Library," or "Community Activities" function total. Return null if not present.
education_disbursements: "Education," "Instruction," or "Support Services" total (primarily School Districts).
debt_service_disbursements: "Debt Service" function total (principal + interest payments on long-term debt).
capital_outlay_disbursements: "Capital Outlay" function total OR capital outlay line items summed across functions.

FUND BALANCE / RESERVES (from the governmental funds Balance Sheet):
general_fund_balance: Ending fund balance for the General Fund only (not combined with other funds).
road_bridge_fund_balance: Ending fund balance for the Road Fund, County Road Fund, Bridge Fund, or Road and Bridge Fund.
restricted_fund_balance: "Restricted" fund balance component — amounts restricted by external parties, law, or enabling legislation. From the fund balance classification section of the Balance Sheet. For cash basis, look for "Reserved" fund balance.
unassigned_fund_balance: "Unassigned" fund balance — the truly unrestricted, uncommitted, undesignated ending balance available for any purpose. For cash basis, look for "Unreserved" or "Undesignated" balance. Total all governmental funds.

Return ONLY a valid JSON object with no extra text, no markdown, no code fences:
{
  "entity_name": null,
  "entity_type": null,
  "fiscal_year_end": null,
  "audit_date": null,
  "auditor_name": null,
  "audit_opinion": null,
  "number_of_findings": null,
  "material_weakness": null,
  "significant_deficiency": null,
  "total_receipts": null,
  "total_disbursements": null,
  "net_change_in_fund_balance": null,
  "total_assets": null,
  "total_liabilities": null,
  "cash_and_investments": null,
  "fund_balance_end_of_year": null,
  "fund_balance_beginning_of_year": null,
  "total_long_term_debt": null,
  "bonds_payable": null,
  "notes_payable": null,
  "net_pension_liability": null,
  "tax_revenue_total": null,
  "property_tax": null,
  "sales_tax": null,
  "motor_vehicle_tax": null,
  "intergovernmental_revenue": null,
  "charges_for_services": null,
  "investment_income": null,
  "miscellaneous_revenue": null,
  "general_govt_disbursements": null,
  "public_safety_disbursements": null,
  "public_works_disbursements": null,
  "health_welfare_disbursements": null,
  "culture_recreation_disbursements": null,
  "education_disbursements": null,
  "debt_service_disbursements": null,
  "capital_outlay_disbursements": null,
  "general_fund_balance": null,
  "road_bridge_fund_balance": null,
  "restricted_fund_balance": null,
  "unassigned_fund_balance": null
}`;

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
// PDF Page Truncation
// Keeps first MAX_FRONT_PAGES + last MAX_BACK_PAGES, up to API_PAGE_LIMIT total.
// Skips truncation if the PDF is already within limits.
// ---------------------------------------------------------------------------

export async function truncatePdf(
  pdfBuffer: Buffer,
  log: (msg: string) => void = () => {}
): Promise<Buffer> {
  let srcDoc: PDFDocument;
  try {
    srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  } catch {
    // If pdf-lib can't parse it, return the original and let the API try
    log("Warning: pdf-lib could not parse PDF for truncation — sending as-is");
    return pdfBuffer;
  }

  const totalPages = srcDoc.getPageCount();

  if (totalPages <= API_PAGE_LIMIT) {
    log(`PDF has ${totalPages} page(s) — no truncation needed`);
    return pdfBuffer;
  }

  // Front section: pages 0 … MAX_FRONT_PAGES-1
  const frontCount = Math.min(MAX_FRONT_PAGES, totalPages);
  // Back section: starts after front section ends, takes up to MAX_BACK_PAGES
  const backStart = Math.max(frontCount, totalPages - MAX_BACK_PAGES);
  const backCount = totalPages - backStart;

  log(
    `PDF has ${totalPages} pages (limit ${API_PAGE_LIMIT}) — ` +
      `sending pages 1–${frontCount} and ${backStart + 1}–${totalPages} ` +
      `(${frontCount + backCount} pages total)`
  );

  const newDoc = await PDFDocument.create();

  const frontIndices = Array.from({ length: frontCount }, (_, i) => i);
  const frontPages = await newDoc.copyPages(srcDoc, frontIndices);
  frontPages.forEach((p) => newDoc.addPage(p));

  if (backCount > 0) {
    const backIndices = Array.from({ length: backCount }, (_, i) => backStart + i);
    const backPages = await newDoc.copyPages(srcDoc, backIndices);
    backPages.forEach((p) => newDoc.addPage(p));
  }

  const bytes = await newDoc.save();
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// Claude API Extraction (uses native PDF document support)
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

  // Strip markdown code fences if present (model sometimes adds them despite instructions)
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
  const rawBuffer = await downloadPdf(url);
  if (!rawBuffer) {
    result["extraction_status"] = "download_failed";
    log(`ERROR: Download failed for ${url}`);
    return result;
  }

  log(`Downloaded ${Math.round(rawBuffer.length / 1024)} KB — checking page count...`);
  const pdfBuffer = await truncatePdf(rawBuffer, log);

  log(`Sending to Claude for extraction...`);
  try {
    const extracted = await extractWithClaude(pdfBuffer, apiKey, model);
    for (const field of FIELDS) {
      if (field in extracted) result[field] = extracted[field];
    }
    result["extraction_status"] = "success";
    log(`SUCCESS: ${String(result["entity_name"] || "Unknown")} — ${url}`);
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
        const n = parseFloat(String(val));
        return isNaN(n) ? null : n;
      }
      if (field === "number_of_findings" && val != null) {
        const n = parseInt(String(val), 10);
        return isNaN(n) ? null : n;
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
    else if (field === "extraction_status") col.width = 22;
    else if (field === "audit_opinion") col.width = 16;
    else if (CURRENCY_FIELDS.has(field)) col.width = 20;
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
