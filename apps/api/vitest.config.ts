import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // @repo/* workspace packages ship raw TypeScript, so they have to be
    // transformed rather than externalised to node.
    server: { deps: { inline: [/@repo\//] } },
  },
});
