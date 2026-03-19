"use client";

import { useEffect } from "react";
import { useUiStore } from "@/stores/ui-store";

export function useMobileHistory() {
  const mobileTab = useUiStore((s) => s.mobileTab);
  const setMobileTab = useUiStore((s) => s.setMobileTab);

  useEffect(() => {
    const state = { mobileTab };
    window.history.pushState(state, "");
  }, [mobileTab]);

  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      if (e.state?.mobileTab) {
        setMobileTab(e.state.mobileTab);
      } else {
        if (mobileTab === "files" || mobileTab === "settings") {
          setMobileTab("terminal");
        } else if (mobileTab === "terminal") {
          setMobileTab("sessions");
        }
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [mobileTab, setMobileTab]);
}
