import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@repo/ui", "@repo/protocol"],
  serverExternalPackages: ["pino", "pino-pretty"],
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Monaco editor web workers — required for syntax highlighting,
      // language services, and other editor features to work locally
      // instead of falling back to a degraded no-worker mode.
      config.module?.rules?.push({
        test: /\.ttf$/,
        type: "asset/resource",
      });
    }
    return config;
  },
};

export default nextConfig;
