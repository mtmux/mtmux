import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, env } from "prisma/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  earlyAccess: true,
  schema: path.join(__dirname, "prisma", "schema"),
  datasource: {
    url: process.env.DATABASE_URL ?? "file:./dev.db",
  },
});
