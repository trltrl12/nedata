/**
 * GET /api/progress?jobId=<id>
 * Server-Sent Events endpoint for live extraction progress.
 * Streams log messages and progress updates until the job completes.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";
import os from "os";
import { jobs } from "./extract";

export const config = {
  api: {
    bodyParser: false,
  },
};

function send(res: NextApiResponse, data: object) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).end("Method not allowed");
  }

  const jobId = req.query.jobId as string;
  if (!jobId) {
    return res.status(400).end("Missing jobId");
  }

  const job = jobs.get(jobId);
  if (!job) {
    return res.status(404).end("Job not found");
  }

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable Nginx buffering
  res.flushHeaders();

  let lastLogIdx = 0;
  let pollCount = 0;
  const maxPolls = 6000; // ~600 seconds / 10 minutes at 100ms intervals

  const interval = setInterval(() => {
    pollCount++;
    const currentJob = jobs.get(jobId);

    if (!currentJob) {
      send(res, { type: "error", msg: "Job not found" });
      clearInterval(interval);
      res.end();
      return;
    }

    // Send any new log entries
    const newLogs = currentJob.logs.slice(lastLogIdx);
    lastLogIdx = currentJob.logs.length;
    for (const logEntry of newLogs) {
      send(res, { type: "log", level: logEntry.level, msg: logEntry.msg });
    }

    // Send progress update
    send(res, {
      type: "progress",
      processed: currentJob.processed,
      total: currentJob.urls.length,
      status: currentJob.status,
    });

    // Check terminal states
    if (currentJob.status === "complete") {
      let downloadUrl: string | undefined;

      // Serve the file via a download endpoint if available
      if (currentJob.downloadPath && fs.existsSync(currentJob.downloadPath)) {
        downloadUrl = `/api/download?jobId=${jobId}`;
      }

      send(res, {
        type: "complete",
        processed: currentJob.urls.length,
        downloadUrl,
      });
      clearInterval(interval);
      res.end();
      return;
    }

    if (currentJob.status === "error") {
      send(res, { type: "error", msg: currentJob.error || "Unknown error" });
      clearInterval(interval);
      res.end();
      return;
    }

    // Timeout safety valve
    if (pollCount >= maxPolls) {
      send(res, {
        type: "error",
        msg: "Progress stream timed out. The job may still be running — check back later.",
      });
      clearInterval(interval);
      res.end();
    }
  }, 100);

  // Clean up if client disconnects
  req.on("close", () => {
    clearInterval(interval);
  });
}
