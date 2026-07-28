import { Suspense } from "react";
import type { Metadata } from "next";
import { AuthForm } from "@/components/account/auth-form";

export const metadata: Metadata = {
  title: "Sign in · mtmux",
  description: "Sign in to reach every machine you have registered with mtmux.",
};

export default function SignInPage() {
  // `useSearchParams` (for `?next=`) needs a boundary or the route cannot be
  // prerendered at all.
  return (
    <Suspense>
      <AuthForm mode="signin" />
    </Suspense>
  );
}
