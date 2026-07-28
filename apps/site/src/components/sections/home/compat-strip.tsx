import { getTranslations } from "next-intl/server";

import { Section } from "@/components/primitives/section";

export async function CompatStrip() {
  const t = await getTranslations("home.compat");
  const items = t.raw("items") as string[];

  return (
    <Section
      tone="raised"
      className="border-b border-line-subtle"
      innerClassName="py-5"
    >
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3.5">
        <span className="eyebrow text-text-faint">{t("label")}</span>
        <div className="flex flex-wrap gap-x-5.5 gap-y-2.5 font-mono text-[0.90625rem] text-text-subtle">
          {items.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </div>
    </Section>
  );
}
