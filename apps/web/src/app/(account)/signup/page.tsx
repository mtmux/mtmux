import { Suspense } from "react";
import type { Metadata } from "next";
import { AuthForm } from "@/components/account/auth-form";

export const metadata: Metadata = {
  title: "Create an account · mtmux",
  description:
    "Create an mtmux account to keep all of your machines in one place.",
};

export default function SignUpPage() {
  return (
    <Suspense>
      <AuthForm mode="signup" />
    </Suspense>
  );
}
