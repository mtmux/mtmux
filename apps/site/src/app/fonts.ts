import { IBM_Plex_Mono, IBM_Plex_Sans, Martian_Mono } from "next/font/google";

/**
 * The three faces, in one module because two documents need them.
 *
 * `[locale]/layout.tsx` renders the site's shell, but `not-found.tsx` sits
 * above `[locale]` — a URL that matches no locale never reaches that layout —
 * so it has to build its own `<html>`. Declaring the fonts twice would mean two
 * copies of the same weights and subsets, free to drift apart.
 */

/* Display face: geometric monospace, used only for headings. */
export const martianMono = Martian_Mono({
  subsets: ["latin"],
  // 300 was declared and never used. `next/font` preloads every declared
  // weight, so it was a woff2 on the critical path of every page for nothing.
  weight: ["400", "500", "600"],
  variable: "--font-martian-mono",
  display: "swap",
});

/* Reading face: prose, UI labels, everything long-form. */
export const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
  display: "swap",
});

/* Terminal face: code, shell output, keycaps. */
export const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

/** The CSS variables the tokens in `globals.css` resolve against, for `<html>`. */
export const fontVariables = `${martianMono.variable} ${plexSans.variable} ${plexMono.variable}`;
