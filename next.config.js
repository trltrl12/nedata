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
};

module.exports = nextConfig;
