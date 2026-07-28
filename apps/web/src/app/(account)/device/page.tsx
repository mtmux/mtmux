import { Suspense } from "react";
import type { Metadata } from "next";
import { DeviceApproval } from "@/components/account/device-approval";

export const metadata: Metadata = {
  title: "Approve a terminal · mtmux",
  description: "Approve a device sign-in started by `mtmux login`.",
};

export default function DevicePage() {
  // The CLI's QR encodes `verification_uri_complete`, so the code arrives as
  // `?user_code=`. Reading it needs a Suspense boundary.
  return (
    <Suspense>
      <DeviceApproval />
    </Suspense>
  );
}
