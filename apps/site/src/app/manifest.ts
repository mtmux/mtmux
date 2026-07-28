import type { MetadataRoute } from "next";

import { siteConfig } from "@/config/site";

/**
 * PWA manifest. Colours are the dark-scheme `--surface-base` / `--brand`
 * hex equivalents baked into `src/app/[locale]/layout.tsx`'s `viewport.themeColor`
 * — mtmux ships dark-first, so the manifest matches that, not the light scheme.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: `${siteConfig.name} — live tmux in your browser`,
    short_name: siteConfig.name,
    description: `${siteConfig.legalName} serves the tmux sessions you already run to any browser, end-to-end encrypted, with nothing to port-forward.`,
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#0a0b0a",
    theme_color: "#0a0b0a",
    icons: [
      {
        src: "/favicon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
