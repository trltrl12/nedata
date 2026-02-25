import type { NextApiRequest, NextApiResponse } from "next";

const COST_PER_IMAGE_INPUT = 0.0048;
const COST_PER_TEXT_OUTPUT = 0.015;

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const count = parseInt((req.query.count as string) || "0", 10);
  const maxPages = parseInt((req.query.maxPages as string) || "15", 10);

  if (isNaN(count) || count < 0) {
    return res.status(400).json({ error: "Invalid count" });
  }

  const avg_pages = Math.min(maxPages, 8);
  const cost_per_pdf = avg_pages * COST_PER_IMAGE_INPUT + COST_PER_TEXT_OUTPUT;
  const total = cost_per_pdf * count;

  res.status(200).json({
    num_urls: count,
    avg_pages_per_pdf: avg_pages,
    cost_per_pdf_usd: parseFloat(cost_per_pdf.toFixed(4)),
    estimated_total_usd: parseFloat(total.toFixed(2)),
    low_estimate_usd: parseFloat((total * 0.7).toFixed(2)),
    high_estimate_usd: parseFloat((total * 1.4).toFixed(2)),
  });
}
