/**
 * GET /api/download?jobId=<id>
 * Serves the generated Excel file for download.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";
import { jobs } from "./extract";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const jobId = req.query.jobId as string;
  if (!jobId) return res.status(400).end("Missing jobId");

  const job = jobs.get(jobId);
  if (!job) return res.status(404).end("Job not found");

  if (job.status !== "complete" || !job.downloadPath) {
    return res.status(409).end("Job not complete or no output file available");
  }

  if (!fs.existsSync(job.downloadPath)) {
    return res.status(410).end("Output file no longer available");
  }

  const filename = `nebraska_audit_results_${new Date().toISOString().split("T")[0]}.xlsx`;
  const stat = fs.statSync(job.downloadPath);
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", stat.size);

  const fileStream = fs.createReadStream(job.downloadPath);
  fileStream.pipe(res);
}
