import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toExternalUrl } from "./externalLink.ts";

describe("toExternalUrl", () => {
  it("allows ordinary web links", () => {
    assert.deepEqual(toExternalUrl("https://winlink.org/"), { url: "https://winlink.org/" });
    assert.deepEqual(toExternalUrl("http://example.org/a?b=c"), { url: "http://example.org/a?b=c" });
  });

  it("refuses every scheme that is not http or https", () => {
    // shell.openExternal acts on file: URLs, and on Windows the shell acts on
    // considerably more. A message from an unknown station must never reach it.
    for (const link of [
      "file:///etc/passwd",
      "file://server/share/x.exe",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "ms-msdt:/id",
      "smb://attacker/share",
      "ftp://example.org/x",
      "mailto:someone@example.org",
    ]) {
      const result = toExternalUrl(link);
      assert.ok("error" in result, `${link} should have been refused`);
    }
  });

  it("is not fooled by case or padding in the scheme", () => {
    assert.ok("error" in toExternalUrl("FILE:///etc/passwd"));
    assert.ok("error" in toExternalUrl("JaVaScRiPt:alert(1)"));
    assert.ok("error" in toExternalUrl("  javascript:alert(1)"));
  });

  it("rejects anything that is not a parseable link", () => {
    assert.ok("error" in toExternalUrl(""));
    assert.ok("error" in toExternalUrl("   "));
    assert.ok("error" in toExternalUrl("not a url"));
    assert.ok("error" in toExternalUrl("/etc/passwd"));
    assert.ok("error" in toExternalUrl(null));
    assert.ok("error" in toExternalUrl(42));
    assert.ok("error" in toExternalUrl({ url: "https://winlink.org" }));
  });

  it("keeps a query string that merely mentions another scheme", () => {
    const result = toExternalUrl("https://example.org/x?next=javascript:alert(1)");
    assert.ok("url" in result && result.url.startsWith("https://"));
  });
});
