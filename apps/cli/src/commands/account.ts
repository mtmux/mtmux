import kleur from "kleur";
import openBrowser from "open";
import { apiBase } from "../api.js";
import { appOriginFor } from "./start.js";
import { qrLines } from "../banner.js";
import * as configStore from "../config-store.js";
import {
  AccountError,
  awaitApproval,
  listServers,
  requestDeviceCode,
  whoami as fetchMe,
} from "../account.js";

export type AccountOpts = { api?: string };

/** `mtmux login` — device authorization, so a headless box can still sign in. */
export async function login(opts: AccountOpts & { open?: boolean }) {
  const base = apiBase(opts.api);

  const existing = await configStore.getAccount(base);
  if (existing) {
    try {
      const me = await fetchMe(base, existing.token);
      console.log(kleur.dim(`Already signed in as ${me.email}.`));
      console.log(kleur.dim("Run `mtmux logout` first to switch accounts."));
      return;
    } catch {
      // Stale token — fall through and sign in again rather than making the
      // user work out that "already signed in" was a lie.
    }
  }

  const grant = await requestDeviceCode(base);
  const url = grant.verificationUriComplete ?? grant.verificationUri;

  console.log("");
  for (const line of qrLines(url)) console.log("  " + line);
  console.log("");
  console.log(`  Open  ${kleur.bold(grant.verificationUri)}`);
  console.log(`  Code  ${kleur.bold(grant.userCode)}`);
  console.log("");
  console.log(kleur.dim("  Waiting for approval…"));

  if (opts.open !== false) {
    await openBrowser(url).catch(() => {
      // No browser here — which is exactly the case this flow exists for.
    });
  }

  const session = await awaitApproval(base, grant);
  await configStore.setAccount({
    token: session.token,
    userId: session.userId,
    email: session.email,
    apiBase: base,
  });

  console.log("");
  console.log(kleur.green(`✓ Signed in as ${session.email}`));
  if (session.plan === "free") {
    console.log(kleur.dim("  Plan: Free — `mtmux upgrade` for more servers."));
  } else {
    console.log(kleur.dim(`  Plan: ${session.plan}`));
  }
}

export async function logout(opts: AccountOpts) {
  const base = apiBase(opts.api);
  const account = await configStore.getAccount(base);
  if (!account) {
    console.log(kleur.dim("Not signed in."));
    return;
  }
  await configStore.clearAccount();
  console.log(kleur.green("✓ Signed out."));
  console.log(
    kleur.dim("  Pairing and tunnelling still work — an account is optional."),
  );
}

export async function whoami(opts: AccountOpts) {
  const base = apiBase(opts.api);
  const account = await configStore.getAccount(base);
  if (!account) {
    console.log(kleur.dim("Not signed in.  Run `mtmux login`."));
    return;
  }
  try {
    const me = await fetchMe(base, account.token);
    console.log("");
    console.log(`  ${kleur.dim("Account")}  ${me.email}`);
    console.log(`  ${kleur.dim("Plan")}     ${me.plan}`);
    console.log(`  ${kleur.dim("Broker")}   ${base}`);
    console.log("");
  } catch (err) {
    if (err instanceof AccountError) {
      console.error(kleur.red(`✗ ${err.message}`));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

/**
 * `mtmux upgrade` — hand off to the billing portal.
 *
 * Deliberately does not try to render prices or take a payment in the terminal.
 * The authoritative price, the tax treatment and the payment methods all live
 * with the payment provider, and a number printed here would be a second source
 * of truth that goes stale silently.
 */
export async function upgrade(opts: AccountOpts & { open?: boolean }) {
  const base = apiBase(opts.api);
  const account = await configStore.getAccount(base);
  if (!account) {
    console.log(kleur.dim("Sign in first:  ") + kleur.bold("mtmux login"));
    return;
  }

  const res = await fetch(`${base}/v1/billing/checkout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${account.token}`,
    },
    body: JSON.stringify({ plan: "pro" }),
  });
  if (!res.ok) {
    console.error(kleur.red(`✗ Could not start checkout (${res.status}).`));
    process.exitCode = 1;
    return;
  }
  const body = (await res.json()) as { url?: string };
  if (!body.url) {
    console.error(kleur.red("✗ The broker returned no checkout link."));
    process.exitCode = 1;
    return;
  }

  console.log("");
  for (const line of qrLines(body.url)) console.log("  " + line);
  console.log("");
  console.log(`  ${kleur.bold(body.url)}`);
  console.log("");

  if (opts.open !== false) await openBrowser(body.url).catch(() => {});
}

function ago(at: number | null): string {
  if (!at) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export async function servers(opts: AccountOpts) {
  const base = apiBase(opts.api);
  const account = await configStore.getAccount(base);
  if (!account) {
    console.log(kleur.dim("Not signed in.  Run `mtmux login`."));
    return;
  }

  const list = await listServers(base, account.token);
  if (list.length === 0) {
    console.log("");
    console.log(kleur.dim("  No servers registered yet."));
    console.log(
      kleur.dim("  Run ") +
        kleur.bold("mtmux") +
        kleur.dim(" on a machine to add it."),
    );
    console.log("");
    return;
  }

  const nameWidth = Math.max(...list.map((s) => s.name.length), 4);
  console.log("");
  for (const server of list) {
    const dot = server.online ? kleur.green("●") : kleur.dim("○");
    const seen = server.online ? "online" : ago(server.lastSeenAt);
    console.log(
      `  ${dot} ${server.name.padEnd(nameWidth)}  ${kleur.dim(seen)}` +
        (server.platform ? kleur.dim(`  ${server.platform}`) : ""),
    );
  }
  console.log("");
  console.log(kleur.dim(`  Open them at ${appOriginFor(base)}`));
  console.log("");
}
