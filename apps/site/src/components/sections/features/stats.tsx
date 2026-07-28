import { getTranslations } from "next-intl/server";

import { HairlineGrid, StatCard } from "@/components/primitives/cards";

export async function FeaturesStats() {
  const t = await getTranslations("features.stats");

  /**
   * Counts, not benchmarks.
   *
   * Every figure here is a property of the design that anyone can verify by
   * running the thing — not a latency or bundle-size number measured on an
   * unnamed machine under unstated conditions. If a number cannot be checked
   * by the reader, it does not belong on this row.
   */
  const stats = [
    { value: t("portsValue"), label: t("portsLabel") },
    { value: t("sshValue"), label: t("sshLabel") },
    { value: t("codeValue"), label: t("codeLabel") },
    { value: t("commandValue"), label: t("commandLabel") },
  ];

  return (
    <HairlineGrid minColumnWidth="10.5rem">
      {stats.map((stat, i) => (
        <StatCard key={i} value={stat.value} label={stat.label} />
      ))}
    </HairlineGrid>
  );
}
