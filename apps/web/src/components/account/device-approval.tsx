"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  MonitorSmartphone,
  ShieldX,
} from "lucide-react";
import {
  ApiError,
  authClient,
  claimDeviceCode,
  isHostedBuild,
  useSession,
} from "@/lib/auth-client";
import { HostedUnavailable } from "./hosted-unavailable";

type Phase =
  | { name: "prompt" } // no code yet — ask for one
  | { name: "claiming" }
  | { name: "review"; status: string }
  | { name: "deciding"; action: "approve" | "deny" }
  | { name: "approved" }
  | { name: "denied" }
  | { name: "failed"; message: string; recoverable: boolean };

const USER_CODE_LENGTH = 8;

/** The broker stores codes without separators; the CLI prints them with one. */
function normalizeCode(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

/**
 * better-auth surfaces device errors as OAuth-shaped `{ error,
 * error_description }` rather than the `{ message }` the rest of the client
 * uses, so both spellings are read here.
 */
function describeError(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  for (const key of ["error_description", "message"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/**
 * Approve a `mtmux login` running in a terminal somewhere else.
 *
 * The two-step shape is the part worth remembering: `GET /device?user_code=`
 * must run first, under this browser's session cookie, because that call is
 * what stamps the pending device row with the approving user's id. Going
 * straight to `/device/approve` fails with "Device code has not been claimed by
 * a verifying session" every single time.
 */
export function DeviceApproval() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, isPending } = useSession();

  const queryCode = normalizeCode(searchParams.get("user_code") ?? "");
  const [code, setCode] = useState(queryCode);
  const [entry, setEntry] = useState(queryCode);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>(
    queryCode ? { name: "claiming" } : { name: "prompt" },
  );
  // Claiming is a mutation on the server; React's dev-mode double effect would
  // otherwise fire it twice for the same code.
  const claimed = useRef<string | null>(null);

  const signedOut = isHostedBuild && !isPending && !session;

  // Bounce to sign-in, preserving the code so the round trip lands back here
  // with everything it needs.
  useEffect(() => {
    if (!signedOut) return;
    const back = code
      ? `/device?user_code=${encodeURIComponent(code)}`
      : "/device";
    router.replace(`/signin?next=${encodeURIComponent(back)}`);
  }, [signedOut, code, router]);

  const claim = useCallback(async (userCode: string) => {
    setPhase({ name: "claiming" });
    try {
      const result = await claimDeviceCode(userCode);
      if (result.status === "approved") {
        setPhase({ name: "approved" });
        return;
      }
      if (result.status === "denied") {
        setPhase({ name: "denied" });
        return;
      }
      setPhase({ name: "review", status: result.status });
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : "Could not check that code. Try again.";
      setPhase({ name: "failed", message, recoverable: true });
    }
  }, []);

  useEffect(() => {
    if (!isHostedBuild || isPending || !session) return;
    if (!code || claimed.current === code) return;
    claimed.current = code;
    void claim(code);
  }, [code, claim, isPending, session]);

  async function decide(action: "approve" | "deny") {
    setPhase({ name: "deciding", action });
    try {
      const result =
        action === "approve"
          ? await authClient.device.approve({ userCode: code })
          : await authClient.device.deny({ userCode: code });

      if (result.error) {
        setPhase({
          name: "failed",
          message:
            describeError(result.error) ??
            "That code could not be processed. It may have expired.",
          recoverable: true,
        });
        return;
      }
      setPhase(
        action === "approve" ? { name: "approved" } : { name: "denied" },
      );
    } catch {
      setPhase({
        name: "failed",
        message: "Could not reach mtmux. Check your connection and try again.",
        recoverable: true,
      });
    }
  }

  function submitCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = normalizeCode(entry);
    if (next.length !== USER_CODE_LENGTH) {
      setEntryError(`Codes are ${USER_CODE_LENGTH} characters long.`);
      return;
    }
    setEntryError(null);
    claimed.current = null;
    setCode(next);
  }

  function startOver() {
    claimed.current = null;
    setCode("");
    setEntry("");
    setEntryError(null);
    setPhase({ name: "prompt" });
  }

  if (!isHostedBuild) return <HostedUnavailable />;

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-10">
      <Card>
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <MonitorSmartphone className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <CardTitle className="text-xl">
            <h1>
              {phase.name === "approved"
                ? "Device connected"
                : phase.name === "denied"
                  ? "Request denied"
                  : "Approve a terminal"}
            </h1>
          </CardTitle>
          <CardDescription>
            {phase.name === "approved"
              ? "You can go back to your terminal now."
              : phase.name === "denied"
                ? "Nothing was granted access."
                : "Confirm the code shown by `mtmux login`."}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          {(isPending || signedOut) && (
            <Waiting
              label={
                isPending ? "Checking your session…" : "Taking you to sign in…"
              }
            />
          )}

          {!isPending && !signedOut && (
            <>
              {phase.name === "prompt" && (
                <form onSubmit={submitCode} className="space-y-4" noValidate>
                  <div className="space-y-2">
                    <Label htmlFor="user-code">Code from your terminal</Label>
                    <Input
                      id="user-code"
                      value={entry}
                      onChange={(e) => {
                        setEntry(e.target.value);
                        setEntryError(null);
                      }}
                      placeholder="XXXX-XXXX"
                      autoFocus
                      autoCapitalize="characters"
                      autoComplete="one-time-code"
                      spellCheck={false}
                      maxLength={USER_CODE_LENGTH + 4}
                      aria-invalid={Boolean(entryError)}
                      aria-describedby={
                        entryError ? "user-code-error" : undefined
                      }
                      className="h-12 text-center font-mono text-lg tracking-[0.3em]"
                    />
                    {entryError && (
                      <p
                        id="user-code-error"
                        role="alert"
                        className="text-xs text-destructive"
                      >
                        {entryError}
                      </p>
                    )}
                  </div>
                  <Button type="submit" className="h-11 w-full">
                    Continue
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </Button>
                </form>
              )}

              {phase.name === "claiming" && (
                <Waiting label="Checking that code…" />
              )}

              {phase.name === "review" && (
                <>
                  <CodeDisplay code={code} />
                  <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-4 text-sm">
                    <p className="text-muted-foreground">
                      Approving lets that terminal act as{" "}
                      <span className="font-medium text-foreground">
                        {session?.user.email}
                      </span>{" "}
                      — it can list your registered machines and connect to
                      them.
                    </p>
                    <p className="text-muted-foreground">
                      Only approve if you started{" "}
                      <code className="font-mono">mtmux login</code> yourself
                      and the code above matches what it printed.
                    </p>
                  </div>
                  <div className="flex flex-col-reverse gap-2 sm:flex-row">
                    <Button
                      variant="outline"
                      className="h-11 flex-1"
                      onClick={() => decide("deny")}
                    >
                      Deny
                    </Button>
                    <Button
                      className="h-11 flex-1"
                      onClick={() => decide("approve")}
                    >
                      Approve
                    </Button>
                  </div>
                </>
              )}

              {phase.name === "deciding" && (
                <Waiting
                  label={phase.action === "approve" ? "Approving…" : "Denying…"}
                />
              )}

              {phase.name === "approved" && (
                <Outcome
                  icon={
                    <CheckCircle2
                      className="h-6 w-6 text-success"
                      aria-hidden
                    />
                  }
                  title="Approved"
                  body="Return to your terminal — mtmux login finishes on its own within a few seconds."
                >
                  <Button asChild variant="outline" className="h-11 w-full">
                    <Link href="/dashboard">Go to your servers</Link>
                  </Button>
                </Outcome>
              )}

              {phase.name === "denied" && (
                <Outcome
                  icon={
                    <ShieldX
                      className="h-6 w-6 text-muted-foreground"
                      aria-hidden
                    />
                  }
                  title="Denied"
                  body="That terminal was not given access. If this was a mistake, run mtmux login again for a fresh code."
                >
                  <Button
                    variant="outline"
                    className="h-11 w-full"
                    onClick={startOver}
                  >
                    Enter another code
                  </Button>
                </Outcome>
              )}

              {phase.name === "failed" && (
                <Outcome
                  icon={
                    <AlertCircle
                      className="h-6 w-6 text-destructive"
                      aria-hidden
                    />
                  }
                  title="That didn't work"
                  body={phase.message}
                >
                  {phase.recoverable && (
                    <div className="flex flex-col gap-2">
                      {code && (
                        <Button
                          className="h-11 w-full"
                          onClick={() => {
                            claimed.current = code;
                            void claim(code);
                          }}
                        >
                          Try again
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        className="h-11 w-full"
                        onClick={startOver}
                      >
                        Enter another code
                      </Button>
                    </div>
                  )}
                </Outcome>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CodeDisplay({ code }: { code: string }) {
  const grouped =
    code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
  return (
    <p className="rounded-lg border border-border bg-muted/40 py-5 text-center font-mono text-2xl tracking-[0.25em] text-foreground sm:text-3xl">
      {/* Read out character by character; "6F3A91BC" as one token is useless. */}
      <span aria-hidden>{grouped}</span>
      <span className="sr-only">Code {code.split("").join(" ")}</span>
    </p>
  );
}

function Waiting({ label }: { label: string }) {
  return (
    <p
      className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label}
    </p>
  );
}

function Outcome({
  icon,
  title,
  body,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-4 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        {icon}
      </div>
      <div className="space-y-1">
        <h2 className="text-base font-medium text-foreground">{title}</h2>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
      {children}
    </div>
  );
}
