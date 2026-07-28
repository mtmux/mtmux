import { getTranslations } from "next-intl/server";

import { Accent } from "@/components/primitives/section";
import { CopyInstall } from "@/components/site/copy-install";
import { siteConfig } from "@/config/site";
import { Link } from "@/i18n/navigation";

/**
 * The hero.
 *
 * Deliberately typographic: a centred column with no product mockup. The
 * previous device illustration competed with the headline for attention and
 * pushed the install command — the only action on the page — below the fold on
 * short screens. The visual payoff now lands one section down, where the
 * `mtmux` transcript actually demonstrates the claim instead of decorating
 * it.
 */
export async function HomeHero() {
  const t = await getTranslations("home.hero");

  return (
    <header className="relative overflow-hidden">
      {/* Symmetrical wash behind the centred column. */}
      <div
        aria-hidden="true"
        className="glow-brand pointer-events-none absolute -top-40 left-1/2 h-[420px] w-[min(52rem,110%)] -translate-x-1/2"
      />

      <div className="container-content relative flex flex-col items-center pt-(--spacing-section) pb-(--spacing-section) text-center">
        <p className="inline-flex items-center gap-2.5 rounded-full border border-line py-1.5 pe-3 ps-1.5 font-mono text-[0.8125rem] text-text-subtle">
          <span className="rounded-full bg-brand px-1.5 py-0.5 text-[0.71875rem] font-700 text-brand-contrast">
            v{siteConfig.version}
          </span>
          {t("badge")}
          <span aria-hidden="true" className="text-text-faint">
            →
          </span>
        </p>

        <h1 className="mt-7 max-w-[18ch] text-[clamp(2.125rem,6.2vw,4.25rem)] leading-[0.95]">
          {t.rich("title", { accent: (chunks) => <Accent>{chunks}</Accent> })}
        </h1>

        <p className="mt-6 max-w-[54ch] text-[clamp(1.0625rem,1.5vw,1.1875rem)] leading-[1.68] text-text-muted">
          {t("subhead")}
        </p>

        <div className="mt-9 flex flex-col items-center gap-4 sm:flex-row">
          <CopyInstall size="lg" />
          <Link
            href="/docs"
            className="inline-flex items-center gap-1.5 text-[0.9375rem] text-text-muted underline decoration-line-strong underline-offset-4 transition-colors hover:text-brand hover:decoration-brand"
          >
            {t("quickstart")}
          </Link>
        </div>

        <p className="mt-8 flex flex-wrap justify-center gap-x-5 gap-y-2 font-mono text-[0.8125rem] text-text-faint">
          <span>{t("trust.noSsh")}</span>
          <span aria-hidden="true">·</span>
          <span>{t("trust.e2e")}</span>
          <span aria-hidden="true">·</span>
          <span>{t("trust.cellular")}</span>
        </p>
      </div>
    </header>
  );
}
