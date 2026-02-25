import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  const keySet = key.length > 0;
  // Safely show only enough to confirm the key looks right (first 7 chars, e.g. "sk-ant-")
  const keyHint = keySet ? key.slice(0, 7) + "*".repeat(8) : null;

  res.status(200).json({
    ok: true,
    anthropicKeySet: keySet,
    anthropicKeyHint: keyHint,
    keyLength: keySet ? key.length : 0,
    nodeVersion: process.version,
    env: process.env.NODE_ENV,
  });
}
