import { getTranslations } from "next-intl/server";

import { Cmd } from "@/components/primitives/cards";
import { HairlineCell, HairlineGrid } from "@/components/primitives/cards";

type TroubleshootingItem = { problem: string; solution: string };

export async function DocsTroubleshooting() {
  const t = await getTranslations("docs.troubleshooting");
  const items = t.raw("items") as TroubleshootingItem[];

  return (
    <section id="troubleshooting">
      <h2 className="mb-5 text-[clamp(1.1875rem,2.35vw,1.6875rem)] leading-[1.06]">
        {t("title")}
      </h2>
      <HairlineGrid minColumnWidth="19rem">
        {items.map((item, index) => (
          <HairlineCell key={item.problem}>
            <p className="mb-2 text-[0.9375rem] text-text-strong">
              {item.problem}
            </p>
            <p className="text-[0.8125rem] leading-[1.7] text-text-muted">
              {t.rich(`items.${index}.solution`, {
                cmd: (chunks) => <Cmd>{chunks}</Cmd>,
              })}
            </p>
          </HairlineCell>
        ))}
      </HairlineGrid>
    </section>
  );
}
