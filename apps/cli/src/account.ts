/**
 * Talking to the broker as a signed-in user.
 *
 * The CLI cannot run an OAuth redirect — there may not be a browser on this
 * machine at all, which is the whole point of a tool you run on a server. So
 * sign-in uses the device authorization grant (RFC 8628): we ask for a pair of
 * codes, show the human one, and poll until someone approves it somewhere else.
 *
 * Everything here is optional. An account buys the dashboard and more than one
 * server; without one, pairing and tunnelling work exactly the same.
 */

export type DeviceCodeGrant = {
  deviceCode: string;
  /** The short code a human reads off the terminal and types in a browser. */
  userCode: string;
  verificationUri: string;
  /** Same page with the code pre-filled — what the QR should encode. */
  verificationUriComplete?: string;
  expiresAt: number;
  /** Seconds the server wants us to wait between polls. */
  intervalSeconds: number;
};

export type Session = {
  token: string;
  userId: string;
  email: string;
  plan: string;
};

export class AccountError extends Error {}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Ask the broker to start a device authorization. */
export async function requestDeviceCode(
  apiBase: string,
): Promise<DeviceCodeGrant> {
  const res = await fetch(`${apiBase}/api/auth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: "mtmux-cli", scope: "servers" }),
  });
  const body = await readJson(res);
  if (!res.ok) {
    throw new AccountError(
      str(body.error_description) ??
        str(body.message) ??
        `Sign-in is unavailable (${res.status}).`,
    );
  }

  const deviceCode = str(body.device_code);
  const userCode = str(body.user_code);
  const verificationUri = str(body.verification_uri);
  if (!deviceCode || !userCode || !verificationUri) {
    throw new AccountError("The broker returned an unusable sign-in response.");
  }

  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 600;
  const interval = typeof body.interval === "number" ? body.interval : 5;

  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: str(body.verification_uri_complete),
    expiresAt: Date.now() + expiresIn * 1000,
    intervalSeconds: interval,
  };
}

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * Poll until the user approves, denies, or the code expires.
 *
 * `slow_down` is honoured by widening the interval permanently rather than for
 * one round — the server sends it because we are polling too fast, and going
 * straight back to the old rate would just earn another one.
 */
export async function awaitApproval(
  apiBase: string,
  grant: DeviceCodeGrant,
  signal?: AbortSignal,
): Promise<Session> {
  let intervalMs = grant.intervalSeconds * 1000;

  for (;;) {
    if (signal?.aborted) throw new AccountError("Sign-in cancelled.");
    if (Date.now() > grant.expiresAt) {
      throw new AccountError("That code expired. Run `mtmux login` again.");
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    const res = await fetch(`${apiBase}/api/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: DEVICE_GRANT,
        device_code: grant.deviceCode,
        client_id: "mtmux-cli",
      }),
      signal,
    });
    const body = await readJson(res);

    if (res.ok) {
      const token = str(body.access_token);
      if (!token) throw new AccountError("The broker returned no token.");
      return await whoami(apiBase, token);
    }

    switch (str(body.error)) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += 5000;
        continue;
      case "expired_token":
        throw new AccountError("That code expired. Run `mtmux login` again.");
      case "access_denied":
        throw new AccountError("Sign-in was declined.");
      default:
        throw new AccountError(
          str(body.error_description) ?? "Sign-in failed.",
        );
    }
  }
}

export async function whoami(apiBase: string, token: string): Promise<Session> {
  const res = await fetch(`${apiBase}/v1/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    throw new AccountError("That session has expired. Run `mtmux login`.");
  }
  if (!res.ok)
    throw new AccountError(`Could not read the account (${res.status}).`);

  const body = await readJson(res);
  return {
    token,
    userId: str(body.userId) ?? "",
    email: str(body.email) ?? "",
    plan: str(body.plan) ?? "free",
  };
}

export type RegisteredServer = {
  id: string;
  name: string;
  slug: string;
  online: boolean;
  lastSeenAt: number | null;
  platform: string | null;
  cliVersion: string | null;
};

export async function listServers(
  apiBase: string,
  token: string,
): Promise<RegisteredServer[]> {
  const res = await fetch(`${apiBase}/v1/servers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok)
    throw new AccountError(`Could not list servers (${res.status}).`);
  const body = await readJson(res);
  return Array.isArray(body.servers)
    ? (body.servers as RegisteredServer[])
    : [];
}

export type RegisterServerInput = {
  name: string;
  publicKey: string;
  hostname: string;
  platform: string;
  cliVersion: string;
};

export type RegisterServerResult =
  | {
      ok: true;
      serverId: string;
      plan: string;
      /**
       * True only on the request that began the trial.
       *
       * The broker computes this rather than the CLI inferring it from
       * `plan: "pro"`, because a paying customer is also "pro" and must not be
       * told they have just started a trial.
       */
      trialStarted: boolean;
      trialDaysLeft: number;
    }
  | { ok: false; reason: string; upgradeUrl?: string };

/**
 * Claim (or re-claim) this machine's row in the registry.
 *
 * Identified by the machine's long-lived public key rather than its name, so
 * renaming a server in the dashboard does not create a second one and a
 * reinstall that keeps `~/.mtmux` reattaches to the same row.
 *
 * A refusal is a normal outcome, not an error: a free account that already has
 * a server gets `ok: false` and an upgrade link, and `mtmux start` carries on
 * serving without an account.
 */
export async function registerServer(
  apiBase: string,
  token: string,
  input: RegisterServerInput,
): Promise<RegisterServerResult> {
  const res = await fetch(`${apiBase}/v1/servers/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  const body = await readJson(res);

  if (res.ok) {
    const trial =
      body.trial && typeof body.trial === "object"
        ? (body.trial as { justStarted?: unknown; daysLeft?: unknown })
        : {};
    return {
      ok: true,
      serverId: str(body.serverId) ?? "",
      plan: str(body.plan) ?? "free",
      trialStarted: trial.justStarted === true,
      trialDaysLeft: typeof trial.daysLeft === "number" ? trial.daysLeft : 0,
    };
  }
  return {
    ok: false,
    reason: str(body.error) ?? `Registration failed (${res.status}).`,
    upgradeUrl: str(body.upgradeUrl),
  };
}

/** Best-effort liveness ping. Never throws — a missed beat is not an outage. */
export async function heartbeat(
  apiBase: string,
  token: string,
  serverId: string,
): Promise<void> {
  await fetch(`${apiBase}/v1/servers/${serverId}/heartbeat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}
