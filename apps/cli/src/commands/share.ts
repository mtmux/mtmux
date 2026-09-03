import kleur from "kleur";
import type { GrantFiles, GrantRecord, GrantSession } from "@repo/protocol";
import { isGrantActive } from "@repo/protocol";
import * as configStore from "../config-store.js";
import * as grantsStore from "../grants-store.js";
import { apiBase } from "../api.js";
import { qrLines } from "../banner.js";
import { hostPairing } from "../pairing-client.js";
import {
  brokerConnector,
  createTunnelAgent,
  localRelayConnector,
} from "../tunnel-agent.js";
import {
  buildCandidates,
  deviceLabel,
  registerDirectToken,
  sealDescriptor,
} from "./pair.js";
import { appOriginFor, joinUrl } from "./start.js";
import {
  parseDuration,
  resolveShareSessions,
  shareBanner,
} from "../share-grants.js";

const TUNNEL_READY_TIMEOUT_MS = 15_000;

export type ShareOpts = {
  session: string;
  port: number;
  api?: string;
  readOnly: boolean;
  files: GrantFiles;
  /** `24h`, `7d`, `never`, … Parsed by `parseDuration`. */
  expires: string;
  label?: string;
  qr: boolean;
};

export async function share(opts: ShareOpts): Promise<void> {
  const expiresAt = parseDuration(opts.expires);
  if (expiresAt === undefined) {
    console.error(
      kleur.red(
        `  ✗ Could not read --expires "${opts.expires}". Try 24h, 7d, or never.`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const cfg = await configStore.load();
  const base = apiBase(opts.api);
  const wanted = opts.session
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let sessions: GrantSession[];
  try {
    sessions = await resolveShareSessions(opts.port, cfg.token, opts.session);
  } catch (err) {
    console.error(kleur.red(`  ✗ ${(err as Error).message}`));
    process.exitCode = 1;
    return;
  }

  const { key } = await configStore.ensureDeviceKey();

  let announce!: (tunnelId: string) => void;
  let abandon!: (err: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    announce = resolve;
    abandon = reject;
  });

  const agent = createTunnelAgent({
    apiBase: base,
    deviceKey: key,
    connectBroker: brokerConnector(),
    connectLocal: localRelayConnector(opts.port),
    onTunnelReady: announce,
  });
  agent.start();

  const timer = setTimeout(
    () => abandon(new Error("the broker did not answer")),
    TUNNEL_READY_TIMEOUT_MS,
  );
  let tunnelId: string;
  try {
    tunnelId = await ready;
  } catch (err) {
    agent.stop();
    console.error(
      kleur.red(`  ✗ Could not open a tunnel: ${(err as Error).message}`),
    );
    process.exitCode = 1;
    return;
  } finally {
    clearTimeout(timer);
  }

  const grantId = grantsStore.newGrantId();
  const appOrigin = appOriginFor(base);

  // Almost exactly `startHosted`'s arm loop — the difference is that this one
  // registers a *grant* rather than a bare token.
  const pairing = await hostPairing({
    apiBase: base,
    buildDescriptor: () => ({
      candidates: buildCandidates(opts.port, null),
      tunnelId,
      deviceId: key.deviceId,
      publicKey: Buffer.from(key.publicKey).toString("hex"),
      label: deviceLabel(),
    }),
    seal: sealDescriptor,
  });

  const preview: GrantRecord = {
    id: grantId,
    label: opts.label ?? `Share of ${wanted.join(", ")}`,
    scope: { kind: "sessions", sessions },
    readOnly: opts.readOnly,
    files: opts.files,
    createdAt: Date.now(),
    expiresAt,
    revokedAt: null,
    tmuxServerPid: null,
    tokenHash: "0".repeat(64),
  };

  for (const line of shareBanner(preview)) console.log(line);

  const url = joinUrl(appOrigin, pairing.code);
  if (opts.qr) for (const line of qrLines(url)) console.log(`  ${line}`);
  console.log(`  ${kleur.bold(pairing.code)}`);
  console.log(kleur.dim(`  ${url}`));
  console.log();
  console.log(kleur.dim("  Waiting for them to join… Ctrl+C stops the share."));

  try {
    const result = await pairing.paired;

    const grant: GrantRecord = {
      ...preview,
      tokenHash: grantsStore.hashToken(result.keys.directToken),
      ...(result.peerDeviceId ? { peerDeviceId: result.peerDeviceId } : {}),
    };

    // Registration before the keys are admitted, for the same reason as the
    // pairing paths: the agent no longer injects the machine's token, so the
    // relay must already know this token before a frame can arrive using it.
    const registered = await registerDirectToken(
      opts.port,
      cfg.token,
      result.keys.directToken,
      grant,
    );
    if (!registered) {
      agent.stop();
      console.error(
        kleur.red(
          "  ✗ The mtmux server refused the share. Nothing was shared.",
        ),
      );
      process.exitCode = 1;
      return;
    }

    agent.addSessionKeys(result.keys);
    await grantsStore.add(grant);

    console.log();
    console.log(kleur.green(`  ✓ Shared with ${result.peerLabel}.`));
    console.log(
      kleur.dim(
        `    ${grantId} — revoke with \`mtmux share revoke ${grantId}\``,
      ),
    );
    console.log(
      kleur.dim(
        "    This process keeps the tunnel open — leave it running, or press\n" +
          "    Ctrl+C to end the share.",
      ),
    );
  } catch (err) {
    agent.stop();
    console.error(kleur.red(`  ✗ Pairing failed: ${(err as Error).message}`));
    process.exitCode = 1;
  }
}

export async function shareList(): Promise<void> {
  const grants = await grantsStore.list();
  if (grants.length === 0) {
    console.log(kleur.dim("  No shares on this machine."));
    return;
  }

  const now = Date.now();
  for (const g of grants) {
    const state = g.revokedAt
      ? kleur.dim("revoked")
      : isGrantActive(g, now)
        ? kleur.green("active")
        : kleur.dim("expired");
    const names =
      g.scope.kind === "all"
        ? "everything"
        : g.scope.kind === "recordings"
          ? `${g.scope.recordings.length} recording(s)`
          : g.scope.sessions.map((s) => s.name).join(", ");
    console.log(
      `  ${kleur.bold(g.id)}  ${state}  ${names}` +
        `  ${g.readOnly ? "read-only" : "read-write"}  files:${g.files}`,
    );
  }
}

export async function shareRevoke(
  grantId: string,
  port: number,
): Promise<void> {
  const done = await grantsStore.revoke(grantId);
  if (!done) {
    console.error(kleur.red(`  ✗ No active share called "${grantId}".`));
    process.exitCode = 1;
    return;
  }
  console.log(kleur.green(`  ✓ Revoked ${grantId}.`));
  console.log(
    kleur.dim(
      "    Any browser holding it is cut off the next time it connects, and\n" +
        "    immediately if the server is running.",
    ),
  );

  // Best-effort live revocation. The file is the record of truth; this just
  // makes it take effect without waiting for a restart.
  const cfg = await configStore.load();
  await fetch(`http://127.0.0.1:${port}/_pair/revoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.token}`,
    },
    body: JSON.stringify({ grantId }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {
    // Not running. The revocation still stands.
  });
}
