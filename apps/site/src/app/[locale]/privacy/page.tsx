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
import { Link } from "@/i18n/navigation";
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
  const t = await getTranslations({ locale, namespace: "legal.privacy" });

  return buildMetadata({
    locale: locale as Locale,
    path: "/privacy",
    title: t("meta.title"),
    description: t("meta.description"),
  });
}

export default async function PrivacyPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: "legal.privacy" });

  function changelogLinkRich(chunks: ReactNode) {
    return (
      <Link href="/changelog" className={LINK_CLASS}>
        {chunks}
      </Link>
    );
  }

  const sections: LegalSection[] = [
    {
      id: "short-version",
      heading: t("sections.shortVersion.heading"),
      content: <p>{t("sections.shortVersion.paragraphs.p1")}</p>,
    },
    {
      id: "what-we-collect",
      heading: t("sections.whatWeCollect.heading"),
      content: (
        <LegalList>
          <LegalListItem term={t("sections.whatWeCollect.items.i1.term")}>
            {t("sections.whatWeCollect.items.i1.text")}
          </LegalListItem>
          <LegalListItem term={t("sections.whatWeCollect.items.i2.term")}>
            {t("sections.whatWeCollect.items.i2.text")}
          </LegalListItem>
          <LegalListItem term={t("sections.whatWeCollect.items.i3.term")}>
            {t("sections.whatWeCollect.items.i3.text")}
          </LegalListItem>
        </LegalList>
      ),
    },
    {
      id: "what-we-never-collect",
      heading: t("sections.whatWeNeverCollect.heading"),
      content: (
        <LegalList>
          <LegalListItem>
            {t("sections.whatWeNeverCollect.items.i1.text")}
          </LegalListItem>
          <LegalListItem>
            {t("sections.whatWeNeverCollect.items.i2.text")}
          </LegalListItem>
          <LegalListItem>
            {t("sections.whatWeNeverCollect.items.i3.text")}
          </LegalListItem>
          <LegalListItem>
            {t("sections.whatWeNeverCollect.items.i4.text")}
          </LegalListItem>
          <LegalListItem>
            {t("sections.whatWeNeverCollect.items.i5.text")}
          </LegalListItem>
        </LegalList>
      ),
    },
    {
      id: "retention",
      heading: t("sections.retention.heading"),
      content: <p>{t("sections.retention.paragraphs.p1")}</p>,
    },
    {
      id: "third-parties",
      heading: t("sections.thirdParties.heading"),
      content: (
        <div className="grid gap-4">
          <p>{t("sections.thirdParties.paragraphs.p1")}</p>
          <p>
            {t.rich("sections.thirdParties.paragraphs.p2", { cmd: cmdRich })}
          </p>
        </div>
      ),
    },
    {
      id: "your-rights",
      heading: t("sections.yourRights.heading"),
      content: (
        <p>
          {t.rich("sections.yourRights.paragraphs.p1", { email: emailRich })}
        </p>
      ),
    },
    {
      id: "changes",
      heading: t("sections.changes.heading"),
      content: (
        <p>
          {t.rich("sections.changes.paragraphs.p1", {
            changelogLink: changelogLinkRich,
          })}
        </p>
      ),
    },
  ];

  const schema = graph(
    breadcrumbSchema(locale as Locale, [
      { name: t("breadcrumb.home"), href: "/" },
      { name: t("breadcrumb.current"), href: "/privacy" },
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
