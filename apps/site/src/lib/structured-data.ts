import type { Author } from "@/config/authors";
import { PLANS, PRICING } from "@/config/plans";
import { siteConfig } from "@/config/site";
import { type Locale } from "@/i18n/locales";

import { absoluteUrl } from "./seo";

/**
 * JSON-LD builders.
 *
 * Only emit a type when the page genuinely contains what it claims — Google
 * penalises markup that describes content the user cannot see, and AI answer
 * engines weight structured data heavily when choosing what to cite.
 */

type Json = Record<string, unknown>;

export const organizationId = `${siteConfig.url}/#organization`;
export const websiteId = `${siteConfig.url}/#website`;
export const softwareId = `${siteConfig.url}/#software`;

export function organizationSchema(): Json {
  return {
    "@type": "Organization",
    "@id": organizationId,
    name: siteConfig.legalName,
    url: siteConfig.url,
    logo: {
      "@type": "ImageObject",
      url: `${siteConfig.url}/logo-mark.svg`,
      width: 512,
      height: 512,
    },
    // The npm package is the strongest third-party profile this project has —
    // it is already trusted as `installUrl` on the SoftwareApplication node
    // below, and leaving it out of `sameAs` meant the two identifiers were
    // never joined up for anything reading the graph.
    sameAs: [siteConfig.social.github, "https://www.npmjs.com/package/mtmux"],
    contactPoint: {
      "@type": "ContactPoint",
      email: siteConfig.email,
      contactType: "customer support",
    },
  };
}

export function websiteSchema(locale: Locale): Json {
  return {
    "@type": "WebSite",
    "@id": websiteId,
    name: siteConfig.name,
    url: siteConfig.url,
    inLanguage: locale,
    publisher: { "@id": organizationId },
    // Deliberately no `SearchAction`: the site has no search endpoint. Claiming
    // one that does not filter anything is markup describing content the user
    // cannot reach. Add it back the day `/blog` honours a `?q=` parameter.
  };
}

/**
 * The application node.
 *
 * `featureList` is optional and passed from `/` only. Every page that emits a
 * `SoftwareApplication` shares this one `@id`, and `/pricing` renders none of
 * the feature titles the homepage does — listing them there would be markup
 * describing content the reader cannot see, which is the one rule this module
 * exists to keep.
 */
export function softwareApplicationSchema(
  description: string,
  options?: { featureList?: readonly string[] },
): Json {
  return {
    "@type": "SoftwareApplication",
    "@id": softwareId,
    name: siteConfig.name,
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "Terminal Multiplexer Client",
    operatingSystem: "macOS, Linux, WSL",
    description,
    url: siteConfig.url,
    downloadUrl: siteConfig.url,
    softwareVersion: siteConfig.version,
    installUrl: "https://www.npmjs.com/package/mtmux",
    // A `WebPage`, not a second `WebSite`: the graph already has exactly one
    // WebSite node with a stable `@id`, and an anonymous duplicate of that type
    // is the fastest way to confuse whatever is resolving entities.
    softwareHelp: {
      "@type": "WebPage",
      url: siteConfig.docsUrl,
      name: "mtmux documentation",
    },
    softwareRequirements: "Node.js 22 or newer; tmux",
    publisher: { "@id": organizationId },
    license: "https://opensource.org/licenses/MIT",
    ...(options?.featureList && options.featureList.length > 0
      ? { featureList: [...options.featureList] }
      : {}),
    // Prices come from the same table /pricing renders, so the machine-readable
    // offer and the human-readable one cannot disagree. Structured data is the
    // more dangerous of the two to get wrong: it is quoted by search engines
    // verbatim and nobody proof-reads it.
    offers: [
      {
        "@type": "Offer",
        name: "Free",
        price: "0",
        priceCurrency: "USD",
        description: `One registered server, ${PLANS.free.devicesPerServer} trusted devices, ${PLANS.free.monthlyGib} GB of relayed traffic a month. Unlimited on your own network.`,
      },
      {
        "@type": "Offer",
        name: "Pro",
        price: String(PRICING.pro.monthlyUsd),
        priceCurrency: "USD",
        description: `Unlimited servers and devices, ${PLANS.pro.monthlyGib} GB of relayed traffic a month, named servers. $${PRICING.pro.yearlyUsd} a year.`,
      },
    ],
  };
}

/**
 * The page node.
 *
 * Cheap and load-bearing: without it a page's other nodes float free of the
 * `WebSite` entity, and nothing in the graph says which page they describe.
 * `about` and `mainEntity` take `@id` references so the page joins the entities
 * that already exist rather than minting near-duplicates of them.
 */
export function webPageSchema(options: {
  locale: Locale;
  path: string;
  name: string;
  description: string;
  /** `@id` of the entity this page is about — usually `softwareId`. */
  aboutId?: string;
  /** `@id` of the page's primary entity, when one node *is* the page. */
  mainEntityId?: string;
  primaryImageUrl?: string;
}): Json {
  const url = absoluteUrl(options.locale, options.path);

  return {
    "@type": "WebPage",
    "@id": `${url}#webpage`,
    url,
    name: options.name,
    description: options.description,
    inLanguage: options.locale,
    isPartOf: { "@id": websiteId },
    ...(options.aboutId ? { about: { "@id": options.aboutId } } : {}),
    ...(options.mainEntityId
      ? { mainEntity: { "@id": options.mainEntityId } }
      : {}),
    ...(options.primaryImageUrl
      ? {
          primaryImageOfPage: {
            "@type": "ImageObject",
            url: options.primaryImageUrl,
          },
        }
      : {}),
  };
}

export function breadcrumbSchema(
  locale: Locale,
  trail: ReadonlyArray<{ name: string; href: string }>,
): Json {
  return {
    "@type": "BreadcrumbList",
    itemListElement: trail.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absoluteUrl(locale, item.href),
    })),
  };
}

export function faqSchema(
  entries: ReadonlyArray<{ question: string; answer: string }>,
): Json {
  return {
    "@type": "FAQPage",
    mainEntity: entries.map((entry) => ({
      "@type": "Question",
      name: entry.question,
      acceptedAnswer: { "@type": "Answer", text: entry.answer },
    })),
  };
}

export function howToSchema(options: {
  /** A stable `@id`, so two HowTo nodes on one site stay distinguishable. */
  id?: string;
  name: string;
  description: string;
  steps: ReadonlyArray<{ name: string; text: string }>;
  totalTime?: string;
}): Json {
  return {
    "@type": "HowTo",
    ...(options.id ? { "@id": options.id } : {}),
    name: options.name,
    description: options.description,
    totalTime: options.totalTime,
    step: options.steps.map((step, index) => ({
      "@type": "HowToStep",
      position: index + 1,
      name: step.name,
      text: step.text,
    })),
  };
}

/**
 * The author node for a byline.
 *
 * Every author used to be a `Person` carrying the *same* GitHub URL — the
 * project's repository. Three Persons sharing one URL tells a knowledge graph
 * they are one entity, which is strictly worse than saying nothing. So: the
 * project byline resolves to the publisher Organization it actually is, and a
 * named author gets a stable `@id` on our own domain, which is what makes a
 * byline reusable as an entity across posts. A `url` is emitted only when there
 * is a real, author-specific one to emit.
 */
export function authorNode(author: Author): Json {
  if (author.isOrganization) return { "@id": organizationId };

  return {
    "@type": "Person",
    "@id": `${siteConfig.url}/#author-${author.key}`,
    name: author.name,
    jobTitle: author.role,
    description: author.bio,
    ...(author.url ? { url: author.url } : {}),
    worksFor: { "@id": organizationId },
  };
}

/** A `DefinedTerm`-free `about`/`mentions` entry — a plain Thing with a name. */
function thing(name: string): Json {
  return { "@type": "Thing", name };
}

export function blogPostingSchema(options: {
  locale: Locale;
  path: string;
  title: string;
  description: string;
  datePublished: string;
  dateModified: string;
  author: Author;
  image: string;
  keywords?: readonly string[];
  wordCount?: number;
  section?: string;
  /** The one subject the post is about. Usually its primary keyword. */
  about?: string;
  /** Secondary subjects, from the post's tags. */
  mentions?: readonly string[];
}): Json {
  const url = absoluteUrl(options.locale, options.path);
  const mentions = (options.mentions ?? []).filter(
    (name) => name.toLowerCase() !== options.about?.toLowerCase(),
  );

  return {
    "@type": "BlogPosting",
    "@id": `${url}#article`,
    headline: options.title,
    description: options.description,
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    datePublished: options.datePublished,
    dateModified: options.dateModified,
    inLanguage: options.locale,
    author: authorNode(options.author),
    publisher: { "@id": organizationId },
    image: [options.image],
    keywords: options.keywords?.join(", "),
    wordCount: options.wordCount,
    articleSection: options.section,
    // `about` is the single subject; `mentions` are the rest. Splitting them is
    // what lets an answer engine tell "a page about tmux panes" from "a page
    // that says the word tmux", which a flat keyword string cannot express.
    ...(options.about ? { about: thing(options.about) } : {}),
    ...(mentions.length > 0 ? { mentions: mentions.map(thing) } : {}),
    isPartOf: { "@id": websiteId },
  };
}

export function itemListSchema(
  locale: Locale,
  items: ReadonlyArray<{ name: string; href: string; description?: string }>,
): Json {
  return {
    "@type": "ItemList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      description: item.description,
      url: absoluteUrl(locale, item.href),
    })),
  };
}

/** Wraps one or more schema objects into a single `@graph` document. */
export function graph(...nodes: Json[]): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": nodes,
  });
}
