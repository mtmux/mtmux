import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";

import { JsonLd } from "@/components/json-ld";
import { Cmd, HairlineCell, HairlineGrid } from "@/components/primitives/cards";
import { Eyebrow, Section } from "@/components/primitives/section";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/locales";
import { buildMetadata } from "@/lib/seo";
import { breadcrumbSchema, faqSchema, graph } from "@/lib/structured-data";

type FaqItem = { question: string; answer: string };
type FaqCategory = { label: string; items: FaqItem[] };

const CATEGORY_ORDER = [
  "basics",
  "phone",
  "agents",
  "security",
  "money",
] as const;

/** Internal link destination for the one `<link>` tag each of these categories' copy uses. */
const CATEGORY_LINK_HREF: Partial<
  Record<(typeof CATEGORY_ORDER)[number], string>
> = {
  security: "/security",
  money: "/pricing",
};

const inlineLinkClassName =
  "text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand";

/** Strips the `<cmd>`/`<link>`/`<mailLink>` rich-text tags for JSON-LD, which needs plain text. */
function toPlainText(text: string): string {
  return text
    .replace(/<\/?(cmd|link|mailLink)>/g, "")
    .replace(/'(<[^']+>)'/g, "$1");
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "faq" });

  return buildMetadata({
    locale: locale as Locale,
    path: "/faq",
    title: t("meta.title"),
    description: t("meta.description"),
  });
}

export default async function FaqPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: "faq" });
  const categories = t.raw("categories") as Record<string, FaqCategory>;

  const allQuestions = CATEGORY_ORDER.flatMap((key) =>
    categories[key].items.map((item) => ({
      question: toPlainText(item.question),
      answer: toPlainText(item.answer),
    })),
  );

  const schema = graph(
    faqSchema(allQuestions),
    breadcrumbSchema(locale as Locale, [
      { name: t("breadcrumb.home"), href: "/" },
      { name: t("breadcrumb.current"), href: "/faq" },
    ]),
  );

  return (
    <>
      <JsonLd json={schema} />

      <header className="container-content pt-(--spacing-section) pb-8 sm:pb-10">
        <Eyebrow>{t("hero.eyebrow")}</Eyebrow>
        <h1 className="max-w-[22ch] text-[clamp(1.5625rem,3.56vw,2.5625rem)] leading-[1]">
          {t("hero.title")}
        </h1>
        <p className="mt-4 max-w-[56ch] text-[1.0625rem] leading-[1.72] text-text-muted">
          {t.rich("hero.lead", {
            mailLink: (chunks: ReactNode) => (
              <a href="mailto:hey@mtmux.com" className={inlineLinkClassName}>
                {chunks}
              </a>
            ),
          })}
        </p>
      </header>

      <Section bordered={false} innerClassName="pt-0">
        <nav aria-label={t("jumpNav.label")} className="flex flex-wrap gap-2">
          {CATEGORY_ORDER.map((key) => (
            <a
              key={key}
              href={`#${key}`}
              className="rounded-full border border-line bg-surface-panel px-3.5 py-1.5 font-mono text-[0.8125rem] text-text-muted transition-colors hover:border-line-strong hover:text-text-strong"
            >
              {categories[key].label}
            </a>
          ))}
        </nav>

        <div className="mt-10 grid gap-11 sm:mt-12 sm:gap-14">
          {CATEGORY_ORDER.map((key) => (
            <div key={key} id={key} className="scroll-mt-24">
              <h2 className="mb-4.5 font-mono text-[0.8125rem] font-500 tracking-[0.14em] text-text-faint uppercase">
                {categories[key].label}
              </h2>
              <HairlineGrid minColumnWidth="20rem">
                {categories[key].items.map((item, index) => (
                  <HairlineCell key={item.question}>
                    <h3 className="mb-2 text-[0.9688rem] font-600 text-text-strong">
                      {item.question}
                    </h3>
                    <p className="text-[0.875rem] leading-[1.75] text-text-muted">
                      {t.rich(`categories.${key}.items.${index}.answer`, {
                        cmd: (chunks: ReactNode) => <Cmd>{chunks}</Cmd>,
                        link: (chunks: ReactNode) => (
                          <Link href={CATEGORY_LINK_HREF[key] ?? "/"}>
                            {chunks}
                          </Link>
                        ),
                      })}
                    </p>
                  </HairlineCell>
                ))}
              </HairlineGrid>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
