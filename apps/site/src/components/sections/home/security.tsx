import { getTranslations } from "next-intl/server";

import { HairlineCell, HairlineGrid, Cmd } from "@/components/primitives/cards";
import { Section, SectionHeading } from "@/components/primitives/section";
import { Link } from "@/i18n/navigation";

const CELL_INDEXES = [0, 1, 2, 3] as const;

export async function Security() {
  const t = await getTranslations("home.security");

  return (
    <Section tone="raised">
      <div className="grid items-center gap-9 lg:grid-cols-2 lg:gap-14">
        <div>
          <SectionHeading
            eyebrow={t("eyebrow")}
            title={t("title")}
            description={t("description")}
            level={2}
            size="sm"
            className="max-w-none"
          />
          <Link
            href="/security"
            className="mt-6 inline-flex items-center gap-2 rounded-lg border border-line px-4.5 py-2.5 text-[0.90625rem] text-text transition-colors hover:border-brand hover:text-brand"
          >
            {t("readThreatModel")} →
          </Link>
        </div>

        <HairlineGrid minColumnWidth="14rem">
          {CELL_INDEXES.map((index) => (
            <HairlineCell key={index}>
              <p className="mb-1.5 text-[0.9375rem] text-text-strong">
                {t(`cells.${index}.title`)}
              </p>
              <p className="text-[0.8125rem] leading-[1.6] text-text-muted">
                {t.rich(`cells.${index}.description`, {
                  cmd: (chunks) => <Cmd>{chunks}</Cmd>,
                })}
              </p>
            </HairlineCell>
          ))}
        </HairlineGrid>
      </div>
    </Section>
  );
}
