// Pure Telegram formatting helpers (no side effects). Reused verbatim from v1/v2's proven logic -
// these solved real, specific Telegram quirks and are not worth re-deriving.

// Telegram rejects any single message over this length with 400 MESSAGE_TOO_LONG, so a long reply
// must be split before sending.
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Split text into Telegram-sized chunks, preferring to break on newlines rather than mid-line. */
export function splitForTelegram(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Whether to send a chunk with Markdown parsing. Operational messages carrying URLs (PR/issue
 * links, repo names with underscores) get mangled by Telegram's Markdown - "Target_Repo" italicises
 * and the link breaks. Telegram auto-links bare URLs anyway, so anything containing a URL is sent as
 * plain text; only conversational replies (with intentional bold/italic) go through Markdown.
 */
export function shouldUseMarkdown(text: string): boolean {
  return !/https?:\/\//.test(text);
}

/**
 * Normalise GitHub-style Markdown (which the model naturally emits) into the subset Telegram's
 * legacy Markdown actually renders. Telegram bold is SINGLE asterisks (*bold*), so double-asterisk
 * **bold** and double-underscore __bold__ show literal asterisks instead of bolding - the reported
 * "headings between two * never go bold" bug. Headings (#, ##, ...) aren't supported at all, so they
 * become a bold line. Single *word* / _word_ are left untouched. Applied before sending; the plain
 * single markers that remain are also tidier if the reply falls back to plain text.
 */
export function toTelegramMarkdown(text: string): string {
  return text
    // Headings: "## Title" -> "*Title*" (strip the #s, bold the heading text).
    .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm, "*$1*")
    // Double-asterisk and double-underscore bold -> single-asterisk bold.
    .replace(/\*\*(.+?)\*\*/gs, "*$1*")
    .replace(/__(.+?)__/gs, "*$1*");
}
