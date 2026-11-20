// Catches the Winlink account password out of Pat's output before it is logged.
//
// When Winlink activates a new account it mails the assigned password in a
// SERVICE message, and Pat parses it out and PRINTS it -- to termWriter, which is
// MultiWriter(logFile, os.Stdout) (app/app.go:206-209, 449-452). It never stores
// it. In Winlink Express the operator reads it off the screen; in WL2GO it would
// vanish into a log file, and every later connection would fail because the
// operator does not know their own password.
//
// So this sits between Pat's stdout and the log file and does two jobs at once:
// hands the password to the app so it can be stored and shown, and redacts it so
// the credential is not written to disk in clear text. The redaction has to
// happen here, in the stream, rather than as a later scrub pass -- once it is
// written, it is written.

import { Transform, type TransformCallback } from "node:stream";

/**
 * Pat's exact wording (app/app.go:450). Matched loosely on the marker so a
 * change in surrounding punctuation does not silently stop the capture, but
 * anchored enough that ordinary log lines cannot trip it.
 */
const ACTIVATION_MARKER = /DO NOT LOSE YOUR PASSWORD:\s*(\S+)/;

export const REDACTION = "[stored by WL2GO]";

/**
 * The password Pat printed, or null.
 *
 * Pure and line-oriented so the matching is testable without a stream.
 */
export function extractActivationPassword(line: string): string | null {
  const match = ACTIVATION_MARKER.exec(line);
  return match?.[1] ?? null;
}

/** The same line with the credential replaced, leaving the context readable. */
export function redactActivationPassword(line: string): string {
  return line.replace(ACTIVATION_MARKER, `DO NOT LOSE YOUR PASSWORD: ${REDACTION}`);
}

export interface PatLogFilterOptions {
  /** Called with the captured password. Errors here must not break logging. */
  onPassword: (password: string) => void;
}

/**
 * A Transform that redacts on the way through.
 *
 * Buffers partial lines: a chunk boundary can fall in the middle of the marker,
 * and a credential that slips through because it was split across two writes is
 * exactly the failure this exists to prevent.
 */
export class PatLogFilter extends Transform {
  private readonly onPassword: (password: string) => void;
  private pending = "";

  constructor(options: PatLogFilterOptions) {
    super();
    this.onPassword = options.onPassword;
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, done: TransformCallback): void {
    this.pending += chunk.toString();

    // Everything up to the last newline is complete; the remainder waits for
    // the next chunk rather than being emitted half-matched.
    const lastBreak = this.pending.lastIndexOf("\n");
    if (lastBreak === -1) {
      done();
      return;
    }

    const complete = this.pending.slice(0, lastBreak + 1);
    this.pending = this.pending.slice(lastBreak + 1);
    this.push(this.processLines(complete));
    done();
  }

  override _flush(done: TransformCallback): void {
    if (this.pending) {
      this.push(this.processLines(this.pending));
      this.pending = "";
    }
    done();
  }

  private processLines(text: string): string {
    if (!ACTIVATION_MARKER.test(text)) return text;

    return text
      .split("\n")
      .map((line) => {
        const password = extractActivationPassword(line);
        if (!password) return line;

        try {
          this.onPassword(password);
        } catch {
          // Storing it is best effort; failing to log would be worse, and the
          // redaction below must happen either way.
        }
        return redactActivationPassword(line);
      })
      .join("\n");
  }
}
