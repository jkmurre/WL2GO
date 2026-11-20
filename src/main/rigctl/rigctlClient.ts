// A client for rigctld's TCP command port.
//
// Deliberately shaped like ardopHostClient.ts -- one connection, commands
// serialised through a queue, a fault returned as data rather than thrown --
// because the two are solving the same problem and two different shapes for it
// would be two different sets of bugs. The differences are in the protocol:
//
//   * rigctld accepts MANY simultaneous connections, unlike ardopcf's single
//     host socket. WL2GO holding one while Pat holds another is fine, and is
//     what lets us set the mode on a rig Pat is keying through.
//   * Every command is sent in EXTENDED response mode, by prefixing it with
//     "+". This is not cosmetic. In the default mode a `get` answers with a
//     bare value and NO trailing "RPRT" -- verified against the vendored
//     rigctld: "\\get_freq" replies "7101000\n" while "\\set_freq 7101000"
//     replies "RPRT 0\n". A reader that waits for an RPRT therefore hangs on
//     every get until its timeout. In extended mode both shapes end with RPRT,
//     and each value arrives on a labelled "Name: value" line:
//
//         +\get_mode  ->  "get_mode:\nMode: PKTUSB\nPassband: 0\nRPRT 0\n"
//         +\set_mode  ->  "set_mode: PKTUSB 0\nRPRT 0\n"
//
// The extended (backslash) command names are used throughout rather than the
// single letters. "\set_mode" cannot be confused for anything; "M" can.

import { Socket } from "node:net";
import { LOOPBACK_HOST } from "../util/loopback.ts";

/** rigctld terminates every line with LF. */
const TERMINATOR = "\n";

/**
 * Asks for extended responses. See the note at the top of the file -- without
 * it a `get` never sends an RPRT and every read would wait out its timeout.
 */
const EXTENDED = "+";

const DEFAULT_REPLY_TIMEOUT_MS = 5_000;

export interface RigctlResult {
  ok: boolean;
  /**
   * The reply's value lines, echo and RPRT removed.
   *
   * Extended mode echoes the command on the first line ("get_mode:") and
   * reports on the last ("RPRT 0"); everything between is the answer.
   */
  lines: string[];
  /** Human-readable fault text when ok is false. */
  error: string | null;
}

export interface RigctlClientOptions {
  port: number;
  host?: string;
  replyTimeoutMs?: number;
}

/**
 * Hamlib's error codes, in the words of someone holding a radio.
 *
 * Only the ones an operator can actually act on are named. Everything else
 * falls through to the raw code, which is more honest than inventing an
 * explanation -- and the code is greppable against rig.h.
 */
function describeRprt(code: number): string {
  switch (code) {
    case -1:
      return "the radio rejected the command as invalid";
    case -4:
      return "this radio does not support that through Hamlib";
    case -5:
      return "the radio did not answer in time — check it is switched on and the CAT cable is connected";
    case -6:
      return "the radio's CAT port could not be opened; something else may be using it";
    case -8:
      return "the radio rejected the value as out of range";
    case -11:
      return "the radio is not responding on the CAT port";
    default:
      return `the radio reported Hamlib error ${code}`;
  }
}

export class RigctlClient {
  private readonly opts: RigctlClientOptions;
  private socket: Socket | null = null;
  private buffer = "";
  private pending: ((lines: string[]) => void) | null = null;
  private lines: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: RigctlClientOptions) {
    this.opts = options;
  }

  isConnected(): boolean {
    return this.socket !== null;
  }

  async connect(): Promise<void> {
    if (this.socket) return;
    const socket = new Socket();
    // An unhandled 'error' is fatal to the process, and a rigctld that exits
    // under us -- radio unplugged mid-session -- raises exactly that.
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("close", () => {
      this.socket = null;
      // Anything waiting on a reply will never get one. Releasing it with no
      // lines turns a hang into a reported failure.
      const resolve = this.pending;
      this.pending = null;
      resolve?.([]);
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.connect(this.opts.port, this.opts.host ?? LOOPBACK_HOST, () => {
        socket.off("error", reject);
        resolve();
      });
    });
    this.socket = socket;
  }

  /**
   * Sends one command and reports what the radio said about it.
   *
   * Never throws, for the same reason ArdopHostClient.send does not: a radio
   * refusing a mode is something to show the operator next to the thing they
   * were trying to do, not an exception unwinding a session teardown.
   */
  async send(command: string): Promise<RigctlResult> {
    const run = async (): Promise<RigctlResult> => {
      const socket = this.socket;
      if (!socket) return fault("rig control is not running");

      const lines = await new Promise<string[]>((resolve) => {
        const timer = setTimeout(() => {
          this.pending = null;
          this.lines = [];
          resolve([]);
        }, this.opts.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS);

        this.pending = (received: string[]) => {
          clearTimeout(timer);
          resolve(received);
        };
        socket.write(EXTENDED + command + TERMINATOR);
      });

      if (lines.length === 0) return fault(`rig control did not answer "${command}"`);

      // onData only resolves on an RPRT line, so the last line is always one.
      const code = Number(lines[lines.length - 1]?.slice("RPRT".length).trim());
      if (!Number.isInteger(code)) {
        return fault(`rig control gave an unrecognised answer to "${command}"`);
      }
      if (code !== 0) return fault(describeRprt(code));

      // First line is extended mode's echo of the command; drop it along with
      // the RPRT so callers see only the answer.
      return { ok: true, lines: lines.slice(1, -1), error: null };
    };

    // Chained, so two callers cannot have commands in flight at once: replies
    // carry no request id, so matching one to its command would be a guess.
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    await new Promise<void>((resolve) => {
      socket.end(() => resolve());
      socket.destroy();
      resolve();
    });
  }

  /**
   * Accumulates lines until the RPRT that ends the reply.
   *
   * rigctld sends a get's value and its report as separate lines, and may split
   * either across TCP reads, so a reply is only complete at the RPRT.
   */
  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const at = this.buffer.indexOf(TERMINATOR);
      if (at === -1) break;
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (!line) continue;

      this.lines.push(line);
      if (!line.startsWith("RPRT")) continue;

      const resolve = this.pending;
      const complete = this.lines;
      this.pending = null;
      this.lines = [];
      resolve?.(complete);
    }
  }
}

/**
 * Formats bytes the way Hamlib's send_cmd parser actually reads them.
 *
 * The "\\0xNN" form, with a literal backslash, is the only one that works.
 * rigctl_parse.c:5245 parses with `strtol(p + 1, &p, 0)`: starting one
 * character in, so "\\0x1A" hands strtol "0x1A" and base 0 recognises the
 * prefix. The shorter "x1A" form documented alongside it hands strtol "1A",
 * which base 0 reads as decimal 1 and stops at the 'A' -- silently sending the
 * wrong byte for every value with a hex letter in it. It is also the form
 * Hamlib prints replies in (rigctl_parse.c:5449), so this round-trips.
 *
 * LOWERCASE, and that is not cosmetic. Hamlib decides an Icom reply ends at
 * 0xFD by searching the command text for the literal "xfd"
 * (rigctl_parse.c:5356) -- case-sensitively, before it lowercases a copy for
 * the counting that follows. Sent in upper case that test fails, the reply
 * terminator stays CR/LF, and the read waits for a newline an Icom never
 * sends: the reply comes back EMPTY with RPRT 0, which reads as success.
 * Measured against an IC-7300 MkII on 2026-08-27 -- the same frame returned
 * nothing in upper case and the radio's answer in lower.
 */
export function formatRawBytes(bytes: Uint8Array | readonly number[]): string {
  return Array.from(bytes)
    .map((byte) => `\\0x${byte.toString(16).padStart(2, "0")}`)
    .join("");
}

/**
 * The bytes out of a send_cmd reply, ignoring the trailing byte count.
 *
 * Hamlib prints "\\0xFE\\0xFE\\0xE0\\0xB6... 10" -- the frame, a space, and how
 * many bytes it read. Parsed by matching the tokens rather than by splitting,
 * so the count cannot be mistaken for data.
 */
export function parseRawBytes(reply: string): number[] {
  return [...reply.matchAll(/\\0x([0-9A-Fa-f]{2})/g)].map((match) => Number.parseInt(match[1] ?? "", 16));
}

function fault(reason: string): RigctlResult {
  return { ok: false, lines: [], error: reason };
}

/**
 * One labelled value out of an extended reply, e.g. "Mode" from "Mode: PKTUSB".
 *
 * Matched on the LABEL rather than taken positionally: a get can return several
 * values (get_mode returns Mode and Passband) and reading the wrong index would
 * silently produce a plausible-looking wrong answer -- the failure mode this
 * codebase has already shipped once with Pat's frequency objects.
 */
export function labelledValue(lines: readonly string[], label: string): string | null {
  const prefix = `${label}:`;
  for (const line of lines) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
}
