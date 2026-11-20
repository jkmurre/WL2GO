import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PatLogFilter,
  REDACTION,
  extractActivationPassword,
  redactActivationPassword,
} from "./patLogFilter.ts";

/** Pat's real wording, from app/app.go:450. */
const REAL_LINE = "DO NOT LOSE YOUR PASSWORD: K1CHN7";

/** Feeds chunks through the filter and returns what would have been written. */
async function run(chunks: string[]): Promise<{ output: string; captured: string[] }> {
  const captured: string[] = [];
  const filter = new PatLogFilter({ onPassword: (p) => captured.push(p) });

  const parts: string[] = [];
  filter.on("data", (d: Buffer) => parts.push(d.toString()));
  const finished = new Promise<void>((resolve) => filter.on("end", resolve));

  for (const chunk of chunks) filter.write(chunk);
  filter.end();
  await finished;

  return { output: parts.join(""), captured };
}

describe("extractActivationPassword", () => {
  it("finds the password in Pat's activation line", () => {
    assert.equal(extractActivationPassword(REAL_LINE), "K1CHN7");
  });

  it("ignores ordinary log lines", () => {
    for (const line of [
      "2026/08/24 20:42:54 Starting HTTP service (http://127.0.0.1:17812)...",
      "Missing mycall",
      "Connected to CMS",
      "password", // the bare word must not trip it
    ]) {
      assert.equal(extractActivationPassword(line), null, `"${line}" should not match`);
    }
  });

  it("tolerates surrounding text and timestamps", () => {
    assert.equal(extractActivationPassword(`2026/08/24 21:00:00 ${REAL_LINE}`), "K1CHN7");
  });
});

describe("redactActivationPassword", () => {
  it("removes the password but keeps the context readable", () => {
    const redacted = redactActivationPassword(REAL_LINE);
    assert.equal(redacted.includes("K1CHN7"), false);
    assert.match(redacted, /DO NOT LOSE YOUR PASSWORD/);
    assert.match(redacted, /stored by WL2GO/);
  });

  it("leaves a line without the marker exactly as it was", () => {
    const line = "2026/08/24 Connected to CMS";
    assert.equal(redactActivationPassword(line), line);
  });
});

describe("PatLogFilter", () => {
  it("passes ordinary output through untouched", async () => {
    const text = "line one\nline two\nline three\n";
    const { output, captured } = await run([text]);
    assert.equal(output, text);
    assert.deepEqual(captured, []);
  });

  it("captures the password and keeps it out of the written stream", async () => {
    const { output, captured } = await run([`before\n${REAL_LINE}\nafter\n`]);

    assert.deepEqual(captured, ["K1CHN7"]);
    assert.equal(output.includes("K1CHN7"), false, "the credential must never reach the log file");
    assert.match(output, /before/);
    assert.match(output, /after/);
    assert.ok(output.includes(REDACTION));
  });

  it("catches a password split across two chunks", async () => {
    // A chunk boundary can fall mid-line. A credential that slipped through
    // because it arrived in two writes is exactly what this guards.
    const { output, captured } = await run(["DO NOT LOSE YOUR ", "PASSWORD: K1CHN7\n"]);

    assert.deepEqual(captured, ["K1CHN7"]);
    assert.equal(output.includes("K1CHN7"), false);
  });

  it("does not emit a partial line early, then completes it", async () => {
    const { output } = await run(["no newline yet", " ...and now\n"]);
    assert.equal(output, "no newline yet ...and now\n");
  });

  it("flushes a trailing line that never got a newline", async () => {
    const { output, captured } = await run([REAL_LINE]);
    assert.deepEqual(captured, ["K1CHN7"]);
    assert.equal(output.includes("K1CHN7"), false);
  });

  it("handles more than one activation line", async () => {
    const { captured, output } = await run([`${REAL_LINE}\nDO NOT LOSE YOUR PASSWORD: SECOND1\n`]);
    assert.deepEqual(captured, ["K1CHN7", "SECOND1"]);
    assert.equal(/K1CHN7|SECOND1/.test(output), false);
  });

  it("still redacts when storing the password throws", async () => {
    // Losing the log would be worse than failing to store, and the redaction
    // must happen either way.
    const filter = new PatLogFilter({
      onPassword: () => {
        throw new Error("keychain unavailable");
      },
    });
    const parts: string[] = [];
    filter.on("data", (d: Buffer) => parts.push(d.toString()));
    const finished = new Promise<void>((resolve) => filter.on("end", resolve));

    filter.write(`${REAL_LINE}\n`);
    filter.end();
    await finished;

    assert.equal(parts.join("").includes("K1CHN7"), false);
  });

  it("preserves byte-for-byte content when nothing matches", async () => {
    const noisy = "a\n\nb\r\n  indented\ntrailing";
    const { output } = await run([noisy]);
    assert.equal(output, noisy);
  });
});
