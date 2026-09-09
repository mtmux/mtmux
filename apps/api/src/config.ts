import { z } from "zod";

/**
 * Broker configuration. Same zod + fail-fast shape as apps/relay/src/config.ts:
 * a misconfigured broker should refuse to boot, not run with a quietly wrong
 * abuse limit.
 */
const ConfigSchema = z.object({
  port: z.coerce.number().default(14400),
  host: z.string().default("127.0.0.1"),

  corsOrigins: z
    .string()
    .default("http://localhost:14100")
    .transform((s) =>
      s
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ),

  /** Per-IP sliding windows. */
  claimsPerMinute: z.coerce.number().int().positive().default(5),
  mailboxesPerMinute: z.coerce.number().int().positive().default(10),
  discoversPerMinute: z.coerce.number().int().positive().default(30),
  upgradesPerMinute: z.coerce.number().int().positive().default(60),

  /**
   * Source-independent ceilings on claims, charged when a claim attaches its
   * socket rather than when it POSTs.
   *
   * These carry the guessing bound. A per-IP limit isolates one client, which
   * an attacker with a botnet or a CDN in front of it simply does not have to
   * be; these two apply no matter who is asking.
   *
   * The global number is derived: an attacker must never sweep the slot space
   * faster than codes are reissued, so `rate × (TTL / 60s) < SLOT_COUNT` —
   * 2000 slots and a three-minute TTL put the bound under 333/min. The
   * per-slot number is four because, with a claim burning its mailbox the
   * moment it attaches, the first attached claim on a slot ends every pairing
   * on it: nothing honest needs more. Against a 10^6 secret that is one
   * verified guess per code, which is the whole design.
   */
  slotClaimsPerMinute: z.coerce.number().int().positive().default(4),
  globalClaimsPerMinute: z.coerce.number().int().positive().default(200),

  /**
   * Oldest pairing protocol this broker answers; 0 turns the floor off.
   *
   * Empty rather than absent by default so the shipped value is
   * `MIN_PROTOCOL_VERSION` from `@repo/protocol` — the broker resolves it, not
   * this schema, because a self-hoster overriding it should not also have to
   * track what our current floor is. Set `API_MIN_PROTOCOL=0` to accept
   * everything, which is the right setting for anyone whose users cannot
   * upgrade on our schedule.
   */
  minProtocol: z
    .string()
    .default("")
    .transform((s) => (s === "" ? null : Number(s)))
    .refine((n) => n === null || (Number.isInteger(n) && n >= 0), {
      message: "API_MIN_PROTOCOL must be a non-negative integer",
    }),

  /**
   * One line shown to every running client. The advisory half of the kill
   * switch: it lets an operator warn about a bad release without shipping one.
   */
  advisory: z.string().max(256).default(""),

  /**
   * The CLI version `/v1/version` names as current. Empty says nothing.
   *
   * Deliberately not read from our own `package.json`: the broker and the CLI
   * are versioned separately and deploy on different days, so a broker that
   * inferred it would tell people to install a version npm has never seen.
   */
  latestCli: z.string().max(64).default(""),

  /** Tunnel quotas, per tunnel. */
  tunnelMaxBytes: z.coerce
    .number()
    .int()
    .positive()
    .default(1024 ** 3),
  tunnelMaxMinutes: z.coerce.number().int().positive().default(720),
  /** Concurrent streams per tunnel — a per-machine DoS bound, not a feature. */
  tunnelMaxStreams: z.coerce.number().int().positive().default(16),

  /** Phase 3 — reverse DNS and per-device certificates. Off unless set. */
  cloudflareApiToken: z.string().default(""),
  cloudflareZoneId: z.string().default(""),
  dnsZone: z.string().default(""),
  acmeEnabled: z
    .string()
    .default("false")
    .transform((s) => s.toLowerCase() === "true"),
  acmeDirectory: z
    .string()
    .default("https://acme-v02.api.letsencrypt.org/directory"),
  acmeEmail: z.string().default(""),
});

export const config = ConfigSchema.parse({
  port: process.env.API_PORT,
  host: process.env.API_HOST,
  corsOrigins: process.env.API_CORS_ORIGINS,
  minProtocol: process.env.API_MIN_PROTOCOL,
  advisory: process.env.API_ADVISORY,
  latestCli: process.env.API_LATEST_CLI,
  claimsPerMinute: process.env.API_CLAIMS_PER_MINUTE,
  mailboxesPerMinute: process.env.API_MAILBOXES_PER_MINUTE,
  discoversPerMinute: process.env.API_DISCOVERS_PER_MINUTE,
  upgradesPerMinute: process.env.API_UPGRADES_PER_MINUTE,
  slotClaimsPerMinute: process.env.API_SLOT_CLAIMS_PER_MINUTE,
  globalClaimsPerMinute: process.env.API_GLOBAL_CLAIMS_PER_MINUTE,
  tunnelMaxBytes: process.env.API_TUNNEL_MAX_BYTES,
  tunnelMaxMinutes: process.env.API_TUNNEL_MAX_MINUTES,
  tunnelMaxStreams: process.env.API_TUNNEL_MAX_STREAMS,
  cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN,
  cloudflareZoneId: process.env.CLOUDFLARE_ZONE_ID,
  dnsZone: process.env.DNS_ZONE,
  acmeEnabled: process.env.ACME_ENABLED,
  acmeDirectory: process.env.ACME_DIRECTORY,
  acmeEmail: process.env.ACME_EMAIL,
});

/** Whether the reverse-DNS feature has everything it needs. */
export const dnsEnabled =
  config.cloudflareApiToken !== "" &&
  config.cloudflareZoneId !== "" &&
  config.dnsZone !== "";

/**
 * Certificate issuance is additionally gated behind an explicit flag.
 *
 * Let's Encrypt allows 50 certificates per registered domain per week. Every
 * install wanting its own certificate blows through that immediately, so this
 * stays off until there is a rate-limit exemption or a CA with EAB. Pairing
 * and the tunnel work fine without it; only the direct path is unavailable.
 */
export const acmeReady =
  dnsEnabled && config.acmeEnabled && config.acmeEmail !== "";

if (
  process.env.NODE_ENV === "production" &&
  config.corsOrigins.some((o) => o.startsWith("http://localhost"))
) {
  throw new Error(
    "API_CORS_ORIGINS must be your production origin(s) and must not include " +
      "localhost in production.",
  );
}
