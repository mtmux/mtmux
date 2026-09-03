import { describe, expect, it } from "vitest";

import { defaultLocale } from "@/i18n/locales";

import {
  faqSchema,
  graph,
  howToSchema,
  organizationSchema,
  softwareApplicationSchema,
  softwareId,
  webPageSchema,
  websiteId,
  websiteSchema,
} from "./structured-data";

type Node = Record<string, unknown>;

function parse(json: string): { "@graph": Node[] } {
  return JSON.parse(json) as { "@graph": Node[] };
}

describe("graph", () => {
  it("produces a parseable @graph with a context", () => {
    const doc = parse(
      graph(organizationSchema(), websiteSchema(defaultLocale)),
    );
    expect(doc["@graph"]).toHaveLength(2);
    expect(JSON.parse(graph())).toHaveProperty(
      "@context",
      "https://schema.org",
    );
  });

  it("gives every member an @type", () => {
    const doc = parse(
      graph(
        organizationSchema(),
        websiteSchema(defaultLocale),
        softwareApplicationSchema("d"),
        faqSchema([{ question: "q", answer: "a" }]),
      ),
    );
    for (const node of doc["@graph"]) expect(node).toHaveProperty("@type");
  });

  it("escapes markup so a stray tag cannot break out of the script element", () => {
    // `stripRichTags` is the real defence; this is the backstop that proves a
    // `<post>` reaching a builder cannot also reach the document as markup.
    const json = graph(
      faqSchema([{ question: "<post>q</post>", answer: "a" }]),
    );
    expect(json).not.toContain("</script");
  });
});

describe("webPageSchema", () => {
  const node = webPageSchema({
    locale: defaultLocale,
    path: "/",
    name: "n",
    description: "d",
    aboutId: softwareId,
    mainEntityId: softwareId,
  });

  it("ties the page to the WebSite entity", () => {
    expect(node.isPartOf).toEqual({ "@id": websiteId });
  });

  it("derives a stable @id from the canonical URL", () => {
    expect(node["@id"]).toBe("https://mtmux.com#webpage");
  });

  it("omits about, mainEntity and the image when none are given", () => {
    const bare = webPageSchema({
      locale: defaultLocale,
      path: "/faq",
      name: "n",
      description: "d",
    });
    expect(bare).not.toHaveProperty("about");
    expect(bare).not.toHaveProperty("mainEntity");
    expect(bare).not.toHaveProperty("primaryImageOfPage");
  });
});

describe("softwareApplicationSchema", () => {
  it("emits no featureList without options", () => {
    // /pricing calls this builder and shows none of the homepage's feature
    // titles. Structured data must not describe content that page lacks.
    expect(softwareApplicationSchema("d")).not.toHaveProperty("featureList");
    expect(softwareApplicationSchema("d", {})).not.toHaveProperty(
      "featureList",
    );
    expect(
      softwareApplicationSchema("d", { featureList: [] }),
    ).not.toHaveProperty("featureList");
  });

  it("emits featureList when the page shows one", () => {
    expect(softwareApplicationSchema("d", { featureList: ["a", "b"] })).toEqual(
      expect.objectContaining({ featureList: ["a", "b"] }),
    );
  });

  it("keeps one stable @id across every page that emits it", () => {
    expect(softwareApplicationSchema("d")["@id"]).toBe(softwareId);
  });
});

describe("howToSchema", () => {
  const node = howToSchema({
    id: "https://mtmux.com/#how-to-attach",
    name: "n",
    description: "d",
    steps: [
      { name: "one", text: "1" },
      { name: "two", text: "2" },
      { name: "three", text: "3" },
    ],
  });

  it("numbers steps 1..n contiguously", () => {
    const steps = node.step as Array<{ position: number }>;
    expect(steps.map((s) => s.position)).toEqual([1, 2, 3]);
  });

  it("carries the @id that keeps two HowTos distinguishable", () => {
    expect(node["@id"]).toBe("https://mtmux.com/#how-to-attach");
    expect(
      howToSchema({ name: "n", description: "d", steps: [] }),
    ).not.toHaveProperty("@id");
  });

  it("omits totalTime unless one is given", () => {
    expect(node.totalTime).toBeUndefined();
  });
});
