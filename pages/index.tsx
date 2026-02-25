import { useState, useRef, useCallback, useEffect } from "react";
import Head from "next/head";

type LogLevel = "info" | "success" | "error" | "warn";
interface LogEntry { ts: string; level: LogLevel; msg: string; }
interface JobStatus {
  jobId: string;
  status: "queued" | "running" | "complete" | "error";
  processed: number;
  total: number;
  downloadUrl?: string;
}

function LogLine({ entry }: { entry: LogEntry }) {
  const color: Record<LogLevel, string> = {
    info: "log-info", success: "log-success", error: "log-error", warn: "log-warn",
  };
  return (
    <div className={color[entry.level]}>
      <span className="text-slate-500 select-none">[{entry.ts}] </span>{entry.msg}
    </div>
  );
}

// Count http/https URLs in a block of text
function countUrls(text: string): number {
  return (text.match(/https?:\/\/\S+/g) ?? []).length;
}

type InputMode = "paste" | "csv";

export default function Home() {
  const [mode, setMode] = useState<InputMode>("paste");
  const [pastedText, setPastedText] = useState("");
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [urlCount, setUrlCount] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const logEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);
  useEffect(() => () => { eventSourceRef.current?.close(); }, []);

  function addLog(msg: string, level: LogLevel = "info") {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLogs((p) => [...p, { ts, level, msg }]);
  }

  // Update URL count whenever pasted text changes
  useEffect(() => {
    if (mode === "paste") setUrlCount(countUrls(pastedText));
  }, [pastedText, mode]);

  // ---- CSV file handling ----
  const handleFileSelect = useCallback(async (f: File) => {
    if (!f.name.endsWith(".csv")) { addLog("Please upload a .csv file.", "error"); return; }
    setCsvFile(f);
    setJobStatus(null);
    setLogs([]);
    const text = await f.text();
    const count = (text.match(/https?:\/\/\S+/g) ?? []).length;
    setUrlCount(count);
    addLog(`Loaded: ${f.name} — ${count} URLs found`, "success");
  }, []);

  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFileSelect(f);
  }

  // ---- Run extraction ----
  async function handleRun() {
    const hasPaste = mode === "paste" && pastedText.trim().length > 0;
    const hasCsv = mode === "csv" && csvFile !== null;
    if (!hasPaste && !hasCsv) { addLog("Nothing to process — paste URLs or upload a CSV.", "error"); return; }

    setIsUploading(true);
    setJobStatus(null);
    setLogs([]);
    addLog("Starting extraction...", "info");

    const formData = new FormData();
    formData.append("maxPages", "15");
    if (hasPaste) {
      formData.append("pastedUrls", pastedText);
    } else if (csvFile) {
      formData.append("csv", csvFile);
    }

    let jobId: string;
    let total: number;
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
      total = data.total;
      addLog(`Job started — ${total} URL${total !== 1 ? "s" : ""} queued`, "success");
      setJobStatus({ jobId, status: "running", processed: 0, total });
    } catch (err) {
      addLog(`Request failed: ${err}`, "error");
      setIsUploading(false);
      return;
    }
    setIsUploading(false);

    // SSE live progress
    const es = new EventSource(`/api/progress?jobId=${jobId}`);
    eventSourceRef.current = es;
    es.onmessage = (event) => {
      try {
        const p = JSON.parse(event.data);
        if (p.type === "log") {
          const lv: LogLevel = p.level === "success" ? "success" : p.level === "error" ? "error" : p.level === "warn" ? "warn" : "info";
          addLog(p.msg, lv);
        } else if (p.type === "progress") {
          setJobStatus((prev) => prev ? { ...prev, processed: p.processed, total: p.total } : null);
        } else if (p.type === "complete") {
          addLog(`Done — ${p.processed} entities extracted.`, "success");
          setJobStatus((prev) => prev ? { ...prev, status: "complete", processed: p.processed, downloadUrl: p.downloadUrl } : null);
          es.close();
        } else if (p.type === "error") {
          addLog(`Error: ${p.msg}`, "error");
          setJobStatus((prev) => prev ? { ...prev, status: "error" } : null);
          es.close();
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => { addLog("Progress stream disconnected.", "warn"); es.close(); };
  }

  const isRunning = jobStatus?.status === "running";
  const isComplete = jobStatus?.status === "complete";
  const pct = jobStatus && jobStatus.total > 0 ? Math.round((jobStatus.processed / jobStatus.total) * 100) : 0;
  const canRun = !isUploading && !isRunning && (
    (mode === "paste" && urlCount > 0) ||
    (mode === "csv" && csvFile !== null)
  );

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
            <div className="w-10 h-10 rounded-lg bg-navy-600 flex items-center justify-center text-white font-bold text-lg">NE</div>
            <div>
              <h1 className="text-xl font-semibold text-white">Nebraska APA Audit Extractor</h1>
              <p className="text-sm text-slate-400">Extract financial data from Nebraska Auditor of Public Accounts reports</p>
            </div>
          </div>
        </header>

        <main className="max-w-4xl mx-auto px-6 py-10 space-y-6">

          {/* Mode tabs */}
          <div className="flex gap-1 bg-slate-900 border border-slate-800 rounded-lg p-1 w-fit">
            {(["paste", "csv"] as InputMode[]).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setJobStatus(null); setLogs([]); setUrlCount(0); }}
                className={`px-5 py-2 rounded-md text-sm font-medium transition-colors ${
                  mode === m ? "bg-navy-600 text-white" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {m === "paste" ? "Paste URLs" : "Upload CSV"}
              </button>
            ))}
          </div>

          {/* Paste mode */}
          {mode === "paste" && (
            <section className="bg-dark-900 rounded-xl border border-slate-800 p-6 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-semibold text-slate-300">Paste PDF URLs</label>
                {urlCount > 0 && (
                  <span className="text-xs text-navy-300 bg-navy-900/60 px-2.5 py-1 rounded-full">
                    {urlCount.toLocaleString()} URL{urlCount !== 1 ? "s" : ""} detected
                  </span>
                )}
              </div>
              <textarea
                className="w-full h-56 bg-slate-950 border border-slate-700 rounded-lg p-4 text-sm text-slate-200 font-mono placeholder-slate-600 focus:outline-none focus:border-navy-500 resize-y"
                placeholder={"Paste URLs here — one per line, or copy directly from a spreadsheet/CSV.\n\nhttps://auditors.nebraska.gov/.../report1.pdf\nhttps://auditors.nebraska.gov/.../report2.pdf"}
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                spellCheck={false}
              />
              <p className="text-xs text-slate-600">
                Accepts any format — raw URLs, CSV rows, spreadsheet pastes. URLs are detected automatically.
              </p>
            </section>
          )}

          {/* CSV upload mode */}
          {mode === "csv" && (
            <section className="bg-dark-900 rounded-xl border border-slate-800 p-6">
              <div
                className={`border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors ${
                  dragOver ? "border-navy-400 bg-navy-950/30" :
                  csvFile ? "border-green-600 bg-green-950/20" :
                  "border-slate-700 hover:border-slate-500"
                }`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <input ref={fileInputRef} type="file" accept=".csv" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileSelect(f); }} />
                {csvFile ? (
                  <div>
                    <div className="text-3xl mb-2">📄</div>
                    <p className="text-green-400 font-medium">{csvFile.name}</p>
                    <p className="text-slate-400 text-sm mt-1">{urlCount.toLocaleString()} URLs detected</p>
                    <p className="text-slate-600 text-xs mt-2">Click or drag to replace</p>
                  </div>
                ) : (
                  <div>
                    <div className="text-3xl mb-2">📂</div>
                    <p className="text-slate-300 font-medium">Drag & drop your CSV here</p>
                    <p className="text-slate-500 text-sm mt-1">or click to browse</p>
                    <p className="text-slate-600 text-xs mt-3">Any CSV format — headers optional, URLs auto-detected.</p>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Run button */}
          <section className="flex flex-wrap gap-3 items-center">
            <button
              onClick={handleRun}
              disabled={!canRun}
              className={`px-7 py-3 rounded-lg font-semibold text-sm transition-all ${
                canRun
                  ? "bg-navy-600 hover:bg-navy-500 text-white active:scale-95"
                  : "bg-slate-800 text-slate-500 cursor-not-allowed"
              }`}
            >
              {isUploading ? "Uploading..." : isRunning ? "Processing..." : "▶  Run Extraction"}
            </button>

            {isComplete && jobStatus?.downloadUrl && (
              <a
                href={jobStatus.downloadUrl}
                download
                className="px-7 py-3 rounded-lg font-semibold text-sm bg-green-700 hover:bg-green-600 text-white transition-all"
              >
                ⬇  Download Excel
              </a>
            )}

            {urlCount > 0 && !isRunning && !isComplete && (
              <span className="text-slate-500 text-sm">{urlCount.toLocaleString()} URL{urlCount !== 1 ? "s" : ""} ready</span>
            )}
          </section>

          {/* Progress bar */}
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
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="text-right text-xs text-slate-600 mt-1">{pct}%</p>
            </section>
          )}

          {/* Live log */}
          {logs.length > 0 && (
            <section className="bg-dark-900 rounded-xl border border-slate-800 p-6">
              <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">Log</h2>
              <div className="log-terminal bg-slate-950 rounded-lg p-4 h-72 overflow-y-auto border border-slate-800">
                {logs.map((e, i) => <LogLine key={i} entry={e} />)}
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
