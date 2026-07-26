import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Next's dev-tools overlay anchors to the bottom of the viewport, which on a
  // phone lands squarely on our bottom nav and swallows taps on the Terminal
  // tab — the app is unusable on mobile in dev. Dev-only surface, so turning it
  // off costs nothing and makes `pnpm dev` honest about the mobile layout.
  devIndicators: false,
  transpilePackages: ["@repo/ui", "@repo/protocol", "@repo/crypto"],
  serverExternalPackages: ["pino", "pino-pretty"],
  // Monaco's codicon.ttf used to need an explicit webpack `asset/resource`
  // rule. Turbopack — the default bundler since Next 16 — already emits
  // unknown file types as static assets, so the rule is gone. Keeping a
  // `webpack` key here would additionally make `next build` fail outright
  // under Turbopack.
};

export default nextConfig;
