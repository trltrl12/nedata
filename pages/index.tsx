import { useState, useRef, useCallback, useEffect } from "react";
import Head from "next/head";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
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
// LogLine component
// ---------------------------------------------------------------------------
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
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const logEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    return () => { eventSourceRef.current?.close(); };
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
    setJobStatus(null);
    setLogs([]);

    const text = await selectedFile.text();
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const firstLine = lines[0]?.replace(/"/g, "").trim().toLowerCase() ?? "";
    const hasHeader = !firstLine.startsWith("http");
    const count = hasHeader ? lines.length - 1 : lines.length;
    setUrlCount(count);

    addLog(`Loaded: ${selectedFile.name} — ${count} URLs detected`, "success");
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
    if (!file) { addLog("No file selected.", "error"); return; }

    setIsUploading(true);
    setJobStatus(null);
    addLog("Uploading CSV and starting extraction...", "info");

    const formData = new FormData();
    formData.append("csv", file);
    formData.append("maxPages", "15");

    let jobId: string;
    try {
      const res = await fetch("/api/extract", { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.text();
        addLog(`Error: ${err}`, "error");
        setIsUploading(false);
        return;
      }
      const data = await res.json();
      jobId = data.jobId;
      addLog(`Job started (${data.total} URLs)`, "success");
      setJobStatus({ jobId, status: "running", processed: 0, total: data.total });
    } catch (err) {
      addLog(`Upload failed: ${err}`, "error");
      setIsUploading(false);
      return;
    }

    setIsUploading(false);

    // SSE for live progress
    const es = new EventSource(`/api/progress?jobId=${jobId}`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "log") {
          const level: LogLevel =
            payload.level === "success" ? "success" :
            payload.level === "error" ? "error" :
            payload.level === "warn" ? "warn" : "info";
          addLog(payload.msg, level);
        } else if (payload.type === "progress") {
          setJobStatus((prev) =>
            prev ? { ...prev, processed: payload.processed, total: payload.total } : null
          );
        } else if (payload.type === "complete") {
          addLog(`Done — ${payload.processed} entities extracted.`, "success");
          setJobStatus((prev) =>
            prev ? { ...prev, status: "complete", processed: payload.processed, downloadUrl: payload.downloadUrl } : null
          );
          es.close();
        } else if (payload.type === "error") {
          addLog(`Error: ${payload.msg}`, "error");
          setJobStatus((prev) =>
            prev ? { ...prev, status: "error", error: payload.msg } : null
          );
          es.close();
        }
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => {
      addLog("Progress stream disconnected. Job may still be running on server.", "warn");
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
        <meta name="description" content="Extract financial data from Nebraska APA audit PDFs" />
      </Head>

      <div className="min-h-screen bg-dark-950 text-slate-100">
        {/* Header */}
        <header className="border-b border-slate-800 bg-dark-900">
          <div className="max-w-4xl mx-auto px-6 py-5 flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-navy-600 flex items-center justify-center text-white font-bold text-lg">
              NE
            </div>
            <div>
              <h1 className="text-xl font-semibold text-white">Nebraska APA Audit Extractor</h1>
              <p className="text-sm text-slate-400">
                Extract financial data from Nebraska Auditor of Public Accounts reports
              </p>
            </div>
          </div>
        </header>

        <main className="max-w-4xl mx-auto px-6 py-10 space-y-6">

          {/* Upload */}
          <section className="bg-dark-900 rounded-xl border border-slate-800 p-8">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">
              Upload URL List
            </h2>
            <div
              className={`border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors ${
                dragOver
                  ? "border-navy-400 bg-navy-950/30"
                  : file
                  ? "border-green-600 bg-green-950/20"
                  : "border-slate-700 hover:border-slate-500"
              }`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={onFileInputChange} />
              {file ? (
                <div>
                  <div className="text-3xl mb-2">📄</div>
                  <p className="text-green-400 font-medium">{file.name}</p>
                  <p className="text-slate-400 text-sm mt-1">{urlCount.toLocaleString()} URLs detected</p>
                  <p className="text-slate-600 text-xs mt-2">Click or drag to replace</p>
                </div>
              ) : (
                <div>
                  <div className="text-3xl mb-2">📂</div>
                  <p className="text-slate-300 font-medium">Drag & drop your CSV here</p>
                  <p className="text-slate-500 text-sm mt-1">or click to browse</p>
                  <p className="text-slate-600 text-xs mt-3">
                    Accepts any CSV — with or without headers. Any column containing PDF URLs will be detected automatically.
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* Run */}
          {file && (
            <section className="bg-dark-900 rounded-xl border border-slate-800 p-6">
              <div className="flex flex-wrap gap-3 items-center">
                <button
                  onClick={handleRunExtraction}
                  disabled={isUploading || isRunning}
                  className={`px-6 py-3 rounded-lg font-semibold text-sm transition-all ${
                    isUploading || isRunning
                      ? "bg-slate-700 text-slate-400 cursor-not-allowed"
                      : "bg-navy-600 hover:bg-navy-500 text-white active:scale-95"
                  }`}
                >
                  {isUploading ? "Uploading..." : isRunning ? "Processing..." : "▶  Run Extraction"}
                </button>

                {isComplete && jobStatus?.downloadUrl && (
                  <a
                    href={jobStatus.downloadUrl}
                    download
                    className="px-6 py-3 rounded-lg font-semibold text-sm bg-green-700 hover:bg-green-600 text-white transition-all"
                  >
                    ⬇  Download Excel
                  </a>
                )}

                {file && !isRunning && !isComplete && (
                  <span className="text-slate-500 text-sm">
                    {urlCount.toLocaleString()} PDFs queued
                  </span>
                )}
              </div>
            </section>
          )}

          {/* Progress */}
          {jobStatus && (
            <section className="bg-dark-900 rounded-xl border border-slate-800 p-6">
              <div className="flex justify-between items-center mb-3">
                <span className="text-sm text-slate-300">
                  <span className="text-white font-semibold">{jobStatus.processed}</span>
                  <span className="text-slate-500"> / {jobStatus.total} PDFs</span>
                </span>
                <span className={`text-xs px-2 py-1 rounded font-medium ${
                  isComplete ? "bg-green-900 text-green-300" :
                  jobStatus.status === "error" ? "bg-red-900 text-red-300" :
                  "bg-navy-900 text-navy-300"
                }`}>
                  {isComplete ? "Complete" : jobStatus.status === "error" ? "Error" : "Running"}
                </span>
              </div>
              <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                <div
                  className={`h-2 rounded-full transition-all duration-300 ${isComplete ? "bg-green-500" : "bg-navy-500"}`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <p className="text-right text-xs text-slate-600 mt-1">{progressPct}%</p>
            </section>
          )}

          {/* Live Log */}
          {logs.length > 0 && (
            <section className="bg-dark-900 rounded-xl border border-slate-800 p-6">
              <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">
                Live Log
              </h2>
              <div className="log-terminal bg-slate-950 rounded-lg p-4 h-72 overflow-y-auto border border-slate-800">
                {logs.map((entry, i) => <LogLine key={i} entry={entry} />)}
                <div ref={logEndRef} />
              </div>
            </section>
          )}

        </main>

        <footer className="border-t border-slate-800 mt-16 py-6">
          <div className="max-w-4xl mx-auto px-6 text-center text-xs text-slate-700">
            Nebraska APA Audit Extractor — Powered by Anthropic Claude
          </div>
        </footer>
      </div>
    </>
  );
}
