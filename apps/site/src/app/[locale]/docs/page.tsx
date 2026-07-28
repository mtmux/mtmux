import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { JsonLd } from "@/components/json-ld";
import { DOCS_QUICKSTART_COMMANDS } from "@/components/sections/docs/docs-quickstart";
import { DocsCliReference } from "@/components/sections/docs/docs-cli-reference";
import { DocsFooterNote } from "@/components/sections/docs/docs-footer-note";
import { DocsHero } from "@/components/sections/docs/docs-hero";
import { DocsInstall } from "@/components/sections/docs/docs-install";
import { DocsQuickstart } from "@/components/sections/docs/docs-quickstart";
import { DocsSelfHosting } from "@/components/sections/docs/docs-self-hosting";
import { DocsToc } from "@/components/sections/docs/docs-toc";
import { DocsTroubleshooting } from "@/components/sections/docs/docs-troubleshooting";
import type { Locale } from "@/i18n/locales";
import { buildMetadata } from "@/lib/seo";
import { breadcrumbSchema, graph, howToSchema } from "@/lib/structured-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "docs" });

  return buildMetadata({
    locale: locale as Locale,
    path: "/docs",
    title: t("meta.title"),
    description: t("meta.description"),
  });
}

export default async function DocsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: "docs" });
  const steps = t.raw("quickstart.steps") as Array<{
    label: string;
    comment: string;
  }>;

  const schema = graph(
    breadcrumbSchema(locale as Locale, [
      { name: t("breadcrumb.home"), href: "/" },
      { name: t("breadcrumb.current"), href: "/docs" },
    ]),
    howToSchema({
      name: t("hero.title"),
      description: t("hero.lead"),
      totalTime: "PT2M",
      steps: steps.map((step, index) => ({
        name: step.label,
        text: `${step.label}. Run: ${DOCS_QUICKSTART_COMMANDS[index]}.`,
      })),
    }),
  );

  return (
    <>
      <JsonLd json={schema} />
      <DocsHero />
      <div className="container-content pb-(--spacing-section)">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-16">
          <DocsToc variant="sidebar" />
          <div className="min-w-0 space-y-16">
            <DocsInstall />
            <DocsQuickstart />
            <DocsCliReference />
            <DocsSelfHosting />
            <DocsTroubleshooting />
            <DocsFooterNote />
          </div>
        </div>
      </div>
    </>
  );
}
