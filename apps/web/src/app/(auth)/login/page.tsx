"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@repo/ui/components/ui/button";
import { Input } from "@repo/ui/components/ui/input";
import { Label } from "@repo/ui/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/ui/card";
import { Terminal } from "lucide-react";
import { toast } from "sonner";
import { RelayClient } from "@/lib/ws-client";
import { resolveRelayWsUrl } from "@/lib/relay-url";

export default function LoginPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const clientRef = useRef<RelayClient | null>(null);

  // Validate a token by attempting a WebSocket connection, then redirect on
  // success. Shared by the manual paste form and fragment-based auto-login.
  const connectWithToken = useCallback(
    (trimmedToken: string) => {
      setIsLoading(true);

      // Store token first
      localStorage.setItem("ccremote-token", trimmedToken);

      // Validate by attempting a WebSocket connection
      const timeoutId = setTimeout(() => {
        clientRef.current?.disconnect();
        clientRef.current = null;
        localStorage.removeItem("ccremote-token");
        setIsLoading(false);
        toast.error(
          "Connection timed out. Check the relay server and try again.",
        );
      }, 5000);

      const client = new RelayClient({
        url: resolveRelayWsUrl(),
        token: trimmedToken,
        onMessage: (msg) => {
          if (msg.type === "auth:success") {
            clearTimeout(timeoutId);
            // Clear ref BEFORE disconnect to prevent the status handler
            // from treating this intentional disconnect as a failure
            clientRef.current = null;
            client.disconnect();
            router.push("/");
            router.refresh();
          } else if (msg.type === "auth:failure") {
            clearTimeout(timeoutId);
            clientRef.current = null;
            client.disconnect();
            localStorage.removeItem("ccremote-token");
            setIsLoading(false);
            toast.error(msg.reason || "Authentication failed");
          }
        },
        onStatusChange: (status) => {
          if (status === "disconnected" && clientRef.current) {
            clearTimeout(timeoutId);
            clientRef.current = null;
            localStorage.removeItem("ccremote-token");
            setIsLoading(false);
            toast.error("Failed to connect to relay server");
          }
        },
      });

      clientRef.current = client;
      client.connect();
    },
    [router],
  );

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token.trim()) {
      toast.error("Please enter a token");
      return;
    }
    connectWithToken(token.trim());
  }

  // Auto-login: the CLI opens `/login#token=...` with the token in the URL
  // fragment (never sent to the server). Read it on mount, strip it from the
  // URL so it isn't left visible or in history, then validate + redirect.
  // Falls back to the manual paste form when there's no fragment token.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    if (!hash) return;
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const hashToken = params.get("token")?.trim();
    if (!hashToken) return;
    // Remove the fragment from the URL before doing anything else.
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    connectWithToken(hashToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Terminal className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl">ccremote</CardTitle>
          <CardDescription>
            Enter your authentication token to connect
          </CardDescription>
        </CardHeader>
        <form onSubmit={onSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="token">Token</Label>
              <Input
                id="token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Enter token..."
                autoFocus
              />
            </div>
            <Button className="w-full" type="submit" disabled={isLoading}>
              {isLoading ? "Connecting..." : "Connect"}
            </Button>
          </CardContent>
        </form>
      </Card>
    </div>
  );
}
