"use client";

import { ArrowUpRight, Menu } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { CopyInstall } from "@/components/site/copy-install";
import { Logo } from "@/components/site/logo";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { navigation, siteConfig } from "@/config/site";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

export function MobileNav() {
  const t = useTranslations("nav");
  const tFooter = useTranslations("footer");
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the drawer once navigation completes. Adjusting state during render
  // when a value changes is React's documented alternative to a reset effect —
  // it avoids the extra render pass an effect would cause.
  const [navigatedFrom, setNavigatedFrom] = useState(pathname);
  if (pathname !== navigatedFrom) {
    setNavigatedFrom(pathname);
    setOpen(false);
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        aria-label={t("openMenu")}
        className="grid size-8 place-items-center rounded-lg border border-line bg-surface-panel text-text-subtle transition-colors hover:border-line-strong hover:text-text-strong md:hidden"
      >
        <Menu aria-hidden="true" className="size-4" />
      </SheetTrigger>
      <SheetContent side="right" className="w-[min(20rem,88vw)]">
        <SheetHeader>
          <SheetTitle className="flex items-center">
            <Logo />
          </SheetTitle>
        </SheetHeader>

        <nav aria-label={t("primary")} className="grid gap-0.5 px-4">
          {navigation.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link
                key={item.key}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex items-center justify-between rounded-lg border-b border-line-subtle px-1 py-3.5 text-base text-text-muted transition-colors hover:text-text-strong",
                  isActive && "text-brand",
                )}
              >
                {t(item.key)}
              </Link>
            );
          })}
          <a
            href={siteConfig.social.github}
            rel="noreferrer noopener"
            target="_blank"
            className="flex items-center justify-between px-1 py-3.5 text-base text-text-muted transition-colors hover:text-text-strong"
          >
            {tFooter("links.github")}
            <ArrowUpRight
              aria-hidden="true"
              className="size-4 text-text-faint"
            />
          </a>
        </nav>

        <div className="mt-auto p-4">
          <CopyInstall className="w-full justify-center" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
