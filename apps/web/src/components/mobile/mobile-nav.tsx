"use client";

import { Terminal, LayoutList, FolderOpen, Settings } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";

export type MobileTab = "terminal" | "sessions" | "files" | "settings";

interface MobileNavProps {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
  className?: string;
}

const tabs: { id: MobileTab; label: string; icon: typeof Terminal }[] = [
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "sessions", label: "Sessions", icon: LayoutList },
  { id: "files", label: "Files", icon: FolderOpen },
  { id: "settings", label: "Settings", icon: Settings },
];

export function MobileNav({ activeTab, onTabChange, className }: MobileNavProps) {
  return (
    <nav className={cn("flex items-center justify-around border-t pb-[env(safe-area-inset-bottom)]", className)}>
      {tabs.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          className={cn(
            "flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] transition-colors",
            activeTab === id
              ? "text-primary"
              : "text-muted-foreground active:text-foreground",
          )}
          onClick={() => onTabChange(id)}
        >
          <Icon className="h-5 w-5" />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
