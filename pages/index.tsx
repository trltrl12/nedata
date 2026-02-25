import { useState, useRef, useCallback, useEffect } from "react";
import Head from "next/head";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface CostEstimate {
  num_urls: number;
  avg_pages_per_pdf: number;
  cost_per_pdf_usd: number;
  estimated_total_usd: number;
  low_estimate_usd: number;
  high_estimate_usd: number;
}

interface JobStatus {
  jobId: string;
  status: "queued" | "running" | "complete" | "error";
  processed: number;
  total: number;
  downloadUrl?: string;
  error?: string;
}

type LogLevel = "info" | "success" | "error" | "warn";

interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatUSD(v: number) {
  return v.toFixed(2);
}

function LogLine({ entry }: { entry: LogEntry }) {
  const colorMap: Record<LogLevel, string> = {
    info: "log-info",
    success: "log-success",
    error: "log-error",
    warn: "log-warn",
  };
  return (
    <div className={colorMap[entry.level]}>
      <span className="text-slate-500 select-none">[{entry.ts}] </span>
      {entry.msg}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------
export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [urlCount, setUrlCount] = useState<number>(0);
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const logEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Auto-scroll log to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  function addLog(msg: string, level: LogLevel = "info") {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLogs((prev) => [...prev, { ts, level, msg }]);
  }

  // ---------------------------------------------------------------------------
  // CSV File Handling
  // ---------------------------------------------------------------------------
  const handleFileSelect = useCallback(async (selectedFile: File) => {
    if (!selectedFile.name.endsWith(".csv")) {
      addLog("Please upload a .csv file.", "error");
      return;
    }
    setFile(selectedFile);
    setEstimate(null);
    setJobStatus(null);
    setLogs([]);

    // Count URLs client-side
    const text = await selectedFile.text();
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    // Find header row
    const headerLine = lines[0]?.toLowerCase() || "";
    const hasHeader = headerLine.includes("url");
    const dataLines = hasHeader ? lines.slice(1) : lines;
    const count = dataLines.filter((l) => l.length > 0).length;
    setUrlCount(count);

    addLog(`CSV loaded: ${selectedFile.name} (${count} URLs)`, "success");

    // Fetch cost estimate from backend
    try {
      const res = await fetch(`/api/estimate?count=${count}&maxPages=15`);
      if (res.ok) {
        const data: CostEstimate = await res.json();
        setEstimate(data);
        addLog(
          `Cost estimate: $${formatUSD(data.low_estimate_usd)} – $${formatUSD(
            data.high_estimate_usd
          )} USD for ${count} PDFs`,
          "info"
        );
      }
    } catch {
      addLog("Could not fetch cost estimate.", "warn");
    }
  }, []);

  function onFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) handleFileSelect(f);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFileSelect(f);
  }

  // ---------------------------------------------------------------------------
  // Run Extraction
  // ---------------------------------------------------------------------------
  async function handleRunExtraction() {
    if (!file) {
      addLog("No file selected.", "error");
      return;
    }

    setIsUploading(true);
    setJobStatus(null);
    addLog("Uploading CSV and starting extraction job...", "info");

    const formData = new FormData();
    formData.append("csv", file);
    formData.append("maxPages", "15");

    let jobId: string;
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const err = await res.text();
        addLog(`Server error: ${err}`, "error");
        setIsUploading(false);
        return;
      }
      const data = await res.json();
      jobId = data.jobId;
      addLog(`Job started: ${jobId}`, "success");
      setJobStatus({
        jobId,
        status: "running",
        processed: 0,
        total: urlCount,
      });
    } catch (err) {
      addLog(`Upload failed: ${err}`, "error");
      setIsUploading(false);
      return;
    }

    setIsUploading(false);

    // Connect SSE for live progress
    const es = new EventSource(`/api/progress?jobId=${jobId}`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "log") {
          const level: LogLevel =
            payload.level === "success"
              ? "success"
              : payload.level === "error"
              ? "error"
              : payload.level === "warn"
              ? "warn"
              : "info";
          addLog(payload.msg, level);
        } else if (payload.type === "progress") {
          setJobStatus((prev) =>
            prev
              ? { ...prev, processed: payload.processed, total: payload.total }
              : null
          );
        } else if (payload.type === "complete") {
          addLog(
            `Extraction complete! ${payload.processed} entities processed.`,
            "success"
          );
          setJobStatus((prev) =>
            prev
              ? {
                  ...prev,
                  status: "complete",
                  processed: payload.processed,
                  downloadUrl: payload.downloadUrl,
                }
              : null
          );
          es.close();
        } else if (payload.type === "error") {
          addLog(`Job error: ${payload.msg}`, "error");
          setJobStatus((prev) =>
            prev ? { ...prev, status: "error", error: payload.msg } : null
          );
          es.close();
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      addLog(
        "Connection to progress stream lost. Job may still be running.",
        "warn"
      );
      es.close();
    };
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const isRunning = jobStatus?.status === "running";
  const isComplete = jobStatus?.status === "complete";
  const progressPct =
    jobStatus && jobStatus.total > 0
      ? Math.round((jobStatus.processed / jobStatus.total) * 100)
      : 0;

  return (
    <>
      <Head>
        <title>Nebraska APA Audit Extractor</title>
        <meta
          name="description"
          content="Extract financial data from Nebraska APA audit PDFs"
        />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <div className="min-h-screen bg-dark-950 text-slate-100">
        {/* ---- Header ---- */}
        <header className="border-b border-slate-800 bg-dark-900">
          <div className="max-w-5xl mx-auto px-6 py-5 flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-navy-600 flex items-center justify-center text-white font-bold text-lg">
              NE
            </div>
            <div>
              <h1 className="text-xl font-semibold text-white">
                Nebraska APA Audit Extractor
              </h1>
              <p className="text-sm text-slate-400">
                Extract financial data from Nebraska Auditor of Public Accounts
                reports
              </p>
            </div>
          </div>
        </header>

        <main className="max-w-5xl mx-auto px-6 py-10 space-y-8">
          {/* ---- Upload Zone ---- */}
          <section className="bg-dark-900 rounded-xl border border-slate-800 p-8">
            <h2 className="text-base font-semibold text-slate-200 mb-1">
              Step 1 — Upload URL List
            </h2>
            <p className="text-sm text-slate-400 mb-5">
              Upload a CSV file with a column named{" "}
              <code className="bg-slate-800 px-1.5 py-0.5 rounded text-navy-300 text-xs">
                url
              </code>{" "}
              containing Nebraska APA audit PDF URLs.
            </p>

            <div
              className={`relative border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors ${
                dragOver
                  ? "border-navy-400 bg-navy-950/30"
                  : file
                  ? "border-green-600 bg-green-950/20"
                  : "border-slate-700 hover:border-slate-500"
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={onFileInputChange}
              />

              {file ? (
                <div>
                  <div className="text-4xl mb-3">📄</div>
                  <p className="text-green-400 font-medium">{file.name}</p>
                  <p className="text-slate-400 text-sm mt-1">
                    {urlCount.toLocaleString()} URLs detected
                  </p>
                  <p className="text-slate-500 text-xs mt-2">
                    Click or drag to replace
                  </p>
                </div>
              ) : (
                <div>
                  <div className="text-4xl mb-3">📂</div>
                  <p className="text-slate-300 font-medium">
                    Drag & drop your CSV file here
                  </p>
                  <p className="text-slate-500 text-sm mt-1">
                    or click to browse
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* ---- Cost Estimate ---- */}
          {estimate && (
            <section className="bg-dark-900 rounded-xl border border-slate-800 p-6">
              <h2 className="text-base font-semibold text-slate-200 mb-4">
                Step 2 — Cost Estimate
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <StatCard
                  label="PDFs to Process"
                  value={estimate.num_urls.toLocaleString()}
                />
                <StatCard
                  label="Avg Pages / PDF"
                  value={estimate.avg_pages_per_pdf.toString()}
                />
                <StatCard
                  label="Cost / PDF"
                  value={`$${estimate.cost_per_pdf_usd.toFixed(4)}`}
                />
                <StatCard
                  label="Est. Total Cost"
                  value={`$${formatUSD(estimate.estimated_total_usd)}`}
                  sub={`$${formatUSD(estimate.low_estimate_usd)} – $${formatUSD(
                    estimate.high_estimate_usd
                  )}`}
                  highlight
                />
              </div>
              <p className="text-xs text-slate-500 mt-3">
                * Estimates based on claude-sonnet-4-6 pricing. Actual costs
                vary by PDF length and content density.
              </p>
            </section>
          )}

          {/* ---- Run Button ---- */}
          {file && (
            <section className="bg-dark-900 rounded-xl border border-slate-800 p-6">
              <h2 className="text-base font-semibold text-slate-200 mb-4">
                Step 3 — Run Extraction
              </h2>

              <div className="flex flex-col sm:flex-row gap-4 items-start">
                <button
                  onClick={handleRunExtraction}
                  disabled={isUploading || isRunning}
                  className={`px-6 py-3 rounded-lg font-semibold text-sm transition-all ${
                    isUploading || isRunning
                      ? "bg-slate-700 text-slate-400 cursor-not-allowed"
                      : "bg-navy-600 hover:bg-navy-500 text-white active:scale-95"
                  }`}
                >
                  {isUploading
                    ? "Uploading..."
                    : isRunning
                    ? "Processing..."
                    : "▶ Run Extraction"}
                </button>

                {isComplete && jobStatus?.downloadUrl && (
                  <a
                    href={jobStatus.downloadUrl}
                    download
                    className="px-6 py-3 rounded-lg font-semibold text-sm bg-green-700 hover:bg-green-600 text-white transition-all"
                  >
                    ⬇ Download Excel
                  </a>
                )}
              </div>

              {/* Vercel timeout notice */}
              <div className="mt-4 p-4 bg-amber-950/40 border border-amber-800/50 rounded-lg">
                <p className="text-amber-300 text-xs font-medium">
                  ⚠ Vercel Timeout Notice
                </p>
                <p className="text-amber-200/70 text-xs mt-1">
                  Vercel serverless functions are limited to 60 seconds. For
                  large batches (100+ PDFs), we recommend running{" "}
                  <code className="bg-slate-800 px-1 rounded">
                    extract_audits.py
                  </code>{" "}
                  locally or on a VPS. The web UI is best for testing small
                  batches (≤25 PDFs).
                </p>
              </div>
            </section>
          )}

          {/* ---- Progress Bar ---- */}
          {jobStatus && (
            <section className="bg-dark-900 rounded-xl border border-slate-800 p-6">
              <div className="flex justify-between items-center mb-3">
                <span className="text-sm font-medium text-slate-300">
                  Progress:{" "}
                  <span className="text-white font-semibold">
                    {jobStatus.processed}
                  </span>{" "}
                  /{" "}
                  <span className="text-slate-400">{jobStatus.total}</span>{" "}
                  PDFs
                </span>
                <span
                  className={`text-xs px-2 py-1 rounded font-medium ${
                    isComplete
                      ? "bg-green-900 text-green-300"
                      : jobStatus.status === "error"
                      ? "bg-red-900 text-red-300"
                      : "bg-navy-900 text-navy-300"
                  }`}
                >
                  {isComplete
                    ? "Complete"
                    : jobStatus.status === "error"
                    ? "Error"
                    : "Running"}
                </span>
              </div>
              <div className="w-full bg-slate-800 rounded-full h-2.5 overflow-hidden">
                <div
                  className={`h-2.5 rounded-full transition-all duration-300 ${
                    isComplete ? "bg-green-500" : "bg-navy-500"
                  }`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <p className="text-right text-xs text-slate-500 mt-1">
                {progressPct}%
              </p>
            </section>
          )}

          {/* ---- Live Log ---- */}
          {logs.length > 0 && (
            <section className="bg-dark-900 rounded-xl border border-slate-800 p-6">
              <h2 className="text-base font-semibold text-slate-200 mb-3">
                Live Log
              </h2>
              <div className="log-terminal bg-slate-950 rounded-lg p-4 h-80 overflow-y-auto border border-slate-800">
                {logs.map((entry, i) => (
                  <LogLine key={i} entry={entry} />
                ))}
                <div ref={logEndRef} />
              </div>
            </section>
          )}

          {/* ---- CSV Format Guide ---- */}
          <section className="bg-dark-900 rounded-xl border border-slate-800 p-6">
            <h2 className="text-base font-semibold text-slate-200 mb-3">
              CSV Format Guide
            </h2>
            <p className="text-sm text-slate-400 mb-3">
              Your CSV must have a column named{" "}
              <code className="bg-slate-800 px-1.5 py-0.5 rounded text-navy-300">
                url
              </code>
              . Other columns are ignored.
            </p>
            <pre className="bg-slate-950 text-green-400 rounded-lg p-4 text-xs overflow-x-auto border border-slate-800">
              {`url\nhttps://auditors.nebraska.gov/sites/auditors.../report1.pdf\nhttps://auditors.nebraska.gov/sites/auditors.../report2.pdf\nhttps://auditors.nebraska.gov/sites/auditors.../report3.pdf`}
            </pre>
          </section>
        </main>

        {/* ---- Footer ---- */}
        <footer className="border-t border-slate-800 mt-16 py-6">
          <div className="max-w-5xl mx-auto px-6 text-center text-xs text-slate-600">
            Nebraska APA Audit Extractor — Powered by{" "}
            <span className="text-slate-500">Anthropic Claude</span>
          </div>
        </footer>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function StatCard({
  label,
  value,
  sub,
  highlight = false,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg p-4 ${
        highlight ? "bg-navy-900/50 border border-navy-700" : "bg-slate-800/50"
      }`}
    >
      <p className="text-xs text-slate-400 mb-1">{label}</p>
      <p
        className={`text-xl font-bold ${
          highlight ? "text-navy-300" : "text-white"
        }`}
      >
        {value}
      </p>
      {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}
