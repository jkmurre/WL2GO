// Icom's CI-V framing, enough of it to ask a radio who it is.
//
// WL2GO needs this for one question -- "which serial port is the radio on, and
// what CI-V address is it set to?" -- but that one question is the difference
// between a keying config an operator can complete and two hex boxes they have
// no way to fill in. The IC-7300 MkII presents two USB serial nodes with
// identical vendor, product and serial number, so the path is the only thing
// telling them apart and nothing but asking can say which is which.
//
// Framing and command bytes come from Hamlib's own Icom prober
// (rigs/icom/icom.c:9908-9995, C_RD_TRXID = 0x19, S_RD_TRXID = 0x00) rather
// than from a forum post. Pure, so the wire behaviour is testable without a
// radio; the serial side lives in main/serial/civProbe.ts.

/** Frame delimiter, start and end. Two at the start, one at the end. */
export const CIV_PREAMBLE = 0xfe;
export const CIV_END = 0xfd;

/** The address a controller uses for itself. Hamlib's CTRLID. */
export const CIV_CONTROLLER_ADDRESS = 0xe0;

/**
 * The "everyone" address.
 *
 * Tried before Hamlib's exhaustive 0x01-0x7f sweep because it turns 127 probes
 * into one. It is not a substitute for the sweep -- a radio that ignores it is
 * an ordinary outcome, not a fault -- so the caller falls back rather than
 * concluding nothing is there.
 */
export const CIV_BROADCAST_ADDRESS = 0x00;

/** Read transceiver ID: the radio answers with its own CI-V address. */
export const CIV_CMD_READ_ID = 0x19;
export const CIV_SUB_READ_ID = 0x00;

/** Negative acknowledgement. An Icom that does not know command 0x19. */
export const CIV_NAK = 0xfa;

export interface CivFrame {
  /** Who sent it. On a reply, the radio's real address. */
  from: number;
  /** Who it is addressed to. */
  to: number;
  /** Everything between the addresses and the terminator. */
  payload: number[];
}

/**
 * FE FE <to> <from> <cmd> [sub] [data...] FD
 *
 * Read-only by construction for our use: 0x19/0x00 asks the radio to identify
 * itself and cannot key the transmitter. Nothing here should ever be used to
 * build a command that transmits -- keying goes through the profile's own
 * stored commands, where the operator can see it.
 */
export function buildCivFrame(to: number, from: number, payload: readonly number[]): Uint8Array {
  return Uint8Array.from([CIV_PREAMBLE, CIV_PREAMBLE, to, from, ...payload, CIV_END]);
}

/** The identity query, addressed to one radio or to the broadcast address. */
export function buildReadIdFrame(to: number): Uint8Array {
  return buildCivFrame(to, CIV_CONTROLLER_ADDRESS, [CIV_CMD_READ_ID, CIV_SUB_READ_ID]);
}

/**
 * Every complete frame in a buffer, ignoring anything that is not one.
 *
 * Deliberately tolerant about SURROUNDING noise and strict about frame shape.
 * The bus carries whatever else is on it, a port may hold stale bytes, and the
 * radio's own echo of our query arrives first when CI-V USB Echo Back is on --
 * which is an operator setting, so both cases have to work. What is NOT
 * tolerated is a malformed frame being read as a good one: a frame with no
 * addresses, or no terminator, is dropped rather than half-interpreted.
 */
export function parseCivFrames(bytes: Uint8Array | readonly number[]): CivFrame[] {
  const data = Array.from(bytes);
  const frames: CivFrame[] = [];

  let i = 0;
  while (i < data.length - 1) {
    if (data[i] !== CIV_PREAMBLE || data[i + 1] !== CIV_PREAMBLE) {
      i += 1;
      continue;
    }

    // Skip a run of preambles rather than assuming exactly two: some radios
    // send extra, and treating one as the "to" address would misread the frame.
    let start = i;
    while (start < data.length && data[start] === CIV_PREAMBLE) start += 1;

    const end = data.indexOf(CIV_END, start);
    if (end === -1) break; // truncated; wait for more bytes rather than guess
    // Needs at least the two addresses and one payload byte to mean anything.
    if (end - start >= 3) {
      frames.push({ to: data[start], from: data[start + 1], payload: data.slice(start + 2, end) });
    }
    i = end + 1;
  }

  return frames;
}

/**
 * The radio's address from a reply to the identity query, or null.
 *
 * Read out of the frame's `from` byte rather than assumed from what we asked
 * for -- which is the entire point of the broadcast probe, and what makes this
 * work for an operator who changed the address in the radio's menu.
 *
 * Our own echo is skipped: a frame FROM the controller address is the query
 * coming back, not an answer. So is a NAK, which means "an Icom is here but it
 * does not know this command" -- true, and not an address.
 */
export function radioAddressFromReply(frames: readonly CivFrame[]): number | null {
  for (const frame of frames) {
    if (frame.from === CIV_CONTROLLER_ADDRESS) continue;
    if (frame.payload[0] === CIV_NAK) continue;
    if (frame.payload[0] !== CIV_CMD_READ_ID) continue;
    if (frame.from === CIV_BROADCAST_ADDRESS) continue;
    return frame.from;
  }
  return null;
}

/** Formats an address the way Icom's own menus do: two hex digits. */
export function formatCivAddress(address: number): string {
  return `${address.toString(16).toUpperCase().padStart(2, "0")}h`;
}
