import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Node environment on purpose — these tests cover pure logic (the attach state
// machine) and the WebSocket client with a stubbed global, neither of which
// needs a DOM. Keeping jsdom out keeps the suite fast and dependency-light.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // @repo/* workspace packages are published as raw TypeScript
    // (`"exports": "./src/index.ts"`), so they must be transformed rather than
    // externalised to node.
    server: {
      deps: {
        inline: [/@repo\//],
      },
    },
  },
});
