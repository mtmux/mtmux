import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { JsonLd } from "@/components/json-ld";
import { AgentFaq, getAgentsFaqItems } from "@/components/sections/agents/faq";
import { AgentsHero } from "@/components/sections/agents/hero";
import { AgentScope } from "@/components/sections/agents/scope";
import { AgentTimeline } from "@/components/sections/agents/timeline";
import { AgentWorkflow } from "@/components/sections/agents/workflow";
import { ClosingCta } from "@/components/sections/closing-cta";
import { buildMetadata } from "@/lib/seo";
import { breadcrumbSchema, faqSchema, graph } from "@/lib/structured-data";
import type { Locale } from "@/i18n/locales";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "agents" });

  return buildMetadata({
    locale: locale as Locale,
    path: "/agents",
    title: t("meta.title"),
    description: t("meta.description"),
  });
}

export default async function AgentsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: "agents" });
  const faqItems = await getAgentsFaqItems();

  const trail = [
    { name: t("breadcrumb.home"), href: "/" },
    { name: t("breadcrumb.current"), href: "/agents" },
  ];

  return (
    <>
      <JsonLd
        json={graph(
          breadcrumbSchema(locale as Locale, trail),
          faqSchema(faqItems),
        )}
      />
      <AgentsHero />
      <AgentWorkflow />
      <AgentScope />
      <AgentTimeline />
      <AgentFaq items={faqItems} />
      <ClosingCta namespace="agents.cta" />
    </>
  );
}
