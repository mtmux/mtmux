import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@repo/ui"],
  pageExtensions: ["tsx", "ts", "jsx", "js"],
};

const withMDX = createMDX();

export default withMDX(nextConfig);
