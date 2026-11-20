// A client for ardopcf's TCP host command port.
//
// Used only where nothing else holds the socket, and the reason is a hard
// constraint rather than a preference: ardopcf keeps exactly one host control
// connection. TCPHostInterface.c:670 assigns the result of accept() to a
// scalar TCPControlSock, so a second connection does not queue -- it displaces
// the first. Pat holds that socket for the whole of a session, so WL2GO
// opening it mid-session would cut Pat off from its own modem.
//
// Everything WL2GO needs on the modem WHILE Pat is attached therefore goes in
// at spawn time through -H. This client's two callers both own their window:
// the tuning session (its own modem, nothing else attached) and the pre-dial
// clear-channel check, which listens between modem start and Pat's dial and
// closes before Pat connects.

import { Socket } from "node:net";
import { LOOPBACK_HOST } from "../util/loopback.ts";

/** ardopcf terminates every host command and reply with CR. */
const TERMINATOR = "\r";

export interface HostCommandResult {
  ok: boolean;
  /** The reply line, or the fault text. */
  reply: string;
}

export interface ArdopHostClientOptions {
  port: number;
  host?: string;
  /** How long to wait for a reply before giving up on one command. */
  replyTimeoutMs?: number;
}

const DEFAULT_REPLY_TIMEOUT_MS = 3_000;

/**
 * One connection, many commands, closed explicitly.
 *
 * Commands are serialised through a queue rather than fired concurrently:
 * ardopcf's replies carry no request id, so two commands in flight would make
 * matching a reply to its command a guess.
 */
export class ArdopHostClient {
  private readonly opts: ArdopHostClientOptions;
  private socket: Socket | null = null;
  private buffer = "";
  private pending: ((line: string) => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Lines that arrived unprompted, e.g. INPUTPEAKS. */
  private readonly listeners = new Set<(line: string) => void>();
  /** Told when the socket closes under us, e.g. the modem died mid-check. */
  private readonly closeListeners = new Set<() => void>();

  constructor(options: ArdopHostClientOptions) {
    this.opts = options;
  }

  async connect(): Promise<void> {
    if (this.socket) return;
    const socket = new Socket();
    // An unhandled 'error' on a socket is fatal to the process, and a modem
    // that exits under us raises exactly that.
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("close", () => {
      this.socket = null;
      // Anything waiting on a reply will never get one now. Releasing it with
      // an empty line turns a hang into a reported failure.
      this.pending?.("");
      this.pending = null;
      for (const listener of this.closeListeners) listener();
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

  /** Unprompted lines from the modem. Returns an unsubscribe. */
  onLine(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The socket closed, however that happened. Returns an unsubscribe.
   * The case that matters is a modem exiting under us -- a caller awaiting
   * notifications would otherwise wait on a channel that can no longer
   * deliver any. It also fires on a deliberate close(), so a caller that
   * closes the client itself should unsubscribe first.
   */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /**
   * Sends one command and returns what ardopcf said about it.
   *
   * A FAULT is returned as `ok: false` with the text, never swallowed and never
   * thrown: a rejected drive level is something to show the operator, not an
   * exception that tears the tuning window down around them.
   */
  async send(command: string): Promise<HostCommandResult> {
    const run = async (): Promise<HostCommandResult> => {
      const socket = this.socket;
      if (!socket) return { ok: false, reply: "The modem is not connected." };

      const reply = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          this.pending = null;
          resolve("");
        }, this.opts.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS);

        this.pending = (line: string) => {
          clearTimeout(timer);
          resolve(line);
        };
        socket.write(command + TERMINATOR);
      });

      if (!reply) return { ok: false, reply: `The modem did not answer "${command}".` };
      if (reply.startsWith("FAULT")) return { ok: false, reply: reply.slice("FAULT".length).trim() };
      return { ok: true, reply };
    };

    // Chained onto the queue so two callers cannot have commands in flight at
    // once. The catch keeps one failure from poisoning every later command.
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
   * Splits on CR and routes each line.
   *
   * ardopcf sends asynchronous notifications down the same socket as replies --
   * INPUTPEAKS, PTT, STATUS -- so a line is only treated as a reply when
   * something is actually waiting for one. Handing an unsolicited PTT
   * notification back as the answer to DRIVELEVEL would report the wrong thing.
   */
  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const at = this.buffer.indexOf(TERMINATOR);
      if (at === -1) break;
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (!line) continue;

      for (const listener of this.listeners) listener(line);

      if (this.pending && !isAsyncNotification(line)) {
        const resolve = this.pending;
        this.pending = null;
        resolve(line);
      }
    }
  }
}

/**
 * Lines ardopcf sends on its own, which are never the answer to a command.
 *
 * Kept to the ones actually documented as unsolicited. Anything not on this
 * list is treated as a reply, which is the safe direction: a misrouted reply
 * shows the operator an odd string, while a misrouted notification would make
 * every command time out.
 */
function isAsyncNotification(line: string): boolean {
  return (
    line.startsWith("INPUTPEAKS") ||
    line.startsWith("PTT ") ||
    line.startsWith("BUSY ") ||
    line.startsWith("NEWSTATE") ||
    line.startsWith("STATUS")
  );
}
