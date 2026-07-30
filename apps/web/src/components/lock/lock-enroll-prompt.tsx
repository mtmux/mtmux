"use client";

import { useEffect, useState } from "react";
import { takeEnrollmentPrompt } from "@/lib/lock-controller";
import { isEnrolled } from "@/lib/unlocked";
import { LockEnrollDialog } from "./lock-enroll-dialog";

/**
 * Opens the enrollment dialog once, on the first terminal load after a pairing.
 *
 * Everything about "exactly once" lives in `takeEnrollmentPrompt()`, which
 * consumes the flag as it reads it — so a double mount in React's strict mode
 * cannot show it twice.
 */
export function LockEnrollPrompt() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (isEnrolled()) return;
    if (takeEnrollmentPrompt()) setOpen(true);
  }, []);

  return <LockEnrollDialog open={open} onOpenChange={setOpen} />;
}
