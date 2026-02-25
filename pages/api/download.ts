/**
 * GET /api/download?jobId=<id>
 * Serves the generated Excel file for download.
 * Serves from the in-memory buffer stored in the jobs Map — no filesystem
 * dependency, so it works regardless of /tmp timing or path resolution issues.
 * Falls back to the on-disk file if the buffer is unavailable (e.g. after restart).
 */

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";
import os from "os";
import { jobs } from "./extract";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const jobId = req.query.jobId as string;
  if (!jobId) return res.status(400).end("Missing jobId");

  // Validate UUID format to prevent path traversal
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
    return res.status(400).end("Invalid jobId");
  }

  const filename = `nebraska_audit_results_${new Date().toISOString().split("T")[0]}.xlsx`;
  const contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  // Primary: serve from in-memory buffer (fast, no filesystem dependency)
  const job = jobs.get(jobId);
  if (job?.downloadBuffer) {
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", job.downloadBuffer.length);
    res.end(job.downloadBuffer);
    return;
  }

  // Fallback: serve from filesystem (survives if buffer was somehow not set)
  const filePath = job?.downloadPath ?? path.join(os.tmpdir(), `${jobId}_output.xlsx`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).end("File not found — please re-run the extraction.");
  }

  const stat = fs.statSync(filePath);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", stat.size);
  fs.createReadStream(filePath).pipe(res);
}
