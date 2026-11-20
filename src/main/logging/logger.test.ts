import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WriteStream } from "node:fs";
import { timestampLines } from "./logger.ts";

/** Collects what reached the file, so the stamping can be checked without one. */
function sink(): { written: string[]; stream: Pick<WriteStream, "write" | "end"> } {
  const written: string[] = [];
  return {
    written,
    stream: {
      write: (chunk: unknown) => {
        written.push(String(chunk));
        return true;
      },
      end: (callback?: () => void) => {
        callback?.();
        return undefined as never;
      },
    } as Pick<WriteStream, "write" | "end">,
  };
}

const STAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /;

describe("timestampLines", () => {
  it("stamps each line, not each write", async () => {
    // A subprocess's output arrives in whatever chunks the pipe delivers, so
    // one write can carry several lines and each needs its own time.
    const { written, stream } = sink();
    const out = timestampLines(stream);
    out.write("first\nsecond\nthird\n");

    assert.equal(written.length, 3);
    for (const line of written) assert.match(line, STAMP);
    assert.ok(written[0]?.endsWith("first\n"));
    assert.ok(written[2]?.endsWith("third\n"));
  });

  it("holds a split line back until its newline arrives", async () => {
    // The failure this prevents: a line broken across two chunks gaining a
    // second timestamp in the middle of itself, which would make the log
    // unreadable exactly where a burst of output is most interesting.
    const { written, stream } = sink();
    const out = timestampLines(stream);
    out.write("Opened capture ");
    assert.equal(written.length, 0, "a partial line must not be written yet");

    out.write("device\n");
    assert.equal(written.length, 1);
    assert.ok(written[0]?.endsWith("Opened capture device\n"));
    assert.equal(written[0]?.match(STAMP)?.length, 1);
  });

  it("does not lose a final line that never got its newline", async () => {
    // A subprocess killed mid-line still said something worth keeping.
    const { written, stream } = sink();
    const out = timestampLines(stream);
    out.write("Terminating on signal");
    await new Promise<void>((resolve) => out.end(() => resolve()));

    assert.equal(written.length, 1);
    assert.ok(written[0]?.endsWith("Terminating on signal\n"));
  });
});
