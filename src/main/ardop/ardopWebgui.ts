// Reads the receive level off the tuning modem's WebGui socket.
//
// Only the tuning session ever opens one of these, and only against a modem
// WL2GO started itself on a scratch port bound to loopback by vendor patch
// 0006. The WebGui is not a passive display -- its '2' message fires a real
// five-second transmission and that is NOT gated by developer mode
// (Webgui.c:784-790) -- so "who may open it" is a security question, not a
// convenience one. Nothing else in WL2GO passes -G.

import {
  decodeWebguiMessages,
  helloMessage,
  interpretMessage,
  type WebguiReading,
} from "../../shared/webguiProtocol.ts";
import { LOOPBACK_HOST } from "../util/loopback.ts";

/**
 * The ardopcf release this decoder was written against.
 *
 * ardopcf's WebGui protocol carries no version handshake of its own, so this is
 * the check we have to add -- the same treatment the device-list format gets,
 * and for the same reason: a tag that moved between releases would not fail, it
 * would render a level nobody sent. Compared against the version recorded when
 * the binary was built (resources/bin/ARDOPCF_VERSION).
 *
 * On a mismatch the METER is disabled with a reason. Sessions are untouched --
 * a level readout is not worth refusing to transmit over.
 */
export const WEBGUI_PROTOCOL_VERSION = "1.0.4.1.3";

/** Where ardopcf accepts the WebSocket upgrade. Webgui.c:120, ws_set_uri(). */
export const WEBGUI_PATH = "/ws";

export function webguiVersionRefusal(modemVersion: string | null): string | null {
  if (modemVersion === null) {
    return "WL2GO could not tell which modem version is installed, so it will not show a level it cannot verify.";
  }
  if (modemVersion !== WEBGUI_PROTOCOL_VERSION) {
    return (
      `The level meter was written for ardopcf ${WEBGUI_PROTOCOL_VERSION} and this build is ` +
      `${modemVersion}. The meter is off; everything else still works. Rebuild the modem with ` +
      `"npm run build:ardopcf" to bring them back into step.`
    );
  }
  return null;
}

/** The slice of WebSocket this needs, so the tests do not need a socket. */
export interface WebguiSocket {
  send(data: Uint8Array): void;
  close(): void;
  onOpen(listener: () => void): void;
  onBinary(listener: (data: Uint8Array) => void): void;
  onClose(listener: () => void): void;
  onError(listener: (err: Error) => void): void;
}

export interface ArdopWebguiOptions {
  port: number;
  onReading: (reading: WebguiReading) => void;
  /** Called once, when the stream stops being trustworthy. */
  onDesynchronised?: (reason: string) => void;
  onError?: (message: string) => void;
  /** Swapped out in tests. The default uses the runtime's global WebSocket. */
  createSocket?: (url: string) => WebguiSocket;
}

/**
 * One WebGui connection for the life of one tuning session.
 *
 * Does not reconnect. The socket only outlives the modem by accident, and a
 * client that quietly reconnects to whatever is now on that port is a client
 * that could end up reading a modem the operator did not start.
 */
export class ArdopWebguiClient {
  private readonly opts: ArdopWebguiOptions;
  private socket: WebguiSocket | null = null;
  private pending: Uint8Array = new Uint8Array();
  private stopped = false;

  constructor(options: ArdopWebguiOptions) {
    this.opts = options;
  }

  connect(): void {
    if (this.socket || this.stopped) return;
    const create = this.opts.createSocket ?? defaultSocket;

    let socket: WebguiSocket;
    try {
      // The "/ws" path is REQUIRED, not decoration. ardopcf serves the webgui
      // page at "/" and calls ws_set_uri("/ws") for the socket (Webgui.c:120),
      // so an upgrade at the root is refused -- which is why the level meter
      // never once worked and only ever showed up as "Level meter: WebGui
      // socket error" in the log.
      socket = create(`ws://${LOOPBACK_HOST}:${this.opts.port}${WEBGUI_PATH}`);
    } catch (err: unknown) {
      this.opts.onError?.(err instanceof Error ? err.message : String(err));
      return;
    }

    // Nothing is sent until the client says hello: wg_send_msg short-circuits
    // while no client is registered, so without this the socket is open and
    // permanently silent.
    socket.onOpen(() => socket.send(helloMessage()));
    socket.onBinary((data) => this.onBinary(data));
    socket.onClose(() => {
      this.socket = null;
    });
    socket.onError((err) => this.opts.onError?.(err.message));
    this.socket = socket;
  }

  close(): void {
    this.stopped = true;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      // Closing a socket that is already gone is not a failure worth surfacing.
    }
  }

  private onBinary(data: Uint8Array): void {
    if (this.stopped) return;

    // Concatenated rather than decoded per frame, on purpose: ardopcf sends the
    // length header and the body as two separate WebSocket frames, so message
    // boundaries and frame boundaries do not line up.
    const joined = new Uint8Array(this.pending.length + data.length);
    joined.set(this.pending);
    joined.set(data, this.pending.length);

    const { messages, rest, desynchronised } = decodeWebguiMessages(joined);
    this.pending = new Uint8Array(rest);

    for (const message of messages) {
      const reading = interpretMessage(message);
      if (reading) this.opts.onReading(reading);
    }

    if (desynchronised) {
      // Stop rather than resynchronise. A decoder that has lost its place still
      // emits plausible numbers, and a meter showing an invented level is worse
      // than one that admits it stopped.
      this.opts.onDesynchronised?.(desynchronised);
      this.close();
    }
  }
}

/**
 * The platform WebSocket, which Electron's main process has natively.
 *
 * Same shape as patEventStream's factory, and for the same reason: keeping the
 * construction in one wrappable place is what lets the protocol handling be
 * tested without a server.
 */
function defaultSocket(url: string): WebguiSocket {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onOpen: (listener) => socket.addEventListener("open", () => listener()),
    onBinary: (listener) =>
      socket.addEventListener("message", (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) listener(new Uint8Array(event.data));
      }),
    onClose: (listener) => socket.addEventListener("close", () => listener()),
    onError: (listener) => socket.addEventListener("error", () => listener(new Error("WebGui socket error"))),
  };
}
