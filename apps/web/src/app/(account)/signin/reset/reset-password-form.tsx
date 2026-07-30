"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@repo/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/ui/card";
import { Input } from "@repo/ui/components/ui/input";
import { Label } from "@repo/ui/components/ui/label";
import { AlertCircle, KeyRound, Loader2 } from "lucide-react";
import { authClient, isHostedBuild } from "@/lib/auth-client";
import { HostedUnavailable } from "@/components/account/hosted-unavailable";

const MIN_PASSWORD = 8;

export function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  // better-auth appends this when the link has already been used or has
  // expired, rather than sending anyone to a form that cannot possibly work.
  const linkError = searchParams.get("error");

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!isHostedBuild) return <HostedUnavailable />;

  const unusable = !token || Boolean(linkError);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters.`);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await authClient.resetPassword({
        newPassword: password,
        token: token as string,
      });
      if (result.error) {
        setError(
          result.error.message ??
            "That link is no longer valid. Ask for a new one.",
        );
        return;
      }
      // Deliberately not signed in here: better-auth invalidates the token and
      // leaves the session alone, so the honest next step is signing in with
      // the password that was just set.
      router.replace("/signin");
    } catch {
      setError("Could not reach mtmux. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-10">
      <Card>
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <KeyRound className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <CardTitle className="text-xl">
            <h1>Choose a new password</h1>
          </CardTitle>
          <CardDescription>
            {unusable
              ? "This link has expired or has already been used."
              : "Pick something you don't use anywhere else."}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          )}

          {unusable ? (
            <Button asChild className="h-11 w-full">
              <Link href="/signin">Back to sign in</Link>
            </Button>
          ) : (
            <form onSubmit={onSubmit} noValidate className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  name="new-password"
                  type="password"
                  autoComplete="new-password"
                  autoFocus
                  className="h-11"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                  aria-describedby="new-password-hint"
                />
                <p
                  id="new-password-hint"
                  className="text-xs text-muted-foreground"
                >
                  At least {MIN_PASSWORD} characters.
                </p>
              </div>
              <Button
                type="submit"
                className="h-11 w-full"
                disabled={submitting}
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    Saving…
                  </>
                ) : (
                  "Set new password"
                )}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
