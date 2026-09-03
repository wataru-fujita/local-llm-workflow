import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @lancedb/lancedb is a native Node addon (.node binary); keep Next from
  // bundling it into route handlers and let it load via require() at runtime.
  serverExternalPackages: ["@lancedb/lancedb"],
};

export default nextConfig;
