// Winlink message bodies, turned into something renderable.
//
// Bodies are PLAIN TEXT. Pat also exposes a BodyHTML field, but that is not the
// message -- it is HTML Pat generates from this same text (api/mailbox.go:383),
// escaping < and > along the way so no original markup can survive. There is
// therefore no untrusted HTML document anywhere in a Winlink message, and
// nothing to sanitise.
//
// So WL2GO parses the text itself and renders React elements from the result.
// Nothing here produces markup, which means no dangerouslySetInnerHTML, no
// sandboxed iframe, no CSP carve-out and no sanitiser dependency -- and no loss,
// because the structure Pat infers is inferable from the same characters.
//
// Pure and in shared/ so it is testable under `node --test`; .tsx files cannot
// be type-stripped and so cannot be unit tested here.

/** One run of body text: either plain, or a URL worth making clickable. */
export type BodyInline =
  | { kind: "text"; text: string }
  | { kind: "link"; href: string; text: string };

export interface BodyParagraph {
  /**
   * How many ">" levels this paragraph is quoted at. Zero is unquoted.
   *
   * Winlink replies quote with ">" the way mail has since long before HTML,
   * and nested quotes are common on a net with several relays.
   */
  quoteDepth: number;
  /**
   * The paragraph's lines, each already split into runs.
   *
   * Kept as separate lines rather than reflowed into one: Winlink traffic is
   * full of hand-aligned tables, position reports and forms whose whitespace is
   * load-bearing. Rewrapping them would destroy the message's meaning.
   */
  lines: BodyInline[][];
}

/** Trailing characters that are far more likely sentence punctuation than URL. */
const TRAILING_PUNCTUATION = /[.,;:!?'"“”‘’)\]}>]+$/;

/**
 * Matches a bare URL.
 *
 * Deliberately narrow: only http/https, or a bare www. that we can safely
 * promote to https. Anything else -- file:, javascript:, data: -- is left as
 * plain text and never becomes a link, so the renderer has no way to be handed
 * a scheme it should not open. Main validates the scheme again before opening.
 */
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;

function hrefFor(match: string): string | null {
  const href = /^www\./i.test(match) ? `https://${match}` : match;
  // Parsed rather than pattern-matched, so a malformed URL is text, not a link.
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Splits one line into plain runs and links. */
export function parseInline(line: string): BodyInline[] {
  const runs: BodyInline[] = [];
  let cursor = 0;

  // Fresh lastIndex per call: the regex is module-level and /g is stateful.
  URL_PATTERN.lastIndex = 0;

  for (let match = URL_PATTERN.exec(line); match !== null; match = URL_PATTERN.exec(line)) {
    let text = match[0];

    // "See https://example.org." should link the URL, not the full stop.
    const trimmed = text.replace(TRAILING_PUNCTUATION, "");
    if (trimmed !== text) {
      URL_PATTERN.lastIndex -= text.length - trimmed.length;
      text = trimmed;
    }

    const href = hrefFor(text);
    if (!href) continue;

    if (match.index > cursor) {
      runs.push({ kind: "text", text: line.slice(cursor, match.index) });
    }
    runs.push({ kind: "link", href, text });
    cursor = match.index + text.length;
  }

  if (cursor < line.length) {
    runs.push({ kind: "text", text: line.slice(cursor) });
  }
  // An empty line still needs a run, so it renders as a blank line.
  if (runs.length === 0) runs.push({ kind: "text", text: "" });

  return runs;
}

/** Counts and strips the leading ">" quote markers on one line. */
function stripQuote(line: string): { depth: number; rest: string } {
  let depth = 0;
  let index = 0;

  while (index < line.length) {
    if (line[index] === ">") {
      depth += 1;
      index += 1;
      // "> > text" and ">> text" mean the same thing.
      if (line[index] === " ") index += 1;
    } else {
      break;
    }
  }

  return { depth, rest: line.slice(index) };
}

/**
 * Turns a message body into paragraphs.
 *
 * A blank line starts a new paragraph, and so does a change of quote depth --
 * otherwise a reply and the text it quotes would run together.
 */
export function parseMessageBody(body: string): BodyParagraph[] {
  if (!body) return [];

  const paragraphs: BodyParagraph[] = [];
  let current: BodyParagraph | null = null;

  for (const rawLine of body.replace(/\r\n?/g, "\n").split("\n")) {
    const { depth, rest } = stripQuote(rawLine);

    if (rest.trim() === "") {
      // Blank line: end the paragraph rather than carrying an empty run into it.
      current = null;
      continue;
    }

    if (!current || current.quoteDepth !== depth) {
      current = { quoteDepth: depth, lines: [] };
      paragraphs.push(current);
    }

    current.lines.push(parseInline(rest));
  }

  return paragraphs;
}
