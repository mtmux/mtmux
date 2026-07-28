import { getTranslations } from "next-intl/server";

import { CopyInstall } from "@/components/site/copy-install";
import { LocaleSwitcher } from "@/components/site/locale-switcher";
import { Logo } from "@/components/site/logo";
import { MobileNav } from "@/components/site/mobile-nav";
import { NavLink } from "@/components/site/nav-link";
import { navigation } from "@/config/site";
import { Link } from "@/i18n/navigation";

export async function SiteHeader() {
  const t = await getTranslations("nav");

  return (
    <header className="sticky top-0 z-50 border-b border-line-subtle bg-surface-base/80 backdrop-blur-xl">
      <div className="container-content flex h-14 items-center justify-between gap-4">
        <Link href="/" aria-label={t("home")} className="flex-none">
          <Logo />
        </Link>

        <nav
          aria-label={t("primary")}
          className="hidden items-center gap-0.5 md:flex"
        >
          {navigation.map((item) => (
            <NavLink key={item.key} href={item.href}>
              {t(item.key)}
            </NavLink>
          ))}
        </nav>

        <div className="flex flex-none items-center gap-2">
          <LocaleSwitcher className="hidden sm:inline-flex" />
          <CopyInstall size="sm" className="hidden lg:inline-flex" />
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
