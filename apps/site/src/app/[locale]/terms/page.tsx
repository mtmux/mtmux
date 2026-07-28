import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";

import { JsonLd } from "@/components/json-ld";
import {
  LegalList,
  LegalListItem,
  LegalPage,
  type LegalSection,
} from "@/components/legal-page";
import { Cmd } from "@/components/primitives/cards";
import type { Locale } from "@/i18n/locales";
import { buildMetadata } from "@/lib/seo";
import { breadcrumbSchema, graph } from "@/lib/structured-data";

const LINK_CLASS =
  "text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand";

function cmdRich(chunks: ReactNode) {
  return <Cmd>{chunks}</Cmd>;
}

function emailRich(chunks: ReactNode) {
  return (
    <a href={`mailto:${chunks}`} className={LINK_CLASS}>
      {chunks}
    </a>
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "legal.terms" });

  return buildMetadata({
    locale: locale as Locale,
    path: "/terms",
    title: t("meta.title"),
    description: t("meta.description"),
  });
}

export default async function TermsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: "legal.terms" });

  const sections: LegalSection[] = [
    {
      id: "service",
      heading: t("sections.service.heading"),
      content: <p>{t("sections.service.paragraphs.p1")}</p>,
    },
    {
      id: "licences",
      heading: t("sections.licences.heading"),
      content: <p>{t("sections.licences.paragraphs.p1")}</p>,
    },
    {
      id: "responsibilities",
      heading: t("sections.responsibilities.heading"),
      content: (
        <LegalList>
          <LegalListItem>
            {t("sections.responsibilities.items.i1.text")}
          </LegalListItem>
          <LegalListItem>
            {t("sections.responsibilities.items.i2.text")}
          </LegalListItem>
          <LegalListItem>
            {t("sections.responsibilities.items.i3.text")}
          </LegalListItem>
        </LegalList>
      ),
    },
    {
      id: "billing",
      heading: t("sections.billing.heading"),
      content: <p>{t("sections.billing.paragraphs.p1")}</p>,
    },
    {
      id: "availability",
      heading: t("sections.availability.heading"),
      content: <p>{t("sections.availability.paragraphs.p1")}</p>,
    },
    {
      id: "termination",
      heading: t("sections.termination.heading"),
      content: (
        <p>{t.rich("sections.termination.paragraphs.p1", { cmd: cmdRich })}</p>
      ),
    },
    {
      id: "liability",
      heading: t("sections.liability.heading"),
      content: <p>{t("sections.liability.paragraphs.p1")}</p>,
    },
    {
      id: "contact",
      heading: t("sections.contact.heading"),
      content: (
        <p>{t.rich("sections.contact.paragraphs.p1", { email: emailRich })}</p>
      ),
    },
  ];

  const schema = graph(
    breadcrumbSchema(locale as Locale, [
      { name: t("breadcrumb.home"), href: "/" },
      { name: t("breadcrumb.current"), href: "/terms" },
    ]),
  );

  return (
    <>
      <JsonLd json={schema} />
      <LegalPage
        eyebrow={t("eyebrow")}
        title={t("title")}
        lastUpdated={t("lastUpdated")}
        sections={sections}
      />
    </>
  );
}
