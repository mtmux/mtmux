import type { MetadataRoute } from "next";

const BASE_URL = "https://ccremote.dev";

const staticPages = [
  "",
  "/docs",
  "/docs/getting-started",
  "/docs/self-hosting",
  "/docs/claude-code-remote",
  "/docs/architecture",
  "/docs/configuration",
  "/docs/security",
  "/docs/deployment",
  "/docs/troubleshooting",
  "/docs/web-app",
  "/docs/web-app/terminal",
  "/docs/web-app/sessions",
  "/docs/web-app/files",
  "/docs/web-app/mobile",
  "/docs/relay",
  "/docs/relay/protocol",
];

export default function sitemap(): MetadataRoute.Sitemap {
  return staticPages.map((path) => ({
    url: `${BASE_URL}${path}`,
    lastModified: new Date(),
    changeFrequency: path === "" ? "weekly" : "monthly",
    priority: path === "" ? 1 : path === "/docs/getting-started" ? 0.9 : 0.7,
  }));
}
