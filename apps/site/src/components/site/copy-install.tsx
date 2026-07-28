"use client";

import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

type CopyInstallProps = {
  /** `lg` is the hero treatment; `sm` sits in the header. */
  size?: "sm" | "md" | "lg";
  className?: string;
};

/**
 * The site's single call to action: the install command itself.
 *
 * There is no sign-up, so the shortest path to value is a command the visitor
 * can paste. Clicking anywhere on the block copies it.
 */
export function CopyInstall({ size = "md", className }: CopyInstallProps) {
  const t = useTranslations("common");
  const [copied, setCopied] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timeout.current), []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(siteConfig.install);
    } catch {
      // Clipboard can be blocked (insecure origin, denied permission).
      // The command is visible either way, so fail silently.
      return;
    }
    setCopied(true);
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setCopied(false), 2000);
  }, []);

  return (
    <button
      type="button"
      onClick={copy}
      data-copied={copied || undefined}
      aria-label={t("copyInstallLabel", { command: siteConfig.install })}
      className={cn(
        "group inline-flex items-center gap-3 rounded-lg border border-line bg-surface-panel font-mono text-text transition-colors",
        "hover:border-line-strong hover:bg-surface-raised",
        size === "sm" && "gap-2 px-2.5 py-1.5 text-[0.8125rem]",
        size === "md" && "px-3.5 py-2.5 text-sm",
        size === "lg" && "px-4 py-3 text-[0.9375rem]",
        className,
      )}
    >
      <span aria-hidden="true" className="select-none-prompt text-brand">
        $
      </span>
      <span className="tracking-[-0.01em] whitespace-nowrap">
        {siteConfig.install}
      </span>
      <span
        className={cn(
          "relative ms-1 grid place-items-center text-text-subtle transition-colors group-hover:text-brand",
          size === "sm" ? "size-3.5" : "size-4",
        )}
      >
        <Copy
          aria-hidden="true"
          className={cn(
            "absolute size-full transition-all duration-150",
            copied && "scale-50 opacity-0",
          )}
        />
        <Check
          aria-hidden="true"
          className={cn(
            "absolute size-full text-brand transition-all duration-150",
            copied ? "scale-100 opacity-100" : "scale-50 opacity-0",
          )}
        />
      </span>
      <span aria-live="polite" className="sr-only">
        {copied ? t("copied") : ""}
      </span>
    </button>
  );
}
