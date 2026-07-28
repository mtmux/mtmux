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
    sameAs: [siteConfig.social.github],
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

export function softwareApplicationSchema(description: string): Json {
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
    publisher: { "@id": organizationId },
    license: "https://opensource.org/licenses/MIT",
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
  name: string;
  description: string;
  steps: ReadonlyArray<{ name: string; text: string }>;
  totalTime?: string;
}): Json {
  return {
    "@type": "HowTo",
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

export function blogPostingSchema(options: {
  locale: Locale;
  path: string;
  title: string;
  description: string;
  datePublished: string;
  dateModified: string;
  authorName: string;
  authorUrl?: string;
  image: string;
  keywords?: readonly string[];
  wordCount?: number;
  section?: string;
}): Json {
  const url = absoluteUrl(options.locale, options.path);
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
    author: {
      "@type": "Person",
      name: options.authorName,
      url: options.authorUrl,
    },
    publisher: { "@id": organizationId },
    image: [options.image],
    keywords: options.keywords?.join(", "),
    wordCount: options.wordCount,
    articleSection: options.section,
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
