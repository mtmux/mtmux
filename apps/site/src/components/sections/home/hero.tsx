import { getTranslations } from "next-intl/server";

import { Cmd } from "@/components/primitives/cards";
import { Accent } from "@/components/primitives/section";
import { CopyInstall } from "@/components/site/copy-install";
import { siteConfig } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { inlineLink } from "@/lib/rich-links";

/**
 * The hero.
 *
 * Deliberately typographic: a centred column with no product mockup. The
 * previous device illustration competed with the headline for attention and
 * pushed the install command — the only action on the page — below the fold on
 * short screens. The visual payoff now lands one section down, in
 * `sections/home/demo.tsx` — a replay of the real thing running, which
 * demonstrates the claim instead of decorating it.
 *
 * The same constraint governs the type scale. The headline carries the page's
 * primary query ("tmux sessions in any browser"), which is long, so the clamp
 * caps at 3.25rem over 26ch rather than 4.25rem over 18ch — a keyword-bearing
 * h1 that costs the fold would be the illustration regression again, wearing
 * different clothes.
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

        <h1 className="mt-7 max-w-[26ch] text-[clamp(1.875rem,4.6vw,3.25rem)] leading-[1.0]">
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

        {/* The definitional paragraph. It is the passage an answer engine
            quotes when asked "what is mtmux", so it names the product, says
            what it is, and gives the two commands — in that order, in one
            sentence each. It sits *after* the CTA row so `CopyInstall` keeps
            the fold, and the DOM order still puts it well ahead of the demo. */}
        <p className="mt-9 max-w-[62ch] text-[0.9375rem] leading-[1.8] text-text-muted">
          {t.rich("answer", {
            cmd: (chunks) => <Cmd>{chunks}</Cmd>,
            post: inlineLink("/blog/tmux-from-phone"),
          })}
        </p>

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
