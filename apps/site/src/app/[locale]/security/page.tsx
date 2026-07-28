import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { JsonLd } from "@/components/json-ld";
import { SecurityDataPath } from "@/components/sections/security/security-data-path";
import { SecurityDisclosure } from "@/components/sections/security/security-disclosure";
import { SecurityGuarantees } from "@/components/sections/security/security-guarantees";
import { SecurityHero } from "@/components/sections/security/security-hero";
import { SecurityPosture } from "@/components/sections/security/security-posture";
import type { Locale } from "@/i18n/locales";
import { buildMetadata } from "@/lib/seo";
import { breadcrumbSchema, graph } from "@/lib/structured-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "security" });

  return buildMetadata({
    locale: locale as Locale,
    path: "/security",
    title: t("meta.title"),
    description: t("meta.description"),
  });
}

export default async function SecurityPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: "security" });

  const schema = graph(
    breadcrumbSchema(locale as Locale, [
      { name: t("breadcrumb.home"), href: "/" },
      { name: t("breadcrumb.current"), href: "/security" },
    ]),
  );

  return (
    <>
      <JsonLd json={schema} />
      <SecurityHero />
      <SecurityDataPath />
      <SecurityGuarantees />
      <SecurityPosture />
      <SecurityDisclosure />
    </>
  );
}
