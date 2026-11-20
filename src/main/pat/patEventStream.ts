// Pat's /ws event stream: the only way to see a session while it is happening.
//
// POST /api/connect runs the whole session inline and returns nothing until it
// is over (api/api.go:359-371), so status, progress and -- critically -- prompts
// all arrive here instead.
//
// It is also load-bearing for the first connect ever made. connect.go:46 calls
// promptUnconfirmedAccount() before the transport is even parsed, and with no
// client attached PromptHub has no prompter: the connect stalls for the full
// two-minute timeout and fails with nothing explaining why. Connecting is
// therefore refused until this is attached.

import { decodeWsMessage, encodePong, encodePromptResponse, type PatWsEvent } from "./patWsProtocol.ts";
import type { PatPrompt } from "../../shared/ipcContract.ts";

/**
 * The socket operations this needs, narrowed to four members.
 *
 * Node 22 already exposes a global WebSocket and Electron 43 ships Node 24, but
 * that is unverified inside Electron's main process specifically -- so the
 * dependency is kept behind this interface. Swapping in the `ws` package means
 * changing the factory below and nothing else.
 */
export interface EventSocket {
  send(data: string): void;
  close(): void;
  onOpen(listener: () => void): void;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: () => void): void;
  onError(listener: (err: Error) => void): void;
}

export type SocketFactory = (url: string) => EventSocket;

/** Wraps the platform WebSocket in the interface above. */
export const defaultSocketFactory: SocketFactory = (url) => {
  const socket = new WebSocket(url);
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onOpen: (listener) => socket.addEventListener("open", () => listener()),
    onMessage: (listener) => {
      socket.addEventListener("message", (event: MessageEvent) => {
        listener(typeof event.data === "string" ? event.data : String(event.data));
      });
    },
    onClose: (listener) => socket.addEventListener("close", () => listener()),
    onError: (listener) => socket.addEventListener("error", () => listener(new Error("WebSocket error"))),
  };
};

export interface PatEventStreamOptions {
  url: string;
  /**
   * The stored Winlink password, or null. Consulted per prompt rather than
   * captured once, so a password saved mid-session is picked up.
   */
  getPassword: () => string | null;
  onEvent: (event: PatWsEvent) => void;
  /** A prompt nothing could answer automatically; the operator must decide. */
  onPromptUnanswered: (prompt: PatPrompt) => void;
  onAttachedChange: (attached: boolean) => void;
  onLog?: (message: string) => void;
  socketFactory?: SocketFactory;
  /** Reconnect backoff bounds. Pat restarts on identity changes, so this matters. */
  minRetryMs?: number;
  maxRetryMs?: number;
}

const DEFAULT_MIN_RETRY_MS = 500;
const DEFAULT_MAX_RETRY_MS = 15_000;

export class PatEventStream {
  private readonly opts: PatEventStreamOptions;
  private readonly factory: SocketFactory;
  private socket: EventSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryMs: number;
  private attached = false;
  private stopped = false;
  /** Prompts raised to the operator and still waiting on an answer. */
  private readonly openPrompts = new Map<string, PatPrompt>();

  constructor(options: PatEventStreamOptions) {
    this.opts = options;
    this.factory = options.socketFactory ?? defaultSocketFactory;
    this.retryMs = options.minRetryMs ?? DEFAULT_MIN_RETRY_MS;
  }

  isAttached(): boolean {
    return this.attached;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.setAttached(false);
  }

  /** Answers a prompt the operator was asked about. */
  respond(id: string, value: string): void {
    this.openPrompts.delete(id);
    this.socket?.send(encodePromptResponse(id, value));
  }

  /** Prompts still awaiting the operator, so a reopened window can show them. */
  pendingPrompts(): PatPrompt[] {
    return [...this.openPrompts.values()];
  }

  private open(): void {
    if (this.stopped) return;

    let socket: EventSocket;
    try {
      socket = this.factory(this.opts.url);
    } catch (err: unknown) {
      // A factory that throws (no WebSocket in this runtime) must not crash the
      // app -- the UI reports "not attached" and connecting stays disabled.
      this.opts.onLog?.(`Could not open the event stream: ${message(err)}`);
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.onOpen(() => {
      this.retryMs = this.opts.minRetryMs ?? DEFAULT_MIN_RETRY_MS;
      this.setAttached(true);
      this.opts.onLog?.("Attached to Pat's event stream");
    });

    socket.onMessage((data) => this.handle(data));

    socket.onClose(() => {
      this.socket = null;
      this.setAttached(false);
      // Pat is restarted whenever the station identity changes, so a close is
      // routine rather than exceptional. Reconnect rather than give up.
      this.scheduleRetry();
    });

    socket.onError(() => {
      // Errors are always followed by a close; retry is scheduled there so a
      // single failure does not queue two reconnects.
    });
  }

  private handle(data: string): void {
    const event = decodeWsMessage(data);
    if (!event) return;

    if (event.type === "ping") {
      // Mandatory. Pat drops a client that does not answer within 4m10s.
      this.socket?.send(encodePong());
      return;
    }

    if (event.type === "prompt") {
      this.answerPrompt(event.prompt);
    } else if (event.type === "promptAbort") {
      this.openPrompts.delete(event.prompt.id);
    }

    this.opts.onEvent(event);
  }

  /**
   * Answers what can be answered from stored state, and escalates the rest.
   *
   * A password prompt with a stored password is answered silently; without one
   * the operator has to supply it. Account-activation prompts are always the
   * operator's call -- they are Winlink asking whether an account exists.
   */
  private answerPrompt(prompt: PatPrompt): void {
    if (prompt.kind === "password") {
      const password = this.opts.getPassword();
      if (password) {
        this.socket?.send(encodePromptResponse(prompt.id, password));
        this.opts.onLog?.("Answered a Winlink password challenge from the keychain");
        return;
      }
    }

    this.openPrompts.set(prompt.id, prompt);
    this.opts.onPromptUnanswered(prompt);
  }

  private setAttached(attached: boolean): void {
    if (this.attached === attached) return;
    this.attached = attached;
    this.opts.onAttachedChange(attached);
  }

  private scheduleRetry(): void {
    if (this.stopped || this.timer) return;

    const delay = this.retryMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);

    this.retryMs = Math.min(this.retryMs * 2, this.opts.maxRetryMs ?? DEFAULT_MAX_RETRY_MS);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
