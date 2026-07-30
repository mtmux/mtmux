/**
 * One HTML layout, and the escaping that makes it safe.
 *
 * Plain template strings rather than React Email. Three transactional mails
 * that are each a heading, a paragraph and a button do not justify ~40
 * transitive packages and a JSX build step in a package that has neither — and
 * email HTML is not React's problem anyway, it is a 1998 subset of HTML that
 * every framework ends up emitting by hand.
 *
 * Two rules the callers must not have to remember, so they are enforced here:
 *
 * 1. **Every interpolated value is escaped.** The display name is chosen by the
 *    person receiving the mail, but "the person receiving the mail" is not the
 *    same as "the person who typed it": sign-up takes a name before the address
 *    is verified, so `<img src=x onerror=…>` as a name is a live injection into
 *    a message delivered to someone else's inbox.
 * 2. **Every mail has a `text` part.** A single-part HTML mail scores worse
 *    with spam filters and is unreadable in a terminal client, which for this
 *    product's audience is not a hypothetical.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escape for both element text and double-quoted attribute values.
 *
 * `'` and `"` are both covered so one function is correct in both contexts —
 * having two, and picking wrong, is exactly the mistake this is guarding.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);
}

/**
 * Flatten a user-controlled string for a single-line greeting.
 *
 * Newlines in a display name would otherwise break the plain-text part's
 * layout, and a bare `\n` is enough to fake a second paragraph in a message
 * the recipient reasonably assumes we wrote.
 */
export function oneLine(value: string, max = 64): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export type LayoutOptions = {
  /** The `<title>`, and the hidden preheader most clients show in the list. */
  preheader: string;
  heading: string;
  /** Paragraphs, in order. Escaped for you. */
  body: string[];
  action: { label: string; url: string };
  /** Small print under the button. Escaped for you. */
  footer: string[];
};

/**
 * The single HTML shell every mail shares.
 *
 * Inline styles and a table for the button, because Gmail strips `<style>`
 * blocks in some contexts and Outlook's rendering engine is Word. Deliberately
 * no images, no web fonts and no external assets: nothing here needs to load
 * over the network, which keeps it readable with remote content blocked and
 * means the mail cannot be used as a read receipt.
 */
export function layout(options: LayoutOptions): string {
  const { preheader, heading, body, action, footer } = options;

  const paragraphs = body
    .map(
      (text) =>
        `      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#3f3f46;">${escapeHtml(text)}</p>`,
    )
    .join("\n");

  const notes = footer
    .map(
      (text) =>
        `      <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#71717a;">${escapeHtml(text)}</p>`,
    )
    .join("\n");

  const href = escapeHtml(action.url);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(preheader)}</title>
</head>
<body style="margin:0;padding:0;background:#fafafa;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
  <div style="max-width:520px;margin:0 auto;padding:32px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:28px 24px;">
      <p style="margin:0 0 20px;font-size:14px;font-weight:600;letter-spacing:0.02em;color:#18181b;">mtmux</p>
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:600;color:#18181b;">${escapeHtml(heading)}</h1>
${paragraphs}
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
        <tr>
          <td style="border-radius:8px;background:#18181b;">
            <a href="${href}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(action.label)}</a>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#71717a;">Or paste this into your browser:<br><span style="word-break:break-all;color:#3f3f46;">${escapeHtml(action.url)}</span></p>
${notes}
    </div>
    <p style="margin:16px 0 0;text-align:center;font-size:12px;color:#a1a1aa;">mtmux — your tmux, from any browser.</p>
  </div>
</body>
</html>`;
}

/** The plain-text twin of `layout`. Same content, no markup to escape. */
export function layoutText(options: LayoutOptions): string {
  const { heading, body, action, footer } = options;
  return [
    heading,
    "",
    ...body,
    "",
    action.label,
    action.url,
    "",
    ...footer,
    "",
    "mtmux — your tmux, from any browser.",
  ].join("\n");
}
