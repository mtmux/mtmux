import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@repo/ui", "@repo/protocol"],
  serverExternalPackages: ["pino", "pino-pretty"],
};

export default nextConfig;
