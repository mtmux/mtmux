import { createNavigation } from "next-intl/navigation";

import { routing } from "./routing";

/**
 * Locale-aware replacements for `next/link` and the navigation hooks.
 * Always import `Link` from here, never from `next/link`, so hrefs stay
 * correct in every language.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
