// Just enough of ardopcf's WebGui protocol to read two numbers off it.
//
// The tuning window needs a receive-level meter, and that level is already
// streaming: ardopcf computes it in its audio capture callback and pushes it to
// any WebGui client (PaSound.c:1368). Nothing else here is decoded -- not the
// waterfall, not the constellation, not the host traffic. Those are Module 12's
// console, and a partial implementation of them would be worse than none.
//
// Two layers, both described at Webgui.c:216-240:
//
//   lower   <uvint length><body>          length excludes its own bytes
//   higher  <type byte>'|'<data...>       server -> client
//           <type byte>'~'<data...>       client -> server
//
// The uvint is LEB128: seven bits per byte, high bit set means "more follows"
// (Webgui.c:160-170).

/** Second byte of every server message. ardopcf's own frame-sync check. */
export const SERVER_SEPARATOR = 0x7c; // '|'
/** Second byte of every client message. */
export const CLIENT_SEPARATOR = 0x7e; // '~'

/** Receive audio peak, 0-150 (Webgui.c:409). */
export const TAG_CURRENT_LEVEL = 0x81;
/** Transmit drive level, 0-100 (Webgui.c:443). */
export const TAG_DRIVE_LEVEL = 0x8d;

export function encodeUvint(value: number): number[] {
  const out: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    out.push((remaining & 0x7f) + 0x80);
    remaining >>>= 7;
  }
  out.push(remaining);
  return out;
}

/**
 * The "I have connected" message, type '0'.
 *
 * Required, not optional: wg_send_msg returns early while WebGuiNumConnected is
 * zero (Webgui.c:302-303), so a client that never says hello is sent nothing at
 * all and the meter would sit silently at zero forever.
 */
export function helloMessage(): Uint8Array {
  const body = [0x30, CLIENT_SEPARATOR]; // "0~"
  return Uint8Array.from([...encodeUvint(body.length), ...body]);
}

export interface WebguiMessage {
  type: number;
  data: number[];
}

export interface WebguiDecodeResult {
  messages: WebguiMessage[];
  /** Bytes of a message that has not fully arrived. Feed back in next time. */
  rest: Uint8Array;
  /**
   * Set when the stream stopped making sense.
   *
   * ardopcf writes the length header and the body as two SEPARATE WebSocket
   * frames, so a reader has to work on the byte stream rather than on frames --
   * and a reader that has lost its place produces plausible-looking numbers
   * from the middle of some other message. The separator byte is ardopcf's own
   * guard against exactly that, so a mismatch stops the decode dead rather than
   * resynchronising and reporting a level nobody sent.
   */
  desynchronised: string | null;
}

export function decodeWebguiMessages(buffer: Uint8Array): WebguiDecodeResult {
  const messages: WebguiMessage[] = [];
  let at = 0;

  for (;;) {
    // --- lower layer: the length ---
    let length = 0;
    let shift = 0;
    let cursor = at;
    for (;;) {
      if (cursor >= buffer.length) return { messages, rest: buffer.slice(at), desynchronised: null };
      const byte = buffer[cursor];
      cursor += 1;
      length += (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
      if (shift > 28) {
        return { messages, rest: new Uint8Array(), desynchronised: "The modem sent a message length WL2GO could not read." };
      }
    }

    if (cursor + length > buffer.length) return { messages, rest: buffer.slice(at), desynchronised: null };

    // --- higher layer: type, separator, data ---
    if (length < 2) {
      return { messages, rest: new Uint8Array(), desynchronised: `The modem sent a ${length}-byte message, which is too short to carry a type.` };
    }
    if (buffer[cursor + 1] !== SERVER_SEPARATOR) {
      return {
        messages,
        rest: new Uint8Array(),
        desynchronised: "The modem's status stream did not line up. WL2GO stopped reading it rather than show a level it invented.",
      };
    }

    messages.push({ type: buffer[cursor], data: Array.from(buffer.slice(cursor + 2, cursor + length)) });
    at = cursor + length;
  }
}

export type WebguiReading =
  | { kind: "receiveLevel"; value: number }
  | { kind: "driveLevel"; value: number };

/**
 * The two messages WL2GO acts on. Everything else is ignored BY TAG.
 *
 * Ignoring by tag rather than by shape is the point: an unrecognised message is
 * an ordinary event on a protocol this only reads a slice of, and it must not
 * be mistaken for a malformed one.
 */
export function interpretMessage(message: WebguiMessage): WebguiReading | null {
  if (message.data.length < 1) return null;
  switch (message.type) {
    case TAG_CURRENT_LEVEL:
      return { kind: "receiveLevel", value: message.data[0] };
    case TAG_DRIVE_LEVEL:
      return { kind: "driveLevel", value: message.data[0] };
    default:
      return null;
  }
}

/** Full scale for the receive meter. ardopcf scales peaks to 0-150. */
export const RECEIVE_LEVEL_FULL_SCALE = 150;
