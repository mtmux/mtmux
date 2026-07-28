import type { ReactNode } from "react";

/**
 * Pass-through root layout.
 *
 * The real document shell (<html>, <body>, fonts, providers) lives in
 * `[locale]/layout.tsx`, because the `lang` and `dir` attributes depend on the
 * active locale. Next requires a root layout to exist, so this one simply
 * forwards its children.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
