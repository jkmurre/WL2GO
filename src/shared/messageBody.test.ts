import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseInline, parseMessageBody, type BodyInline } from "./messageBody.ts";

/** The plain text of a run of inlines, for asserting on content not structure. */
function textOf(runs: BodyInline[]): string {
  return runs.map((run) => run.text).join("");
}

describe("parseMessageBody structure", () => {
  it("returns nothing for an empty body", () => {
    assert.deepEqual(parseMessageBody(""), []);
  });

  it("splits paragraphs on blank lines", () => {
    const paragraphs = parseMessageBody("first\n\nsecond");

    assert.equal(paragraphs.length, 2);
    assert.equal(textOf(paragraphs[0]!.lines[0]!), "first");
    assert.equal(textOf(paragraphs[1]!.lines[0]!), "second");
  });

  it("keeps lines separate rather than reflowing them", () => {
    // Winlink traffic is full of hand-aligned tables and position reports whose
    // whitespace is load-bearing. Rewrapping would destroy the message.
    const paragraphs = parseMessageBody("CALL     GRID    TIME\nN1CALL   FN31    1430");

    assert.equal(paragraphs.length, 1);
    assert.equal(paragraphs[0]?.lines.length, 2);
    assert.equal(textOf(paragraphs[0]!.lines[1]!), "N1CALL   FN31    1430");
  });

  it("collapses several blank lines into one break", () => {
    assert.equal(parseMessageBody("a\n\n\n\nb").length, 2);
  });

  it("handles CRLF line endings", () => {
    const paragraphs = parseMessageBody("first\r\n\r\nsecond");

    assert.equal(paragraphs.length, 2);
    assert.equal(textOf(paragraphs[0]!.lines[0]!), "first");
  });
});

describe("parseMessageBody quoting", () => {
  it("reads quote depth from leading angle brackets", () => {
    const paragraphs = parseMessageBody("> quoted once\n>> quoted twice");

    assert.equal(paragraphs[0]?.quoteDepth, 1);
    assert.equal(textOf(paragraphs[0]!.lines[0]!), "quoted once");
    assert.equal(paragraphs[1]?.quoteDepth, 2);
    assert.equal(textOf(paragraphs[1]!.lines[0]!), "quoted twice");
  });

  it("treats '> >' and '>>' as the same depth", () => {
    const paragraphs = parseMessageBody("> > spaced\n>> tight");

    assert.equal(paragraphs.length, 1, "both lines should be the same paragraph");
    assert.equal(paragraphs[0]?.quoteDepth, 2);
  });

  it("starts a new paragraph when the quote depth changes", () => {
    // Without this a reply and the text it quotes would run together.
    const paragraphs = parseMessageBody("my reply\n> what they said");

    assert.equal(paragraphs.length, 2);
    assert.equal(paragraphs[0]?.quoteDepth, 0);
    assert.equal(paragraphs[1]?.quoteDepth, 1);
  });

  it("does not treat a mid-line angle bracket as a quote", () => {
    const paragraphs = parseMessageBody("temperature > 30 degrees");

    assert.equal(paragraphs[0]?.quoteDepth, 0);
    assert.equal(textOf(paragraphs[0]!.lines[0]!), "temperature > 30 degrees");
  });

  it("ignores a quoted blank line", () => {
    assert.equal(parseMessageBody("> a\n>\n> b").length, 2);
  });
});

describe("parseInline links", () => {
  it("finds an http URL", () => {
    const runs = parseInline("see https://winlink.org for details");

    assert.deepEqual(runs, [
      { kind: "text", text: "see " },
      { kind: "link", href: "https://winlink.org/", text: "https://winlink.org" },
      { kind: "text", text: " for details" },
    ]);
  });

  it("promotes a bare www. to https", () => {
    const runs = parseInline("www.winlink.org");

    assert.equal(runs[0]?.kind, "link");
    assert.equal(runs[0]?.kind === "link" ? runs[0].href : "", "https://www.winlink.org/");
  });

  it("does not swallow the sentence's full stop", () => {
    const runs = parseInline("go to https://winlink.org.");

    assert.equal(runs[1]?.text, "https://winlink.org");
    assert.equal(runs[2]?.text, ".");
  });

  it("does not swallow a closing bracket", () => {
    const runs = parseInline("(see https://winlink.org)");

    assert.equal(runs[1]?.text, "https://winlink.org");
    assert.equal(runs[2]?.text, ")");
  });

  it("links a URL at the very start and the very end of a line", () => {
    assert.equal(parseInline("https://winlink.org starts it")[0]?.kind, "link");

    const trailing = parseInline("ends with https://winlink.org");
    assert.equal(trailing[trailing.length - 1]?.kind, "link");
  });

  it("finds more than one URL on a line", () => {
    const links = parseInline("https://a.example and https://b.example").filter((r) => r.kind === "link");
    assert.equal(links.length, 2);
  });

  it("leaves a dangerous scheme as plain text, never a link", () => {
    // The renderer can only ever be handed an href this function built, so a
    // scheme that never becomes a link can never be opened.
    for (const line of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "ftp://example.org/x",
    ]) {
      const runs = parseInline(line);
      assert.ok(
        runs.every((run) => run.kind === "text"),
        `${line} should not have produced a link`,
      );
      assert.equal(textOf(runs), line, "and the text should survive verbatim");
    }
  });

  it("keeps an empty line as a single empty run", () => {
    assert.deepEqual(parseInline(""), [{ kind: "text", text: "" }]);
  });

  it("is not affected by the previous call", () => {
    // The URL pattern is module-level and /g, so a leaked lastIndex would make
    // results depend on call order.
    parseInline("https://first.example");
    const runs = parseInline("https://second.example");

    assert.equal(runs[0]?.kind, "link");
  });
});

describe("parseMessageBody injection safety", () => {
  it("treats markup as literal text", () => {
    // Nothing here produces markup, so this is really asserting that the parser
    // has no path that could hand the renderer anything but text and hrefs.
    const body = '<script>alert(1)</script> and <img src=x onerror=alert(1)>';
    const runs = parseMessageBody(body)[0]!.lines[0]!;

    assert.ok(
      runs.every((run) => run.kind === "text"),
      "markup should never become a link",
    );
    assert.equal(textOf(runs), body, "and should survive character for character");
  });

  it("does not let a crafted URL smuggle in another scheme", () => {
    const runs = parseInline("https://example.org/x?next=javascript:alert(1)");
    const link = runs.find((run) => run.kind === "link");

    assert.ok(link && link.kind === "link");
    assert.ok(link.href.startsWith("https://"), `href was ${link.href}`);
  });
});
