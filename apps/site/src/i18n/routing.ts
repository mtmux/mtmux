import { defineRouting } from "next-intl/routing";

import { defaultLocale, localeCodes } from "./locales";

export const routing = defineRouting({
  locales: localeCodes,
  defaultLocale,
  /**
   * The default locale is served unprefixed at `/`, every other locale at
   * `/<code>/…`. This keeps the strongest URLs on the root for the primary
   * market while still giving each language a distinct, canonical address.
   */
  localePrefix: "as-needed",
  localeDetection: false,
});
