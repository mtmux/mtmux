/**
 * Sending, via Resend's HTTP API.
 *
 * Two decisions here, and both are the same decision twice.
 *
 * **No SDK.** The request is one `POST /emails` with a bearer token and a JSON
 * body. Wrapping that in a dependency would add a package to the tree, a
 * version to keep in step, and an entry in `apps/api/scripts/build.mjs`'s
 * externals list — for twenty lines that are not going to change. This
 * codebase already hand-rolls its router and its body reader for the same
 * reason.
 *
 * **Never throws.** `createMailer` returns `null` when there is no API key, and
 * the mailer it does return resolves `{ ok: false }` rather than rejecting.
 * That is not politeness: better-auth calls `sendVerificationEmail` inside the
 * sign-up transaction, so a throw here turns a missing key — or a Resend
 * outage — into a 500 on registration. This service already refused exactly
 * that trade once, in `dodoCreateCustomerOnSignUp`, and refuses it again here.
 * Mail is optional forever; sign-up is not.
 */
import { createLogger } from "@repo/logger";

import type { EmailContent } from "./templates.js";

const logger = createLogger("email");

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Hard ceiling on the send.
 *
 * On the sign-up path this is latency the user is waiting through, so it is
 * short: a slow provider should make the mail late, never make the account
 * creation feel broken.
 */
const TIMEOUT_MS = 10_000;

export type MailerOptions = {
  /** Resend API key. Empty means no mailer at all — see `createMailer`. */
  apiKey: string;
  /** `From` header, e.g. `mtmux <hello@mtmux.com>`. */
  from: string;
  /** Optional `Reply-To`, for people who answer transactional mail. */
  replyTo?: string;
};

export type SendResult = { ok: true } | { ok: false; error: string };

export type Mailer = {
  send(to: string, content: EmailContent): Promise<SendResult>;
};

/**
 * Build a mailer, or null when email is not configured.
 *
 * Null is a first-class, fully supported outcome — mirroring `createDodoClient`
 * — because a self-hosted broker has no Resend account and must not need one.
 * Callers branch on it; nothing gets a mailer that throws on first use.
 */
export function createMailer(options: MailerOptions): Mailer | null {
  if (!options.apiKey || !options.from) return null;

  return {
    async send(to, content) {
      try {
        const response = await fetch(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: options.from,
            to: [to],
            subject: content.subject,
            html: content.html,
            // Always both parts. A single-part HTML mail reads as spam to
            // filters and as nothing at all in a terminal client.
            text: content.text,
            ...(options.replyTo ? { reply_to: options.replyTo } : {}),
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          // The subject, not the recipient: which mail failed is operationally
          // useful, who it was for is not something this service needs in a log.
          logger.warn(
            { status: response.status, subject: content.subject },
            "Email send rejected by the provider",
          );
          return {
            ok: false,
            error: `Resend answered ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
          };
        }

        return { ok: true };
      } catch (err) {
        logger.warn(
          { err, subject: content.subject },
          "Email send failed; continuing without it",
        );
        return { ok: false, error: String(err) };
      }
    },
  };
}
