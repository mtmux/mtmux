import { defineConfig } from "vitest/config";

// Unit tests for the CLI's pure logic (LAN ranking, banner layout, pairing
// codes). The end-to-end coverage lives in scripts/smoke.mjs, which boots the
// real bundle; `pnpm test` runs both.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
