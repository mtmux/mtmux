/**
 * Transactional email for the hosted broker.
 *
 * Everything here is optional. With no `RESEND_API_KEY` there is no mailer,
 * the magic-link plugin is never mounted, and the UI never offers a button
 * that would silently do nothing. A self-hosted mtmux sends no mail and needs
 * no account with anybody.
 */
export { escapeHtml, layout, layoutText, oneLine } from "./render.js";
export type { LayoutOptions } from "./render.js";
export {
  magicLinkEmail,
  passwordResetEmail,
  verificationEmail,
} from "./templates.js";
export type { EmailContent, TemplateInput } from "./templates.js";
export { createMailer } from "./mailer.js";
export type { Mailer, MailerOptions, SendResult } from "./mailer.js";
