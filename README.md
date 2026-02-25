# Nebraska APA Audit Data Extractor

Extract structured financial data from Nebraska Auditor of Public Accounts (APA) audit reports at scale using the Anthropic Claude AI API.

---

## What It Does

- Reads a CSV file of PDF URLs from the Nebraska APA website
- Downloads each audit report (with local caching to avoid re-downloads)
- Sends the first 15 pages of each PDF to Claude's vision API for extraction
- Outputs a **formatted Excel file** with one row per entity and a Summary sheet
- Logs every URL, entity name, status, and timestamp to `processing_log.csv`
- Includes a **Next.js web frontend** for smaller batches with live progress streaming

### Fields Extracted

| Category | Fields |
|---|---|
| Identity | Entity name, entity type, fiscal year end, audit date, auditor name |
| Opinion | Audit opinion (Unmodified/Modified/Adverse/Disclaimer) |
| Findings | Number of findings, material weakness, significant deficiency |
| Balance Sheet | Total assets, fund balance (begin/end), cash & investments |
| Revenue | Total receipts, tax revenue, property tax, intergovernmental, charges for services, investment income, misc |
| Disbursements | Total, general govt, public safety, public works, education, debt service, capital outlay |
| Debt/Funds | Total long-term debt, general fund balance, road/bridge fund balance |

---

## Project Structure

```
/
├── README.md
├── .gitignore
├── .env.example
├── requirements.txt
├── extract_audits.py          ← Standalone CLI script (recommended for large batches)
├── next.config.js
├── package.json
├── tailwind.config.js
├── tsconfig.json
├── postcss.config.js
├── styles/
│   └── globals.css
├── pages/
│   ├── _app.tsx
│   ├── index.tsx              ← Web UI
│   └── api/
│       ├── estimate.ts        ← Cost estimator endpoint
│       ├── extract.ts         ← Job launcher endpoint
│       ├── progress.ts        ← SSE live progress stream
│       └── download.ts        ← Excel file download
└── lib/
    ├── __init__.py
    └── extractor.py           ← Core Python extraction logic
```

---

## Setup

### Prerequisites

- Python 3.11+
- Node.js 18+ (for the web frontend)
- An Anthropic API key

### Get an Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Sign up or log in
3. Navigate to **API Keys** → **Create Key**
4. Copy the key (starts with `sk-ant-...`)

### Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` and set your API key:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

---

## Running Locally (Python CLI)

Best for large batches (100+ PDFs). No timeout limitations.

### Install Python dependencies

```bash
pip install -r requirements.txt
```

### Prepare your URL CSV

Create a CSV file with a column named `url`:

```csv
url
https://auditors.nebraska.gov/sites/auditors.nebraska.gov/files/doc/audits/2024/report1.pdf
https://auditors.nebraska.gov/sites/auditors.nebraska.gov/files/doc/audits/2024/report2.pdf
```

### Run extraction

```bash
# Basic run
python extract_audits.py urls.csv

# With options
python extract_audits.py urls.csv \
  --output my_results.xlsx \
  --max-pages 15 \
  --workers 3 \
  --cache-dir ./pdf_cache

# Test with first 10 URLs only
python extract_audits.py urls.csv --limit 10

# Cost estimate only (no processing)
python extract_audits.py urls.csv --estimate-only
```

### CLI Options

| Flag | Default | Description |
|---|---|---|
| `--output` | `audit_results_TIMESTAMP.xlsx` | Output Excel filename |
| `--cache-dir` | `./pdf_cache` | PDF cache directory |
| `--max-pages` | `15` | Max pages per PDF to send to API |
| `--workers` | `1` | Parallel workers (careful with rate limits) |
| `--limit` | *(none)* | Process only first N URLs |
| `--model` | `claude-sonnet-4-6` | Claude model to use |
| `--estimate-only` | `false` | Print cost estimate and exit |

### Output Files

- **`audit_results_YYYYMMDD_HHMMSS.xlsx`** — Main data with formatted columns and Summary sheet
- **`processing_log.csv`** — URL, entity name, status, timestamp for every processed PDF

---

## Running the Web Frontend (Next.js)

Best for small batches (≤25 PDFs) and demos. Limited to ~55 seconds of processing per session due to Vercel's serverless timeout.

### Install Node dependencies

```bash
npm install
```

### Run development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Using the UI

1. Upload your CSV file (drag & drop or click to browse)
2. Review the cost estimate shown on screen
3. Click **Run Extraction**
4. Watch the live log stream as each PDF is processed
5. Click **Download Excel** when complete

---

## Deploying to Vercel

### 1. Push to GitHub

```bash
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 2. Import to Vercel

1. Go to [vercel.com](https://vercel.com) and click **New Project**
2. Import your GitHub repository
3. Vercel will auto-detect Next.js — keep default settings

### 3. Set Environment Variables

In your Vercel project dashboard → **Settings** → **Environment Variables**:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-your-key-here` |

### 4. Deploy

Click **Deploy**. Your app will be live at `https://your-project.vercel.app`.

### Vercel Timeout Limitations

Vercel serverless functions are capped at **60 seconds** (Pro plan) or **10 seconds** (Hobby). Processing 2,250 PDFs takes hours. The web UI is best for:
- Testing with small batches (1–25 PDFs)
- Demos and showcasing the tool

**For production batch processing of 100+ PDFs, use `extract_audits.py` locally or on a VPS.**

---

## Estimated API Costs

Using `claude-sonnet-4-6` (as of 2025):

| Batch Size | Low Estimate | High Estimate |
|---|---|---|
| 10 PDFs | ~$0.40 | ~$0.80 |
| 100 PDFs | ~$4.00 | ~$8.00 |
| 500 PDFs | ~$20 | ~$40 |
| 2,250 PDFs | ~$90 | ~$180 |

Costs vary based on actual page counts and content density. Use `--estimate-only` flag to get an estimate before running.

---

## PDF Caching

Downloaded PDFs are cached in `./pdf_cache/` (or `--cache-dir`). On reruns:
- Already-cached PDFs are read from disk (no re-download)
- Only new or failed PDFs are fetched

The cache directory is excluded from git via `.gitignore`.

---

## Troubleshooting

**`ANTHROPIC_API_KEY is not set`**
→ Ensure your `.env` file exists and has the correct key.

**`CSV must have a column named 'url'`**
→ Check that your CSV header row contains `url` (lowercase).

**PDF download failures**
→ Check that URLs are publicly accessible. Nebraska APA PDFs may require specific User-Agent headers.

**Rate limit errors**
→ Use `--workers 1` (default) and add delays between requests if needed.

**Empty fields in output**
→ Normal — many audit documents don't include all field types. The tool extracts what's present.

---

## Architecture Notes

- **PDF rendering**: PyMuPDF (fitz) converts PDF pages to PNG images at 1.5x zoom
- **AI extraction**: Claude processes page images via vision API with a structured JSON prompt
- **Retry logic**: Tenacity library retries failed extractions up to 3 times with exponential backoff
- **Caching**: MD5 hash of URL used as cache filename to avoid collisions
- **Excel output**: openpyxl with Arial font, currency formatting, dark navy header row, frozen top row
