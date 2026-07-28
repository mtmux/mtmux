"use client";

import { useEffect, useMemo, useState } from "react";
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
import { cn } from "@repo/ui/lib/utils";
import { AlertCircle, Loader2, Terminal } from "lucide-react";
import { isHostedBuild, signIn, signUp, useSession } from "@/lib/auth-client";
import { HostedUnavailable } from "./hosted-unavailable";
import { safeNext } from "./format";

type Mode = "signin" | "signup";

type Fields = { name: string; email: string; password: string };
type FieldErrors = Partial<Record<keyof Fields, string>>;

const COPY = {
  signin: {
    title: "Sign in",
    description: "Reach every machine you have registered.",
    submit: "Sign in",
    submitting: "Signing in…",
    switchPrompt: "New to mtmux?",
    switchLabel: "Create an account",
    switchHref: "/signup",
  },
  signup: {
    title: "Create your account",
    description: "One account, every machine, from any browser.",
    submit: "Create account",
    submitting: "Creating account…",
    switchPrompt: "Already have an account?",
    switchLabel: "Sign in",
    switchHref: "/signin",
  },
} as const;

// Deliberately loose. The authority on whether an address exists is the
// verification mail, not a regex, and a strict pattern only ever rejects
// somebody's perfectly valid address.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

function validate(mode: Mode, fields: Fields): FieldErrors {
  const errors: FieldErrors = {};
  if (mode === "signup" && !fields.name.trim()) {
    errors.name = "Tell us what to call you.";
  }
  if (!fields.email.trim()) {
    errors.email = "Enter your email address.";
  } else if (!EMAIL.test(fields.email.trim())) {
    errors.email = "That doesn't look like an email address.";
  }
  if (!fields.password) {
    errors.password = "Enter your password.";
  } else if (mode === "signup" && fields.password.length < MIN_PASSWORD) {
    errors.password = `Use at least ${MIN_PASSWORD} characters.`;
  }
  return errors;
}

export function AuthForm({ mode }: { mode: Mode }) {
  const copy = COPY[mode];
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, isPending } = useSession();

  const [fields, setFields] = useState<Fields>({
    name: "",
    email: "",
    password: "",
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const next = useMemo(
    () => safeNext(searchParams.get("next")),
    [searchParams],
  );

  // Someone who is already signed in should never be shown a sign-in form —
  // most often they arrived here from a /device link in a second tab.
  useEffect(() => {
    if (!isHostedBuild || isPending || !session) return;
    router.replace(next);
  }, [isPending, session, router, next]);

  if (!isHostedBuild) return <HostedUnavailable />;

  function set<K extends keyof Fields>(key: K, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
    // Clear the field's error as soon as it is being fixed, but leave the
    // form-level error alone — that one is about the last submission.
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const found = validate(mode, fields);
    setErrors(found);
    if (Object.values(found).some(Boolean)) {
      return;
    }

    setSubmitting(true);
    try {
      const result =
        mode === "signup"
          ? await signUp.email({
              name: fields.name.trim(),
              email: fields.email.trim(),
              password: fields.password,
            })
          : await signIn.email({
              email: fields.email.trim(),
              password: fields.password,
              rememberMe: true,
            });

      if (result.error) {
        setFormError(
          result.error.message ??
            (mode === "signin"
              ? "That email and password don't match an account."
              : "Could not create the account. Try again."),
        );
        return;
      }

      router.replace(next);
      router.refresh();
    } catch {
      setFormError(
        "Could not reach mtmux. Check your connection and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  // Hold the form back until the session check settles, so a signed-in visitor
  // never sees a sign-in form flash before the redirect.
  const checking = isPending || Boolean(session);

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-10">
      <Card>
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Terminal className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <CardTitle className="text-xl">
            <h1>{copy.title}</h1>
          </CardTitle>
          <CardDescription>{copy.description}</CardDescription>
        </CardHeader>

        <form onSubmit={onSubmit} noValidate>
          <CardContent className="space-y-4">
            {formError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>{formError}</span>
              </div>
            )}

            {mode === "signup" && (
              <Field
                id="name"
                label="Name"
                error={errors.name}
                input={
                  <Input
                    id="name"
                    name="name"
                    autoComplete="name"
                    className="h-11"
                    value={fields.name}
                    onChange={(e) => set("name", e.target.value)}
                    aria-invalid={Boolean(errors.name)}
                    aria-describedby={errors.name ? "name-error" : undefined}
                    disabled={submitting}
                  />
                }
              />
            )}

            <Field
              id="email"
              label="Email"
              error={errors.email}
              input={
                <Input
                  id="email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="h-11"
                  value={fields.email}
                  onChange={(e) => set("email", e.target.value)}
                  aria-invalid={Boolean(errors.email)}
                  aria-describedby={errors.email ? "email-error" : undefined}
                  disabled={submitting}
                />
              }
            />

            <Field
              id="password"
              label="Password"
              error={errors.password}
              hint={
                mode === "signup"
                  ? `At least ${MIN_PASSWORD} characters.`
                  : undefined
              }
              input={
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete={
                    mode === "signup" ? "new-password" : "current-password"
                  }
                  className="h-11"
                  value={fields.password}
                  onChange={(e) => set("password", e.target.value)}
                  aria-invalid={Boolean(errors.password)}
                  aria-describedby={
                    errors.password
                      ? "password-error"
                      : mode === "signup"
                        ? "password-hint"
                        : undefined
                  }
                  disabled={submitting}
                />
              }
            />

            <Button
              type="submit"
              className="h-11 w-full"
              disabled={submitting || checking}
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  {copy.submitting}
                </>
              ) : (
                copy.submit
              )}
            </Button>

            <p className="pt-1 text-center text-sm text-muted-foreground">
              {copy.switchPrompt}{" "}
              <Link
                href={
                  next === "/dashboard"
                    ? copy.switchHref
                    : `${copy.switchHref}?next=${encodeURIComponent(next)}`
                }
                className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {copy.switchLabel}
              </Link>
            </p>
          </CardContent>
        </form>
      </Card>
    </div>
  );
}

function Field({
  id,
  label,
  error,
  hint,
  input,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  input: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className={cn(error && "text-destructive")}>
        {label}
      </Label>
      {input}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
