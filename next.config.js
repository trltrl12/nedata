/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow larger request bodies for CSV uploads
  api: {
    bodyParser: {
      sizeLimit: "10mb",
    },
    responseLimit: "50mb",
  },
  // Vercel environment
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  },
};

module.exports = nextConfig;
