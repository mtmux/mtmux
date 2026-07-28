import {
  AlertTriangle,
  ArrowUpRight,
  Info,
  Lightbulb,
  OctagonAlert,
} from "lucide-react";
import type { MDXComponents } from "mdx/types";
import NextImage from "next/image";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { Cmd, Keycap } from "@/components/primitives/cards";
import { Line, TerminalWindow } from "@/components/primitives/terminal";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/* Callout                                                                     */
/* -------------------------------------------------------------------------- */

const CALLOUT = {
  note: {
    Icon: Info,
    accent: "border-s-signal-stalled",
    icon: "text-signal-stalled",
  },
  tip: {
    Icon: Lightbulb,
    accent: "border-s-signal-done",
    icon: "text-signal-done",
  },
  warning: {
    Icon: AlertTriangle,
    accent: "border-s-signal-blocked",
    icon: "text-signal-blocked",
  },
  danger: {
    Icon: OctagonAlert,
    accent: "border-s-signal-failed",
    icon: "text-signal-failed",
  },
} as const;

export function Callout({
  type = "note",
  title,
  children,
}: {
  type?: keyof typeof CALLOUT;
  title?: string;
  children: ReactNode;
}) {
  const { Icon, accent, icon } = CALLOUT[type] ?? CALLOUT.note;
  return (
    <div
      className={cn(
        "not-prose my-6 rounded-lg border border-line border-s-2 bg-surface-raised p-4",
        accent,
      )}
    >
      <div className="flex gap-3">
        <Icon
          aria-hidden="true"
          className={cn("mt-0.5 size-4 shrink-0", icon)}
        />
        <div className="min-w-0 flex-1">
          {title ? (
            <p className="mb-1 text-[0.9375rem] font-600 text-text-strong">
              {title}
            </p>
          ) : null}
          <div className="text-[0.9375rem] leading-[1.7] text-text-muted [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&>p]:my-2">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Steps                                                                       */
/* -------------------------------------------------------------------------- */

export function Steps({ children }: { children: ReactNode }) {
  return (
    <div className="not-prose my-8 [counter-reset:step] grid gap-5">
      {children}
    </div>
  );
}

export function Step({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="relative grid grid-cols-[auto_minmax(0,1fr)] gap-4">
      <span
        aria-hidden="true"
        className="grid size-7 place-items-center rounded-full border border-line bg-surface-panel font-mono text-[0.8125rem] text-brand [counter-increment:step] before:content-[counter(step)]"
      />
      <div className="min-w-0">
        <p className="text-[1rem] font-600 text-text-strong">{title}</p>
        <div className="mt-2 text-[0.9375rem] leading-[1.75] text-text-muted [&>:first-child]:mt-0 [&>:last-child]:mb-0">
          {children}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Terminal demo                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Terminal output written as plain lines in MDX. Each child line is rendered
 * verbatim; a leading `$ ` is coloured as a prompt.
 */
export function TerminalDemo({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  const text = typeof children === "string" ? children : String(children ?? "");
  const lines = text.replace(/^\n+|\n+$/g, "").split("\n");

  return (
    <div className="not-prose my-7">
      <TerminalWindow title={title}>
        {lines.map((line, index) => {
          const isPrompt = line.trimStart().startsWith("$ ");
          const isComment = line.trimStart().startsWith("#");
          return (
            <Line
              key={index}
              tone={isComment ? "faint" : undefined}
              className={isPrompt ? "text-text-strong" : undefined}
            >
              {isPrompt ? (
                <>
                  <span
                    aria-hidden="true"
                    className="select-none-prompt text-term-prompt"
                  >
                    ${" "}
                  </span>
                  {line.replace(/^\s*\$ /, "")}
                </>
              ) : (
                line || " "
              )}
            </Line>
          );
        })}
      </TerminalWindow>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Comparison table                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A real semantic table. AI answer engines extract tables far more reliably
 * than the equivalent prose, so comparisons are always marked up as tables.
 */
export function CompareTable({
  columns,
  rows,
  caption,
}: {
  columns: string[];
  rows: string[][];
  caption?: string;
}) {
  return (
    <figure className="not-prose my-7">
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full border-collapse text-[0.9375rem]">
          <thead>
            <tr className="bg-surface-panel">
              {columns.map((column, index) => (
                <th
                  key={column}
                  scope="col"
                  className={cn(
                    "px-4 py-3 text-start font-mono text-xs font-500 tracking-[0.1em] text-text-faint uppercase",
                    index === 0 && "min-w-40",
                  )}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-t border-line-subtle">
                {row.map((cell, cellIndex) => (
                  <td
                    key={cellIndex}
                    className={cn(
                      "px-4 py-3 align-top",
                      cellIndex === 0
                        ? "font-500 text-text-strong"
                        : "text-text-muted",
                    )}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {caption ? (
        <figcaption className="mt-2 text-[0.8125rem] text-text-faint">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

/* -------------------------------------------------------------------------- */
/* Key row                                                                     */
/* -------------------------------------------------------------------------- */

export function KeyRow({ keys, active }: { keys: string[]; active?: string }) {
  return (
    <div
      className="not-prose my-6 grid gap-2"
      style={{
        gridTemplateColumns: `repeat(${Math.min(keys.length, 6)},minmax(0,1fr))`,
      }}
    >
      {keys.map((key) => (
        <Keycap key={key} active={key === active}>
          {key}
        </Keycap>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* FAQ                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Always-visible Q&A. The post page separately parses `<FAQItem q="…">` out of
 * the raw MDX to emit FAQPage JSON-LD, so the markup and the structured data
 * can never disagree.
 */
export function FAQ({ children }: { children: ReactNode }) {
  return (
    <div className="not-prose my-8 divide-y divide-line-subtle overflow-hidden rounded-xl border border-line">
      {children}
    </div>
  );
}

export function FAQItem({ q, children }: { q: string; children: ReactNode }) {
  return (
    <div className="bg-surface-raised p-5">
      <h3 className="font-sans text-[1rem] font-600 text-text-strong">{q}</h3>
      <div className="mt-2 text-[0.9375rem] leading-[1.75] text-text-muted [&>:first-child]:mt-0 [&>:last-child]:mb-0">
        {children}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Figure                                                                      */
/* -------------------------------------------------------------------------- */

export function Figure({
  caption,
  children,
}: {
  caption?: string;
  children: ReactNode;
}) {
  return (
    <figure className="not-prose my-7">
      {children}
      {caption ? (
        <figcaption className="mt-2 text-center text-[0.8125rem] text-text-faint">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

/* -------------------------------------------------------------------------- */
/* Element overrides                                                           */
/* -------------------------------------------------------------------------- */

function isExternal(href: string): boolean {
  return /^(https?:)?\/\//.test(href) || href.startsWith("mailto:");
}

function Anchor({
  href = "",
  children,
  ...props
}: ComponentPropsWithoutRef<"a">) {
  if (href.startsWith("#")) {
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  }

  if (isExternal(href)) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-baseline gap-0.5"
        {...props}
      >
        {children}
        <ArrowUpRight
          aria-hidden="true"
          className="size-3 shrink-0 self-center"
        />
      </a>
    );
  }

  // Internal links route through next-intl so they stay correct per locale.
  return (
    <Link href={href} {...props}>
      {children}
    </Link>
  );
}

function Table(props: ComponentPropsWithoutRef<"table">) {
  return (
    <div className="my-7 overflow-x-auto rounded-xl border border-line">
      <table className="w-full border-collapse" {...props} />
    </div>
  );
}

function Image({
  src,
  alt,
  width,
  height,
  ...props
}: ComponentPropsWithoutRef<"img">) {
  if (typeof src !== "string") return null;
  return (
    <NextImage
      src={src}
      alt={alt ?? ""}
      width={Number(width) || 1200}
      height={Number(height) || 630}
      className="rounded-xl border border-line"
      {...(props as Record<string, unknown>)}
    />
  );
}

/** Everything available inside a post, injected — posts never import. */
export const mdxComponents: MDXComponents = {
  Callout,
  Steps,
  Step,
  TerminalDemo,
  CompareTable,
  KeyRow,
  FAQ,
  FAQItem,
  Cmd,
  Figure,
  a: Anchor,
  table: Table,
  img: Image,
};
