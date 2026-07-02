import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  // Pin the file-tracing root to this project so the standalone build emits
  // server.js at the standalone root (a parent lockfile would otherwise nest
  // it under .next/standalone/nightscout/clearsugar and break the deploy).
  outputFileTracingRoot: path.join(process.cwd()),
};

export default nextConfig;
