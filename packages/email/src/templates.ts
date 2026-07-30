/**
 * The three transactional mails mtmux sends, and no others.
 *
 * Deliberately absent: the "new sign-in on a new device" notification. It is
 * the one security mail people expect, and it cannot be written without
 * rendering an IP address and a user-agent back to the account — the exact
 * identity-linked metadata invariant #2 exists to keep out of this service. A
 * mail that says "someone signed in, we won't say from where" is worse than no
 * mail, so there is none.
 */
import { layout, layoutText, oneLine, type LayoutOptions } from "./render.js";

export type EmailContent = {
  subject: string;
  html: string;
  text: string;
};

export type TemplateInput = {
  /** The account's display name. User-controlled; escaped downstream. */
  name?: string | null;
  /** The one-time link. */
  url: string;
  /** How long the link is good for, so the copy cannot drift from config. */
  expiresInMinutes: number;
};

function render(subject: string, options: LayoutOptions): EmailContent {
  return {
    subject,
    html: layout(options),
    text: layoutText(options),
  };
}

/** "Hi Ada," or nothing at all. Never "Hi ," and never "Hi undefined,". */
function greeting(name: string | null | undefined): string[] {
  const trimmed = oneLine(name ?? "");
  return trimmed ? [`Hi ${trimmed},`] : [];
}

function expiryNote(minutes: number): string {
  if (minutes < 60) return `This link expires in ${minutes} minutes.`;
  const hours = Math.round(minutes / 60);
  return `This link expires in ${hours} hour${hours === 1 ? "" : "s"}.`;
}

/**
 * Sent on sign-up. `requireEmailVerification` is off, so this never blocks
 * anyone — it is the thing that quietly sets `emailVerified`, which is what
 * later lets a Google or GitHub account link to this one without friction.
 */
export function verificationEmail(input: TemplateInput): EmailContent {
  return render("Confirm your email · mtmux", {
    preheader: "Confirm your email address to finish setting up mtmux.",
    heading: "Confirm your email",
    body: [
      ...greeting(input.name),
      "Confirming your address lets you reset your password later, and lets " +
        "you sign in with Google or GitHub using the same account.",
      "You can carry on using mtmux either way — nothing is blocked on this.",
    ],
    action: { label: "Confirm email address", url: input.url },
    footer: [
      expiryNote(input.expiresInMinutes),
      "If you didn't create an mtmux account, ignore this message.",
    ],
  });
}

/** The other half of the "Forgot password?" link, which did not exist before. */
export function passwordResetEmail(input: TemplateInput): EmailContent {
  return render("Reset your mtmux password", {
    preheader: "Choose a new password for your mtmux account.",
    heading: "Reset your password",
    body: [
      ...greeting(input.name),
      "Someone asked to reset the password for this mtmux account. If that " +
        "was you, choose a new one now.",
    ],
    action: { label: "Choose a new password", url: input.url },
    footer: [
      expiryNote(input.expiresInMinutes),
      "If it wasn't you, ignore this message — your password has not changed.",
    ],
  });
}

/**
 * The magic link, which does three jobs in one click.
 *
 * It signs you in, it needs no password, and — the part that matters most —
 * consuming it marks the address verified. That is what permanently unblocks
 * linking a Google or GitHub identity to an account that started as an
 * unverified password sign-up.
 */
export function magicLinkEmail(input: TemplateInput): EmailContent {
  return render("Your mtmux sign-in link", {
    preheader: "One click to sign in to mtmux. No password needed.",
    heading: "Sign in to mtmux",
    body: [
      ...greeting(input.name),
      "Here is your sign-in link. No password needed — and using it confirms " +
        "your email address at the same time.",
    ],
    action: { label: "Sign in to mtmux", url: input.url },
    footer: [
      expiryNote(input.expiresInMinutes),
      "It can only be used once.",
      "If you didn't ask to sign in, ignore this message.",
    ],
  });
}
