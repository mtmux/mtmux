import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Node environment. Everything tested here is pure and DOM-free by design —
// the demo replay engine (written as `frameAt(cast, t)` rather than component
// state for exactly this reason) and the SEO layer: the metadata factory, the
// JSON-LD builders, and the message files themselves.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**"],
    // `lib/seo.ts` reaches `@/i18n/navigation` for `getPathname`, which pulls
    // next-intl's ESM build. Node's own resolver cannot follow its bare
    // `next/navigation` import; Vite's can, but only for a dependency it is
    // allowed to process rather than externalise.
    server: { deps: { inline: ["next-intl"] } },
  },
});
