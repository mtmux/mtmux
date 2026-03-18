"use client";

import { Toaster } from "sonner";

export function ToastProvider() {
  return (
    <Toaster
      position="top-center"
      visibleToasts={3}
      duration={4000}
      toastOptions={{
        classNames: {
          toast: "bg-background text-foreground border-border",
          description: "text-muted-foreground",
        },
      }}
    />
  );
}
