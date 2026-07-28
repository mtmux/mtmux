import { createAuthClient } from "better-auth/react";
import { deviceAuthorizationClient } from "better-auth/client/plugins";
import { env } from "@/env";

/**
 * The browser half of hosted accounts.
 *
 * Two things about this file are load-bearing and easy to get wrong:
 *
 * 1. The API is on a *different origin* from the app (`api.mtmux.com` vs
 *    `app.mtmux.com`). `fetch` defaults to `credentials: "same-origin"`, so
 *    without the explicit `credentials: "include"` below the session cookie is
 *    never sent and every authenticated call silently 401s.
 * 2. `NEXT_PUBLIC_API_URL` is legitimately absent — the CLI ships a self-hosted
 *    build that never talks to a broker. So nothing here may throw at module
 *    scope; callers check `isHostedBuild` and render an explanation instead.
 */

function normalizeBase(raw: string | undefined): string | null {
  const trimmed = raw?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : null;
}

/** The hosted broker's origin, or `null` in a self-hosted build. */
export const hostedApiUrl: string | null = normalizeBase(
  env.NEXT_PUBLIC_API_URL,
);

/** False when this build has no broker; every account page degrades on it. */
export const isHostedBuild: boolean = hostedApiUrl !== null;

export const authClient = createAuthClient({
  // better-auth appends `/api/auth` itself. When this is undefined the client
  // falls back to a same-origin `/api/auth`, which is harmless because the
  // pages guard on `isHostedBuild` before calling anything.
  baseURL: hostedApiUrl ?? undefined,
  fetchOptions: { credentials: "include" },
  plugins: [deviceAuthorizationClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;

/**
 * A failed call to the broker's own `/v1` API.
 *
 * `status` is kept because the UI branches on it: 402 means "this is a Pro
 * feature" and deserves an upgrade prompt rather than a red error, and 0 means
 * the request never reached a server at all.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type JsonRecord = Record<string, unknown>;

function messageFrom(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as JsonRecord;
  for (const key of ["error_description", "message", "error", "reason"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export type ApiFetchOptions = Omit<RequestInit, "headers" | "body"> & {
  headers?: Record<string, string>;
  /** Serialised as JSON; sets `Content-Type` for you. */
  json?: unknown;
};

/**
 * Call the broker's `/v1` API with the session cookie attached.
 *
 * Always rejects with an `ApiError` — never a bare `TypeError` from the network
 * layer — so callers have one shape to render.
 */
export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  if (!hostedApiUrl) {
    throw new ApiError("This build has no hosted account service.", 0);
  }

  const { json, headers, ...rest } = options;
  let response: Response;
  try {
    response = await fetch(`${hostedApiUrl}${path}`, {
      ...rest,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(json === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  } catch {
    throw new ApiError(
      "Could not reach mtmux. Check your connection and try again.",
      0,
    );
  }

  const body: unknown =
    response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(
      messageFrom(body) ?? `That request failed (${response.status}).`,
      response.status,
    );
  }

  return body as T;
}

/**
 * Claim a device code with the signed-in session.
 *
 * This is step one of a two-step dance and it is not optional: better-auth's
 * `/device/approve` refuses with "Device code has not been claimed by a
 * verifying session" unless `GET /device` has already run under this cookie and
 * stamped the row with our user id. It is a plain `fetch` rather than a client
 * plugin call because the plugin exposes the POST routes, not this GET.
 */
export async function claimDeviceCode(
  userCode: string,
): Promise<{ user_code: string; status: string }> {
  return apiFetch<{ user_code: string; status: string }>(
    `/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
  );
}
