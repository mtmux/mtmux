import { Suspense } from "react";
import type { Metadata } from "next";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = {
  title: "Choose a new password · mtmux",
  description: "Set a new password for your mtmux account.",
};

/**
 * Where the password-reset email lands.
 *
 * Nested under `/signin` rather than given a top-level route because it is one
 * branch of signing in and shares its chrome — and because the whole feature,
 * link included, did not exist in the product until now.
 */
export default function ResetPasswordPage() {
  // `useSearchParams` (for `?token=`) needs a boundary or the route cannot be
  // prerendered at all.
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}
