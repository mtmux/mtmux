import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Next's dev-tools overlay anchors to the bottom of the viewport, which on a
  // phone lands squarely on our bottom nav and swallows taps on the Terminal
  // tab — the app is unusable on mobile in dev. Dev-only surface, so turning it
  // off costs nothing and makes `pnpm dev` honest about the mobile layout.
  devIndicators: false,
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
