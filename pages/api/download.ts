/**
 * GET /api/download?jobId=<id>
 * Serves the generated Excel file for download.
 * Derives the file path from jobId directly so the endpoint survives
 * server hot-reloads that clear the in-memory jobs Map.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";
import os from "os";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const jobId = req.query.jobId as string;
  if (!jobId) return res.status(400).end("Missing jobId");

  // Validate UUID format to prevent path traversal
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
    return res.status(400).end("Invalid jobId");
  }

  const filePath = path.join(os.tmpdir(), `${jobId}_output.xlsx`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).end("File not found — the server may have restarted. Please re-run the extraction.");
  }

  const filename = `nebraska_audit_results_${new Date().toISOString().split("T")[0]}.xlsx`;
  const stat = fs.statSync(filePath);
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", stat.size);

  const fileStream = fs.createReadStream(filePath);
  fileStream.pipe(res);
}
