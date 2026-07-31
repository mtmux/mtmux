import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import kleur from "kleur";
import openBrowser from "open";
import * as configStore from "../config-store.js";
import * as grantsStore from "../grants-store.js";
import * as serverState from "../server-state.js";
import { banner, renderBannerLines, type PairingInvite } from "../banner.js";
import { primaryLanAddress, type LanAddress } from "../lan.js";
import { checkTmux, checkNode } from "../preflight.js";
import { serve, type RelayRuntime } from "../serve.js";
import { apiBase } from "../api.js";
import {
  createTunnelAgent,
  brokerConnector,
  localRelayConnector,
  type TunnelAgent,
} from "../tunnel-agent.js";
import {
  bytesToBase64Url,
  generateLongSecret,
  generateSecret,
} from "@repo/crypto";
import {
  hostPairing,
  PairingError,
  type HostedPairing,
  type PairingErrorKind,
} from "../pairing-client.js";
import {
  buildCandidates,
  deviceLabel,
  registerDirectToken,
  sealDescriptor,
} from "./pair.js";
import * as account from "../account.js";
import { resolveShareSessions, shareBanner } from "../share-grants.js";
import { decideAccess } from "../access-prompt.js";
import {
  createApproveControl,
  type ApproveControl,
} from "../approve-control.js";
import type { GrantFiles, GrantRecord, GrantSession } from "@repo/protocol";

// The whole CLI is bundled into dist/bin.js, so this module's own directory IS
// dist/ at runtime — not dist/commands/, which is where tsc used to put it.
// The published layout puts the web standalone server at
// dist/web/apps/web/server.js and the relay bundle at dist/relay/runtime.js.
// See apps/cli/scripts/build.mjs.
const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));

const WEB_DIR = path.resolve(DIST_DIR, "web/apps/web");
const RELAY_RUNTIME = path.resolve(DIST_DIR, "relay/runtime.js");

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const WILDCARD = new Set(["0.0.0.0", "::"]);

/** The QR code outlives the terminal scrollback; keep the nonce alive as long. */
const PAIRING_NONCE_TTL_MS = 24 * 60 * 60 * 1000;

/** How often a signed-in server tells the registry it is still here. */
const HEARTBEAT_MS = 30_000;

/** Long enough for a slow link, short enough that nobody stares at a blank screen. */
const TUNNEL_READY_TIMEOUT_MS = 15_000;

/**
 * How many times each kind of failure may mint another code.
 *
 * The rule this replaces was "anything but a silent expiry resets the budget",
 * on the reasoning that a wrong code proves somebody is at the other end. An
 * attacker is also somebody. Sweeping the slot space forces a fresh code out of
 * every live pairing and collects one guess per sweep, forever — which turns a
 * bound that is supposed to be one guess per code into an unbounded online
 * search, and no amount of extra digits fixes an unbounded search. So each
 * failure mode now spends from its own budget and **only a completed pairing
 * resets anything**.
 *
 * - `expiries` — nobody ever touched the code. Five is roughly fifteen minutes
 *   of an unwatched terminal: long enough to cover a coffee, short enough that
 *   a machine left running for a week is not quietly issuing thousands of
 *   independent draws at the secret.
 * - `wrong` — someone claimed the code and failed key confirmation. Eight, with
 *   the backoff below, is generous for a human and ruinous for a sweep.
 * - `lost` — the socket dropped. Not a guess at all; the budget is a spin-loop
 *   guard so a broker outage cannot become a reconnect storm.
 */
export type RearmLimits = {
  expiries?: number;
  wrong?: number;
  lost?: number;
};

export const REARM_LIMITS: Required<RearmLimits> = {
  expiries: 5,
  wrong: 8,
  lost: 20,
};

/**
 * Delay before the code that follows the nth wrong one.
 *
 * The first three are free, because three fumbles in a row is what a real typo
 * looks like on a phone and charging for it would make the tool feel broken.
 * From the fourth the likelier reading is a stranger, and the delay is the
 * whole defence: it is what stops a sweep collecting guesses at line rate.
 */
const WRONG_BACKOFF_MS = [0, 0, 0, 5_000, 15_000, 45_000, 120_000, 120_000];

/** The wrong-code count from which the warning stops sounding like a typo. */
const GUESSING_AT = 4;

/** Consecutive failures of each kind, since the last completed pairing. */
export type RearmState = { expiries: number; wrong: number; lost: number };

/** A fresh budget. Handed out at boot and after every successful pairing. */
export const NO_FAILURES: RearmState = { expiries: 0, wrong: 0, lost: 0 };

export type RearmWarning = "wrong-code" | "guessing" | "broker-misbehaving";

export type RearmDecision = {
  rearm: boolean;
  state: RearmState;
  /** How long to wait before arming again. */
  delayMs: number;
  /** Something the human should be told, or null for the quiet path. */
  warn: RearmWarning | null;
};

/**
 * Anything that is not a `PairingError` came from the transport rather than
 * from the protocol — a fetch that threw, a socket that refused to open.
 * Counting it as `lost` keeps it bounded and backed off. Counting it as
 * engagement, which is what the old code did, is exactly the unbounded loop
 * this function exists to close.
 */
function failureKind(err: unknown): PairingErrorKind {
  return err instanceof PairingError ? err.kind : "lost";
}

/** Whether to mint another code after a failure, and what it costs. */
export function rearmDecision(
  err: unknown,
  state: RearmState,
  limits: RearmLimits & { jitter?: () => number } = {},
): RearmDecision {
  const max = { ...REARM_LIMITS, ...limits };
  const jitter = limits.jitter ?? Math.random;

  switch (failureKind(err)) {
    case "expired": {
      const expiries = state.expiries + 1;
      return {
        rearm: expiries < max.expiries,
        state: { ...state, expiries },
        delayMs: 0,
        warn: null,
      };
    }

    // A `failed` is a broker-reported `pair:failed`, which since the burn fix
    // also covers "a claim attached and then vanished". Both mean the code was
    // spent by somebody who could not confirm, so both cost the same.
    case "no-match":
    case "failed": {
      const wrong = state.wrong + 1;
      return {
        rearm: wrong < max.wrong,
        state: { ...state, wrong },
        delayMs:
          WRONG_BACKOFF_MS[wrong - 1] ??
          WRONG_BACKOFF_MS[WRONG_BACKOFF_MS.length - 1]!,
        warn: wrong >= GUESSING_AT ? "guessing" : "wrong-code",
      };
    }

    case "lost": {
      const lost = state.lost + 1;
      const ceiling = Math.min(1_000 * 2 ** lost, 30_000);
      return {
        rearm: lost < max.lost,
        state: { ...state, lost },
        // Jittered because every agent on the service reconnects to the same
        // broker: an unjittered backoff brings them all back in lockstep and
        // knocks over the thing they were waiting for.
        delayMs: Math.round(ceiling * (0.5 + jitter() * 0.5)),
        warn: null,
      };
    }

    // The broker offered more peers than the protocol allows. That is not a
    // guess and not a network fault, so there is nothing to back off from —
    // stop, and say why.
    case "too-many-peers":
      return { rearm: false, state, delayMs: 0, warn: "broker-misbehaving" };
  }
}

function cliVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.resolve(DIST_DIR, "../package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export type StartOpts = {
  port: number;
  /** Undefined means "decide for me" — see `resolveHost`. */
  host?: string;
  token?: string;
  open: boolean;
  allowedPaths?: string;
  /** LAN and loopback only. Never contacts a broker, by choice rather than by
   * accident — which is a different thing from the tunnel merely failing. */
  local: boolean;
  qr: boolean;
  name?: string;
  api?: string;
  json: boolean;
  /**
   * Scope the printed code to these tmux sessions.
   *
   * `mtmux start --share work` is "serve this machine for me, and hand out a
   * code that only reaches `work`". Without it the code means the whole
   * machine, which is what it has always meant.
   */
  share?: string;
  shareReadOnly?: boolean;
  shareFiles?: GrantFiles;
};

/**
 * Bind the LAN by default when there is one.
 *
 * The old default of 127.0.0.1 made the phone-on-the-couch case — the entire
 * point of the tool — require a restart with `--host 0.0.0.0`. The relay
 * refuses to serve a default/empty token on a non-loopback bind, and the CLI
 * always has a 32-byte random token, so opening up the bind does not open up
 * access.
 */
export function resolveHost(
  explicitHost: string | undefined,
  lan: LanAddress | null,
): string {
  if (explicitHost) return explicitHost;
  return lan ? "0.0.0.0" : "127.0.0.1";
}

/**
 * The address to actually show people, which is never the bind address:
 * "0.0.0.0" is not somewhere you can point a browser, and the old banner
 * rewrote it to "localhost", which is wrong on every device but this one.
 */
export function resolveLanUrl(
  host: string,
  port: number,
  lan: LanAddress | null,
): string | null {
  if (LOOPBACK.has(host)) return null;
  if (WILDCARD.has(host)) return lan ? `http://${lan.address}:${port}` : null;
  return `http://${host}:${port}`;
}

/**
 * Where the browser that scans the code should land.
 *
 * This is not the broker. The broker relays sealed frames; the *app* is what
 * renders the join page and the terminal, and on the hosted service they are
 * deliberately separate origins so a compromise of one is not a compromise of
 * the other.
 *
 * The `api.` → `app.` swap covers that hosted naming. It cannot cover a
 * self-hosted deployment, where the two origins are whatever the operator
 * chose — hence the override, which is the only way a self-hoster can print a
 * QR that points at their own app. Falling back to the broker origin is the
 * least-wrong default: a single-origin deployment serves both from there, and
 * anything else is unguessable.
 */
export function appOriginFor(base: string, env = process.env): string {
  const override = env.MTMUX_APP_URL;
  if (override) return override.replace(/\/+$/, "");
  if (base.includes("//api.")) return base.replace("//api.", "//app.");
  return base;
}

/** What the QR encodes. The code rides in the fragment, so it never reaches a server. */
export function joinUrl(appOrigin: string, code: string): string {
  return `${appOrigin}/j#${code}`;
}

type Hosted = {
  agent: TunnelAgent;
  invite: PairingInvite;
  /** Mint a code on demand, after arming has gone idle. */
  rearm: () => Promise<PairingInvite>;
  stop: () => void;
};

/**
 * The two halves of an invite.
 *
 * `typed` is the digits a human reads off the screen; `scan` is the QR's
 * 128-bit secret. They were once armed and re-armed as a unit, which stopped
 * being right the moment they got separate slot spaces: a sweep of the typed
 * slots kills the typed code and never touches the scanned one, and a shared
 * fate would leave the machine silent until the untouched half timed out.
 */
type HalfKind = "typed" | "scan";

/** Why a fresh code appeared, so the CLI can say something true about it. */
export type RearmReason = "paired" | "expired" | "wrong-code" | "lost";

/** What the human is told when a half fails, before the replacement arrives. */
export type RearmNotice = {
  warning: RearmWarning;
  /** Which half failed. Only `typed` can be meaningfully guessed at. */
  half: HalfKind;
  /** Consecutive wrong codes for this half, for "wrong code again (4)". */
  wrong: number;
  /** How long until the replacement. */
  delayMs: number;
};

/**
 * Bring up the tunnel and arm a pairing code.
 *
 * Ordering matters: the tunnel must be registered before a code is offered,
 * because the descriptor the CLI seals at the end of the handshake has to name
 * a tunnel that already exists. Arming the code first would produce a race in
 * which a very fast phone pairs against a tunnel id that is still undefined.
 */
/**
 * The approval window, once `start` has bound the server.
 *
 * Module-level because the two halves live in different functions and start in
 * a fixed order: `startHosted` creates the tunnel agent — and with it
 * `onAccessRequest` — before `start` binds the port the control plane listens
 * on. A parameter would mean either reordering the boot or handing the agent a
 * value that is still null when it is captured.
 */
let approvals: ApproveControl | null = null;

async function startHosted(opts: {
  port: number;
  base: string;
  cfg: configStore.Config;
  tunnelOnly: boolean;
  /**
   * Scope every code this loop arms, for `mtmux start --share`.
   *
   * A function rather than a value because a fresh grant id is minted per
   * pairing — two people who scan the same-shaped share still get separately
   * revocable credentials, which is the whole point of `share revoke`.
   */
  buildGrant?: (directToken: string) => GrantRecord;
  onPaired: (label: string) => void;
  onRearm: (invite: PairingInvite, reason: RearmReason) => void;
  /**
   * A half failed in a way worth saying out loud, and its replacement is
   * `delayMs` away. Fires before the delay, so the terminal is never silent
   * for two minutes with no explanation.
   */
  onWarn?: (notice: RearmNotice) => void;
  /**
   * Every code has expired untouched and no more will be minted until the user
   * asks. Undefined means the caller does not care and arming simply stops.
   */
  onIdle?: () => void;
}): Promise<Hosted> {
  const { key } = await configStore.ensureDeviceKey();

  // The agent signals readiness through a callback rather than a promise, so
  // wrap it in one — nothing below can run until the tunnel has an id.
  let announce!: (tunnelId: string) => void;
  let abandon!: (err: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    announce = resolve;
    abandon = reject;
  });

  const agent = createTunnelAgent({
    apiBase: opts.base,
    deviceKey: key,
    connectBroker: brokerConnector(),
    connectLocal: localRelayConnector(opts.port),
    onTunnelReady: announce,
    /**
     * A signed-in browser asking to be let in.
     *
     * Everything cryptographic has already happened by the time this runs; all
     * that is left is to show a human six digits and do as they say. Approving
     * then follows exactly the same path a scanned code does — register the
     * derived token with the relay, admit the keys, remember the peer — so a
     * requested pairing and a scanned one produce an identical session.
     */
    onAccessRequest: async (request) => {
      // An open `mtmux approve` window decides; otherwise the TTY prompt;
      // otherwise `no-tty`. See `decideAccess` for why "nobody is waiting" and
      // "they said no" must stay distinguishable.
      const answer = await decideAccess(request, {
        offer: approvals ? (req) => approvals!.offer(req) : undefined,
      });
      if (!answer.approved) {
        // Logged locally so a refusal leaves a trace on the machine that
        // refused it. The broker is told nothing beyond "denied".
        console.log(
          kleur.dim(
            `    Refused an access request from ${request.accountEmail}.`,
          ),
        );
        return { approved: false, reason: answer.reason };
      }

      // Registration before admission, for the same reason as the code path:
      // admitting the keys first lets the browser authenticate against a relay
      // that has never heard of its token.
      const registered = await registerDirectToken(
        opts.port,
        opts.cfg.token,
        request.keys.directToken,
      );
      if (!registered) {
        console.log(
          kleur.red("  ✗ Could not register the session. Nothing was shared."),
        );
        return { approved: false, reason: "refused" };
      }

      const sealed = await sealDescriptor(request.keys, {
        candidates: opts.tunnelOnly ? [] : buildCandidates(opts.port, null),
        tunnelId: await ready,
        deviceId: key.deviceId,
        publicKey: Buffer.from(key.publicKey).toString("hex"),
        label: deviceLabel(),
      });

      agent.addSessionKeys(request.keys);
      await configStore.addPeer({
        deviceId: `browser-${Date.now().toString(36)}`,
        publicKey: "",
        label: request.deviceLabel,
        pairedAt: Date.now(),
        lastSeenAt: Date.now(),
        directToken: request.keys.directToken,
      });
      console.log(kleur.green(`  ✓ ${request.deviceLabel} connected.`));

      return { approved: true, sealedDescriptor: bytesToBase64Url(sealed) };
    },
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
    // Leave nothing retrying in the background once we have given up on it.
    agent.stop();
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const appOrigin = appOriginFor(opts.base);

  /**
   * Failure budgets, one set per half.
   *
   * Per-half because the halves stopped sharing a fate once the QR got its own
   * slot space. A sweep of the two-digit typed space kills typed codes and
   * cannot touch a four-digit scan slot, so a shared counter would either bill
   * the QR for the typed code's attacker or let the typed code coast on the
   * QR's silence. See `rearmDecision` for why nothing but a completed pairing
   * resets these.
   */
  const failures: Record<HalfKind, RearmState> = {
    typed: { ...NO_FAILURES },
    scan: { ...NO_FAILURES },
  };

  /**
   * The scan half's secret is 128 bits, so a failure there is never a guess —
   * it is a claim that could not confirm, i.e. a bug or a stray client. The
   * budget exists only so a misbehaving peer cannot spin the loop.
   */
  const limitsFor = (half: HalfKind): RearmLimits =>
    half === "scan" ? { wrong: 20 } : {};

  /** The live pairing behind each half, or null once it has stopped arming. */
  const live: Record<HalfKind, HostedPairing | null> = {
    typed: null,
    scan: null,
  };

  /**
   * Which round each wired half belongs to.
   *
   * A successful pairing ends the round and cancels the other half, whose
   * rejection then lands a microtask later. Without a token to check against,
   * that late rejection would be read as a failure of the *new* round and
   * re-arm on top of a code that had just been printed. This is the same job
   * the old `decided` flag did, done in a way that survives the round being
   * restarted immediately.
   */
  let round = 0;

  /** Timers for delayed re-arms, so `stop()` does not leave one pending. */
  const pending = new Set<NodeJS.Timeout>();

  const hostOpts = () => ({
    apiBase: opts.base,
    buildDescriptor: () => {
      // Read through to the agent rather than closing over the id captured at
      // boot: `createTunnelAgent` reconnects on its own and comes back with a
      // new id, so a code re-armed after a broker restart would otherwise seal
      // a descriptor naming a tunnel that no longer exists — the browser pairs
      // successfully and then cannot connect to anything.
      const id = agent.tunnelId;
      if (id === null) throw new PairingError("The tunnel is not connected.");
      return {
        candidates: opts.tunnelOnly ? [] : buildCandidates(opts.port, null),
        tunnelId: id,
        deviceId: key.deviceId,
        publicKey: Buffer.from(key.publicKey).toString("hex"),
        label: deviceLabel(),
      };
    },
    seal: sealDescriptor,
  });

  const inviteNow = (): PairingInvite => ({
    code: live.typed?.code ?? null,
    // The QR carries the long secret; only `code` is meant to be read aloud.
    url: live.scan ? joinUrl(appOrigin, live.scan.code) : null,
    host: appOrigin.replace(/^https?:\/\//, ""),
  });

  /**
   * Park one half's mailbox and wire up what happens when it settles.
   *
   * Two mailboxes rather than one, because a mailbox commits to a single CPace
   * password the moment it answers a claim — so a typed secret and a 128-bit
   * one cannot share it. They are raced: whichever is claimed first wins the
   * round and the other is cancelled, which destroys its mailbox immediately
   * rather than leaving a live code nobody is watching.
   *
   * The point of the pair is that scanning a QR is not typing. Nobody reads a
   * 128-bit secret off a screen, so there is no reason for the path almost
   * everyone uses to carry the entropy of the fallback.
   */
  const armHalf = async (half: HalfKind): Promise<HostedPairing> => {
    const myRound = round;
    const pairing = await hostPairing({
      ...hostOpts(),
      secret: half === "typed" ? generateSecret() : generateLongSecret(),
      space: half,
    });
    live[half] = pairing;

    void pairing.paired
      .then(async (result) => {
        if (myRound !== round) return;
        round += 1;
        // The round is over, so the sibling code must stop being claimable.
        const other: HalfKind = half === "typed" ? "scan" : "typed";
        live[other]?.cancel();
        live.typed = null;
        live.scan = null;

        // Registration BEFORE the agent will admit the keys, and this order is
        // load-bearing now that the tunnel agent no longer injects the
        // machine's own token. Admitting the keys first opens a window in
        // which the browser can win the race, send its `auth` frame down the
        // tunnel, and be refused because the relay has never been told about
        // that token. A failure here must therefore *not* admit the keys.
        const grant = opts.buildGrant?.(result.keys.directToken);
        const registered = await registerDirectToken(
          opts.port,
          opts.cfg.token,
          result.keys.directToken,
          grant,
        );
        // A scoped pairing that could not be registered must not be admitted:
        // the alternative is a browser that authenticates against a relay
        // which has never heard of its token, and so falls through to nothing.
        if (grant && !registered) {
          console.log(
            kleur.red("  ✗ Could not register the share. Nothing was shared."),
          );
          return;
        }
        agent.addSessionKeys(result.keys);
        if (grant) await grantsStore.add(grant);
        await configStore.addPeer({
          deviceId: result.peerDeviceId ?? `browser-${Date.now().toString(36)}`,
          publicKey: result.peerPublicKey ?? "",
          label: result.peerLabel,
          pairedAt: Date.now(),
          lastSeenAt: Date.now(),
          directToken: result.keys.directToken,
        });
        opts.onPaired(result.peerLabel);
        // The one thing that clears the budgets: a pairing that completed.
        failures.typed = { ...NO_FAILURES };
        failures.scan = { ...NO_FAILURES };
        opts.onRearm(await armRound(), "paired");
      })
      .catch((err: unknown) => {
        if (myRound !== round) return;
        live[half] = null;

        const decision = rearmDecision(err, failures[half], limitsFor(half));
        failures[half] = decision.state;

        if (decision.warn) {
          opts.onWarn?.({
            warning: decision.warn,
            half,
            wrong: decision.state.wrong,
            delayMs: decision.rearm ? decision.delayMs : 0,
          });
        }

        if (!decision.rearm) {
          // Nothing left to claim on either half — the invite is spent, and
          // only a human may bring it back. On a machine with no TTY that is
          // simply where arming stops, which is the fail-closed direction.
          if (!live.typed && !live.scan) opts.onIdle?.();
          return;
        }

        const reason: RearmReason =
          decision.warn === null ? failureKindReason(err) : "wrong-code";
        const again = () => {
          void armHalf(half)
            .then(() => opts.onRearm(inviteNow(), reason))
            .catch((armErr: unknown) => {
              // Arming itself failed — a 503, a dead tunnel. Say so and try
              // again on the same budget rather than going quiet with no code.
              console.log(
                kleur.yellow(
                  `  ! Could not get a fresh code (${(armErr as Error).message}).`,
                ),
              );
              scheduleRearm(REARM_RETRY_MS);
            });
        };
        const scheduleRearm = (delayMs: number) => {
          if (delayMs <= 0) {
            again();
            return;
          }
          const timer = setTimeout(() => {
            pending.delete(timer);
            again();
          }, delayMs);
          timer.unref();
          pending.add(timer);
        };
        scheduleRearm(decision.delayMs);
      });

    return pairing;
  };

  /** Arm both halves as one fresh round. */
  const armRound = async (): Promise<PairingInvite> => {
    await Promise.all([armHalf("typed"), armHalf("scan")]);
    return inviteNow();
  };

  const invite = await armRound();
  return {
    agent,
    invite,
    /** Mint a code on demand, after arming has gone idle. */
    rearm: async () => {
      round += 1;
      failures.typed = { ...NO_FAILURES };
      failures.scan = { ...NO_FAILURES };
      live.typed?.cancel();
      live.scan?.cancel();
      live.typed = null;
      live.scan = null;
      return armRound();
    },
    stop: () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
      agent.stop();
    },
  };
}

/** How long to wait before retrying an arm that failed outright. */
const REARM_RETRY_MS = 10_000;

/** The dim line above a replacement code, chosen by what killed the last one. */
const REARM_LINES: Record<RearmReason, string> = {
  paired: "Here's a fresh code for the next device:",
  expired: "That code expired. Here's another:",
  "wrong-code": "Here's the fresh code:",
  lost: "Reconnected. Here's a fresh code:",
};

/** The reason wording for a failure that carried no warning of its own. */
function failureKindReason(err: unknown): RearmReason {
  return err instanceof PairingError && err.kind === "expired"
    ? "expired"
    : "lost";
}

/**
 * Re-admit every device that has paired with this machine before.
 *
 * The relay holds session tokens in memory, so without this a restart silently
 * un-pairs every phone that ever connected — and "restart" includes a deploy, a
 * crash and a reboot. Replaying the tokens we already negotiated turns a paired
 * device into what the word implies: trusted until revoked.
 *
 * Expired and revoked peers are skipped, and a failure is ignored — the device
 * simply pairs again, which is the pre-existing behaviour.
 */
async function restoreTrustedDevices(
  port: number,
  authToken: string,
): Promise<{ restored: number; needRepair: number }> {
  const peers = await configStore.listPeers();
  let restored = 0;
  let needRepair = 0;
  for (const peer of peers) {
    if (configStore.isPeerExpired(peer)) continue;
    if (!peer.directToken) {
      // Paired before `directToken` was stored. These used to work over the
      // tunnel *only* because the agent injected the machine's own token on
      // the loopback socket — which is the hole that scoping closes, so they
      // genuinely have no credential now. One-time, and re-pairing is six
      // digits, but it must be said out loud rather than failing silently.
      needRepair += 1;
      continue;
    }
    if (await registerDirectToken(port, authToken, peer.directToken)) {
      restored += 1;
    }
  }
  return { restored, needRepair };
}

/**
 * Keep the registry's view of this machine fresh.
 *
 * Every failure is swallowed. A machine whose owner's card expired, or whose
 * network dropped, must keep serving its own terminal — the registry is a
 * convenience layered on top, never a licence check.
 */
function startHeartbeat(
  base: string,
  token: string,
  serverId: string,
): () => void {
  const timer = setInterval(() => {
    void account.heartbeat(base, token, serverId);
  }, HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

async function registerWithAccount(
  base: string,
  name: string,
  publicKey: string,
): Promise<(() => void) | null> {
  const signedIn = await configStore.getAccount(base);
  if (!signedIn) return null;

  try {
    const result = await account.registerServer(base, signedIn.token, {
      name,
      publicKey,
      hostname: os.hostname(),
      platform: `${process.platform}-${process.arch}`,
      cliVersion: cliVersion(),
    });
    if (!result.ok) {
      console.log(kleur.yellow(`  ! ${result.reason}`));
      if (result.upgradeUrl) {
        console.log(kleur.dim(`    ${result.upgradeUrl}`));
      }
      return null;
    }
    if (result.trialStarted) {
      // The most important line of copy in this feature. What someone hits
      // here used to be a 402 telling them to get out a card; it is now this.
      console.log(
        kleur.green(
          `  ✓ Started your ${result.trialDaysLeft}-day Pro trial — no card needed.`,
        ),
      );
    }
    await configStore.setAccount({ ...signedIn, serverId: result.serverId });
    return startHeartbeat(base, signedIn.token, result.serverId);
  } catch {
    // Being signed in must never be worse than being anonymous.
    return null;
  }
}

export async function start(opts: StartOpts) {
  checkNode();
  await checkTmux();

  const version = cliVersion();
  const lan = primaryLanAddress();
  const host = resolveHost(opts.host, lan);
  const base = apiBase(opts.api);

  const cfg = opts.token ? { token: opts.token } : await configStore.load();
  // Relay reads these on first import. Set BEFORE we import relay modules.
  process.env.AUTH_TOKEN = cfg.token;
  process.env.ALLOWED_PATHS =
    opts.allowedPaths ??
    process.env.ALLOWED_PATHS ??
    process.env.HOME ??
    process.cwd();
  (process.env as Record<string, string>).NODE_ENV = "production";
  process.env.RELAY_HOST = host;
  process.env.RELAY_PORT = String(opts.port);
  // Single-origin in CLI mode — no cross-origin requests possible. Set the
  // CORS allow-list to empty so the relay's prod gate doesn't reject the
  // localhost default.
  if (process.env.CORS_ORIGINS === undefined) process.env.CORS_ORIGINS = "";

  const [relay, nextMod] = await Promise.all([
    import(RELAY_RUNTIME) as Promise<RelayRuntime>,
    import("next"),
  ]);

  const nextFactory = (
    nextMod as unknown as { default: typeof import("next").default }
  ).default;
  const app = nextFactory({ dev: false, dir: WEB_DIR });
  await app.prepare();

  /**
   * The loopback control plane for `mtmux approve`.
   *
   * Created before `serve` because the handler is wired into it, and reached by
   * `onAccessRequest` above — which is why it is defined here rather than
   * inside the tunnel agent's options.
   */
  const approveControl = createApproveControl({ authToken: cfg.token });
  approvals = approveControl;

  const { shutdown: stopServing } = await serve({
    relay,
    requestHandler: app.getRequestHandler(),
    port: opts.port,
    host,
    portHintCommand: "mtmux start",
    controlHandler: (req, res) => approveControl.handle(req, res),
  });

  const localUrl = `http://localhost:${opts.port}`;
  const lanUrl = resolveLanUrl(host, opts.port, lan);

  const { restored, needRepair } = await restoreTrustedDevices(
    opts.port,
    cfg.token,
  );

  // Tokenless LAN sign-in only makes sense for a *different* device, so the
  // nonce is armed exactly when there is an address such a device could reach.
  const armLanNonce = () =>
    lanUrl
      ? `${lanUrl}/login#n=${relay.issuePairingNonce(PAIRING_NONCE_TTL_MS).nonce}`
      : null;

  let hosted: Hosted | null = null;
  let note: string | null = null;

  const lanInterface = WILDCARD.has(host) ? (lan?.iface ?? null) : null;

  const record = (inviteUrl: string | null): serverState.ServerState => ({
    pid: process.pid,
    port: opts.port,
    host,
    localUrl,
    lanUrl,
    mode: hosted ? "tunnel" : "local",
    inviteUrl,
    startedAt: Date.now(),
    version,
  });

  const reprint = (invite: PairingInvite) => {
    for (const line of renderBannerLines({
      version,
      localUrl,
      lanUrl,
      lanInterface,
      invite,
      showQr: opts.qr,
      token: cfg.token,
      note,
    })) {
      console.log(line);
    }
  };

  // Resolved once, before any code is armed, so a typo in --share is a clean
  // refusal rather than a code that turns out to grant nothing.
  let shareSessions: GrantSession[] | null = null;
  if (opts.share) {
    try {
      shareSessions = await resolveShareSessions(
        opts.port,
        cfg.token,
        opts.share,
      );
    } catch (err) {
      console.error(kleur.red(`  ✗ ${(err as Error).message}`));
      await stopServing();
      process.exitCode = 1;
      return;
    }
  }

  const buildGrant = shareSessions
    ? (directToken: string): GrantRecord => ({
        id: grantsStore.newGrantId(),
        label: `start --share ${opts.share ?? ""}`.trim(),
        scope: { kind: "sessions", sessions: shareSessions },
        readOnly: opts.shareReadOnly === true,
        files: opts.shareFiles ?? "none",
        createdAt: Date.now(),
        expiresAt: null,
        revokedAt: null,
        tmuxServerPid: null,
        tokenHash: grantsStore.hashToken(directToken),
      })
    : undefined;

  if (shareSessions && !opts.json) {
    for (const line of shareBanner({
      id: "grn_preview",
      label: "",
      scope: { kind: "sessions", sessions: shareSessions },
      readOnly: opts.shareReadOnly === true,
      files: opts.shareFiles ?? "none",
      createdAt: Date.now(),
      expiresAt: null,
      revokedAt: null,
      tmuxServerPid: null,
      tokenHash: "0".repeat(64),
    })) {
      console.log(line);
    }
  }

  /**
   * Wait for a keypress, then mint one more code.
   *
   * Only ever armed after `onIdle`, so the common path never touches stdin. A
   * non-interactive process — a service unit, a CI run — has nobody to press
   * anything, so it simply stops arming, which is the safe direction: the whole
   * point is that an unwatched terminal stops issuing draws at the secret.
   */
  const waitForRearm = () => {
    if (!process.stdin.isTTY) return;
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      void hosted
        ?.rearm()
        .then((invite) => {
          reprint(invite);
          void serverState.write(record(invite.url)).catch(() => {});
        })
        .catch(() => {});
    });
  };

  if (!opts.local) {
    try {
      hosted = await startHosted({
        buildGrant,
        port: opts.port,
        base,
        cfg,
        tunnelOnly: false,
        onPaired: (label) => {
          console.log(kleur.green(`  ✓ ${label} connected.`));
        },
        onWarn: (notice) => {
          if (notice.warning === "broker-misbehaving") {
            console.log(
              kleur.red(
                "  ! The pairing service offered more terminals than it should.",
              ),
            );
            console.log(
              kleur.dim(
                "    Stopped arming rather than risk pairing with the wrong one.",
              ),
            );
            return;
          }
          // Under four, the likeliest reading is a fumble on a phone keyboard,
          // and saying anything heavier would be crying wolf at a typo.
          if (notice.warning === "wrong-code") {
            console.log(
              kleur.yellow(
                "  ! Someone entered a wrong code. That one is now dead.",
              ),
            );
            console.log(
              kleur.dim("    Here's a fresh one — the old code will not work."),
            );
            return;
          }
          // From the fourth, a stranger is likelier than a fumble. Say so, and
          // name the delay so the pause reads as deliberate rather than broken.
          console.log(
            kleur.yellow(
              `  ! Wrong code again (${notice.wrong}). If that wasn't you, someone is guessing.`,
            ),
          );
          console.log(
            kleur.dim(
              `    Slowing down — next code in ${Math.round(notice.delayMs / 1000)}s.`,
            ),
          );
        },
        onRearm: (invite, reason) => {
          console.log(kleur.dim(`    ${REARM_LINES[reason]}`));
          reprint(invite);
          void serverState.write(record(invite.url)).catch(() => {});
        },
        onIdle: () => {
          console.log(
            kleur.dim(
              "    No one used the last few codes, so I've stopped making them.",
            ),
          );
          console.log(kleur.dim("    Press enter for a new code."));
          waitForRearm();
        },
      });
    } catch (err) {
      // The tunnel is a convenience, not a dependency. An offline machine, a
      // blocked outbound connection or a broker outage must all land here and
      // leave a working LAN server behind — this is what keeps `mtmux start`
      // identical to its self-hosted behaviour when our servers are absent.
      note =
        `Tunnel unavailable (${(err as Error).message}). ` +
        `Serving locally — retry later or use --local to skip this.`;
    }
  }

  const lanQrPayload = hosted ? null : armLanNonce();

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          version,
          localUrl,
          lanUrl,
          mode: hosted ? "tunnel" : "local",
          code: hosted?.invite.code ?? null,
          joinUrl: hosted?.invite.url ?? null,
          trustedDevices: restored,
          token: cfg.token,
          note,
        },
        null,
        2,
      ),
    );
  } else {
    banner({
      version,
      localUrl,
      lanUrl,
      lanInterface,
      invite: hosted?.invite ?? null,
      lanQrPayload,
      showQr: opts.qr,
      token: cfg.token,
      note,
    });
  }

  if (restored > 0 && !opts.json) {
    console.log(
      kleur.dim(
        `  ${restored} device${restored === 1 ? "" : "s"} already trusted — ` +
          `${restored === 1 ? "it does" : "they do"} not need the code.`,
      ),
    );
    console.log("");
  }

  if (needRepair > 0 && !opts.json) {
    // Said plainly rather than left to fail as a mysterious auth error the
    // next time someone opens the tab on that device.
    console.log(
      kleur.yellow(
        `  ${needRepair} device${needRepair === 1 ? "" : "s"} need${needRepair === 1 ? "s" : ""} to pair again (one-time).`,
      ),
    );
    console.log(
      kleur.dim("    They were paired before mtmux stored a per-device token."),
    );
    console.log("");
  }

  await serverState.write(record(hosted?.invite.url ?? null));

  // A LAN nonce is single-use, so once a phone has signed in the code on screen
  // is spent. Mint another and reprint rather than leaving a dead QR up.
  if (!hosted && lanUrl) {
    relay.onPairingRedeemed(() => {
      console.log(kleur.green("  ✓ Device signed in."));
      console.log(kleur.dim("    Here's a fresh code for the next one:"));
      for (const line of renderBannerLines({
        version,
        localUrl,
        lanUrl,
        lanInterface,
        lanQrPayload: armLanNonce(),
        showQr: opts.qr,
        token: cfg.token,
      })) {
        console.log(line);
      }
    });
  }

  const { key } = await configStore.ensureDeviceKey();
  const stopHeartbeat = await registerWithAccount(
    base,
    opts.name ?? cfg.serverName ?? os.hostname(),
    Buffer.from(key.publicKey).toString("hex"),
  );
  if (opts.name) await configStore.setServerName(opts.name);

  if (opts.open) {
    // Auto-open with the token in the URL *fragment* (never the query): the
    // fragment is never sent to the server or logged, and the login page reads
    // it on mount to auto-authenticate — no manual copy-paste.
    const openUrl = `${localUrl}/login#token=${encodeURIComponent(cfg.token)}`;
    await openBrowser(openUrl).catch(() => {});
  }

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.log("\n  Stopping…");
    stopHeartbeat?.();
    approveControl.close();
    hosted?.stop();
    void serverState.clear();
    stopServing();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
