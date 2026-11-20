// Deciding whether a link out of a message body may be opened.
//
// Separated from the IPC handler so it can be tested: this is the last check
// between a message an unknown station sent us and shell.openExternal, which
// will act on file: URLs and, on Windows, on a good deal more than that.
//
// No Electron import, so it runs under `node --test`.

/** The only schemes a message body may cause the OS to open. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Normalises a link, or explains why it will not be opened.
 *
 * Checked here rather than only in the renderer. The renderer's parser already
 * refuses to build a link from anything but http/https, but that is a rendering
 * decision; this is the security boundary, and it must hold however the
 * renderer was persuaded to ask.
 */
export function toExternalUrl(raw: unknown): { url: string } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) {
    return { error: "That does not look like a link." };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: "That does not look like a link." };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { error: "Only web links can be opened." };
  }

  return { url: parsed.href };
}
