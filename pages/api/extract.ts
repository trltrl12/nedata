/**
 * POST /api/extract
 * Accepts a multipart form upload with a CSV file of PDF URLs.
 * Spawns a background extraction job and returns a jobId immediately.
 *
 * NOTE: Vercel serverless functions have a 60-second timeout (Pro plan).
 * For large batches, run extract_audits.py locally or on a VPS.
 * The job runs synchronously in the function for small batches (≤25 PDFs)
 * and streams progress via SSE through /api/progress.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { IncomingForm, Fields, Files, File as FormidableFile } from "formidable";
import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { extractAudit, generateExcel, DEFAULT_MODEL, SONNET_MODEL } from "../../lib/extractor";

const ALLOWED_MODELS = new Set([DEFAULT_MODEL, SONNET_MODEL]);

export const config = {
  api: {
    bodyParser: false, // Required for multipart/form-data
  },
};

// In-memory job store (resets on cold start — suitable for demo/small batches)
export interface Job {
  id: string;
  status: "queued" | "running" | "complete" | "error";
  urls: string[];
  processed: number;
  logs: Array<{ ts: string; level: string; msg: string }>;
  downloadPath?: string;
  error?: string;
  createdAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __jobs: Map<string, Job> | undefined;
}

if (!global.__jobs) {
  global.__jobs = new Map<string, Job>();
}

export const jobs = global.__jobs;

// ---------------------------------------------------------------------------
// Parse CSV text → array of URLs
// Works with any CSV format: horizontal (one URL per row), vertical/transposed
// (label in col A, value in col B, URL somewhere in the block), no header,
// any column name, BOM characters, CRLF line endings, quoted values.
// ---------------------------------------------------------------------------
function parseUrls(csvText: string): string[] {
  const isUrl = (s: string) => s.startsWith("http://") || s.startsWith("https://");

  // Strip UTF-8 BOM and normalise line endings
  const text = csvText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  // Split a CSV line respecting double-quoted fields (handles commas inside quotes)
  function splitLine(line: string): string[] {
    const cols: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === "," && !inQuote) { cols.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    cols.push(cur.trim());
    return cols;
  }

  // Brute-force: scan every cell in the entire file for a URL.
  // This handles vertical/transposed formats (like the NE APA export where
  // "Link to Report if Available" is a row label and the URL is the next cell),
  // horizontal formats, and anything in between.
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const line of lines) {
    for (const cell of splitLine(line)) {
      if (isUrl(cell) && !seen.has(cell)) {
        seen.add(cell);
        urls.push(cell);
      }
    }
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Background processing (runs inside the serverless function)
// ---------------------------------------------------------------------------
async function runExtractionJob(jobId: string, urls: string[], model: string) {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = "running";

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    job.status = "error";
    job.error = "ANTHROPIC_API_KEY is not set on the server.";
    addJobLog(job, "error", job.error);
    return;
  }

  const tmpDir = os.tmpdir();
  const tmpOutput = path.join(tmpDir, `${jobId}_output.xlsx`);

  addJobLog(job, "info", `Processing ${urls.length} URL(s)...`);

  try {
    const records: Record<string, unknown>[] = [];
    for (const url of urls) {
      const result = await extractAudit(url, apiKey, model, (msg) => {
        addJobLog(job, "info", msg);
      });
      records.push(result);
      job.processed = records.length;
    }

    await generateExcel(records, tmpOutput);

    job.downloadPath = tmpOutput;
    job.status = "complete";
    addJobLog(job, "success", `Extraction complete. ${records.length} entities processed.`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    job.status = "error";
    job.error = msg;
    addJobLog(job, "error", `Extraction failed: ${msg}`);
  }
}

function addJobLog(job: Job, level: string, msg: string) {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  job.logs.push({ ts, level, msg });
}

// ---------------------------------------------------------------------------
// API Handler
// ---------------------------------------------------------------------------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Parse multipart form
  const form = new IncomingForm({ maxFileSize: 10 * 1024 * 1024 }); // 10MB

  let fields: Fields;
  let files: Files;
  try {
    [fields, files] = await new Promise<[Fields, Files]>((resolve, reject) => {
      form.parse(req, (err, f, fi) => {
        if (err) reject(err);
        else resolve([f, fi]);
      });
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(400).json({ error: `Form parse error: ${msg}` });
  }

  // Accept either a pasted text block (field: "pastedUrls") or a CSV file upload (field: "csv")
  const pastedRaw = fields["pastedUrls"];
  const pastedText = (Array.isArray(pastedRaw) ? pastedRaw[0] : pastedRaw) ?? "";

  const csvFileRaw = files["csv"];
  const csvFile = Array.isArray(csvFileRaw) ? csvFileRaw[0] : csvFileRaw;

  let csvText = pastedText as string;
  if (!csvText.trim() && csvFile) {
    const csvPath = (csvFile as FormidableFile).filepath;
    try {
      csvText = fs.readFileSync(csvPath, "utf-8");
    } catch {
      return res.status(400).json({ error: "Could not read uploaded file." });
    }
  }

  if (!csvText.trim()) {
    return res.status(400).json({ error: "No input provided. Paste URLs or upload a CSV file." });
  }

  let urls: string[];
  try {
    urls = parseUrls(csvText);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(400).json({ error: msg });
  }

  if (urls.length === 0) {
    return res.status(400).json({ error: "No valid URLs found. Make sure your URLs start with http:// or https://" });
  }

  const modelRaw = fields["model"];
  const modelStr = (Array.isArray(modelRaw) ? modelRaw[0] : modelRaw) ?? DEFAULT_MODEL;
  const model = ALLOWED_MODELS.has(modelStr as string) ? (modelStr as string) : DEFAULT_MODEL;

  // Create job
  const jobId = randomUUID();
  const job: Job = {
    id: jobId,
    status: "queued",
    urls,
    processed: 0,
    logs: [],
    createdAt: Date.now(),
  };
  jobs.set(jobId, job);

  // Kick off processing (non-blocking — progress tracked via SSE)
  runExtractionJob(jobId, urls, model).catch((err) => {
    const j = jobs.get(jobId);
    if (j) {
      j.status = "error";
      j.error = String(err);
    }
  });

  return res.status(202).json({
    jobId,
    total: urls.length,
    message: "Job started. Connect to /api/progress?jobId=<id> for live updates.",
  });
}
