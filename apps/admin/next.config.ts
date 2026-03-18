import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@repo/ui", "@repo/api", "@repo/auth"],
  serverExternalPackages: ["better-auth", "pino", "pino-pretty"],
};

export default nextConfig;
