/**
 * The shapes the rest of the broker sees.
 *
 * Kept in their own module so that `server.ts`, `broker.ts` and the tests can
 * import a type without pulling in better-auth, Drizzle and the Dodo SDK — the
 * accounts implementation is the heaviest thing in this process, and a type
 * import that dragged it in would make the no-database path pay for a feature
 * it does not use.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PlanId } from "@repo/config/plans";

export type AuthedUser = {
  id: string;
  email: string;
  name: string;
  plan: PlanId;
  /** Dodo customer, once there has been a checkout. Null before that. */
  customerId: string | null;
};

export type Decision = { allowed: boolean; reason?: string };

export type Accounts = {
  /**
   * Handle an account, auth or billing request.
   *
   * Returns false — having written nothing — when the path is not one of
   * ours, so the caller can fall through to the pairing routes.
   */
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean>;

  /** Resolve a bearer token or session cookie to a user, or null. */
  authenticate(req: IncomingMessage): Promise<AuthedUser | null>;

  /**
   * Which account owns the machine holding this Ed25519 key, or null.
   *
   * The tunnel path knows a machine only by the key it signed with, so this is
   * the single bridge from a tunnel to a plan. Null — an unregistered machine —
   * means anonymous, and anonymous is unmetered.
   */
  ownerOfDevice(publicKey: string): Promise<{ userId: string } | null>;

  /**
   * Entitlement check before opening a tunnel.
   *
   * A null user is anonymous — self-hosted, or paired without signing in — and
   * is always allowed. Accounts are an addition to this product, never a gate
   * in front of it.
   */
  checkTunnel(userId: string | null): Promise<Decision>;

  /** Entitlement check before a server trusts another browser. */
  checkDevice(userId: string | null, serverId: string): Promise<Decision>;

  /** Fold a finished tunnel session into today's aggregate. */
  recordUsage(userId: string, bytes: number, seconds: number): Promise<void>;

  /** False when there is no database and every route above is a stub. */
  readonly enabled: boolean;

  close(): Promise<void>;
};
