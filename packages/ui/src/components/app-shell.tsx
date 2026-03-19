"use client";

import * as React from "react";
import { cn } from "../lib/utils";

interface AppShellProps {
  header?: React.ReactNode;
  toolbar?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function AppShell({ header, toolbar, children, className }: AppShellProps) {
  return (
    <div
      className={cn(
        "flex h-[100dvh] flex-col overflow-hidden",
        "pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]",
        "pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]",
        className,
      )}
      style={{ touchAction: "manipulation" }}
    >
      {header && (
        <header className="shrink-0 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          {header}
        </header>
      )}
      <main className="flex-1 overflow-hidden">{children}</main>
      {toolbar && (
        <footer className="shrink-0 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          {toolbar}
        </footer>
      )}
    </div>
  );
}
