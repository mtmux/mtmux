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
  claimsPerMinute: process.env.API_CLAIMS_PER_MINUTE,
  mailboxesPerMinute: process.env.API_MAILBOXES_PER_MINUTE,
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
