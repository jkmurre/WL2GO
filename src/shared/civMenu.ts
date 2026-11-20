// Reading and writing Icom's menu settings over CI-V: command 0x1A sub 0x05.
//
// This exists because Hamlib does not model these. icom_defs.h:395 calls
// S_MEM_PARM "rig parameters; extended parm # + param value: should be coded"
// and leaves it at that, so anything under it -- DATA MOD among them -- has to
// be addressed directly.
//
// THE SUB-ADDRESS IS PER MODEL AND MUST NEVER BE GUESSED. Hamlib's own tables
// prove why: ic7300.c carries separate cmdparams for the IC-7300 and the MkII
// and every shared setting sits at a different address in each --
//
//     setting        IC-7300      IC-7300 MkII
//     BEEP           00 23        00 24
//     BACKLIGHT      00 81        01 15
//     VOXDELAY       01 91        02 67
//
// -- so an address lifted from one model writes into an unrelated menu item on
// the other. A READ at the wrong address is harmless and is how the right one
// is found; see main/serial/civMenuProbe.ts.

import { CIV_CONTROLLER_ADDRESS, buildCivFrame, type CivFrame } from "./civFrame.ts";

/** Read/write a menu setting. Icom's "MEM" command with the parameter sub. */
export const CIV_CMD_MENU = 0x1a;
export const CIV_SUB_MENU_PARAM = 0x05;

/** Positive acknowledgement to a write. Its counterpart CIV_NAK lives in civFrame. */
export const CIV_ACK = 0xfb;

/**
 * A menu item's address: the two bytes following 1A 05.
 *
 * Kept as a pair rather than a single number because that is how Icom's own
 * reference and Hamlib's tables both write it, and flattening it to 0x0074
 * invites someone to do arithmetic on a value that is not an integer in any
 * meaningful sense.
 */
export interface CivMenuAddress {
  high: number;
  low: number;
}

export function formatMenuAddress(address: CivMenuAddress): string {
  const hex = (value: number) => value.toString(16).toUpperCase().padStart(2, "0");
  return `1A 05 ${hex(address.high)} ${hex(address.low)}`;
}

/** FE FE <radio> E0 1A 05 <hi> <lo> FD -- a read. Cannot key a transmitter. */
export function buildMenuReadFrame(radioAddress: number, address: CivMenuAddress): Uint8Array {
  return buildCivFrame(radioAddress, CIV_CONTROLLER_ADDRESS, [
    CIV_CMD_MENU,
    CIV_SUB_MENU_PARAM,
    address.high,
    address.low,
  ]);
}

/** FE FE <radio> E0 1A 05 <hi> <lo> <value> FD -- a write. */
export function buildMenuWriteFrame(
  radioAddress: number,
  address: CivMenuAddress,
  value: readonly number[],
): Uint8Array {
  return buildCivFrame(radioAddress, CIV_CONTROLLER_ADDRESS, [
    CIV_CMD_MENU,
    CIV_SUB_MENU_PARAM,
    address.high,
    address.low,
    ...value,
  ]);
}

/**
 * The value bytes from a reply to a read, or null.
 *
 * Matched on the ADDRESS as well as the command, not merely on "a 1A 05 frame
 * came back". A radio with CI-V transceive enabled sends unsolicited frames,
 * and our own query echoes back when USB Echo Back is on, so a reply has to be
 * proven to be the answer to THIS question before its bytes mean anything.
 */
export function menuValueFromReply(
  frames: readonly CivFrame[],
  address: CivMenuAddress,
): number[] | null {
  for (const frame of frames) {
    // Our own echo, addressed FROM the controller, is not an answer.
    if (frame.from === CIV_CONTROLLER_ADDRESS) continue;
    if (frame.payload[0] !== CIV_CMD_MENU || frame.payload[1] !== CIV_SUB_MENU_PARAM) continue;
    if (frame.payload[2] !== address.high || frame.payload[3] !== address.low) continue;

    const value = frame.payload.slice(4);
    // A frame with the address and nothing after it is the query coming back,
    // not a value. Reading it as an empty value would report "the menu is set
    // to nothing", which is not a state any menu has.
    if (value.length === 0) continue;
    return value;
  }
  return null;
}

/** Whether the radio acknowledged a write. A NAK, or silence, is not an ack. */
export function writeAcknowledged(frames: readonly CivFrame[]): boolean {
  return frames.some((frame) => frame.from !== CIV_CONTROLLER_ADDRESS && frame.payload[0] === CIV_ACK);
}

/**
 * Where DATA MOD lives, per Hamlib rig model, and what selects the USB codec.
 *
 * Keyed on the Hamlib model number because that is the one identifier a profile
 * with rig control always has. EMPTY IS THE CORRECT STATE for any radio whose
 * address has not been measured: the whole point of this module's header note
 * is that a plausible-looking address from a sibling model writes into the
 * wrong menu item.
 *
 * To add a radio, run `npm run find-menu-address`, which reports the address by
 * watching which setting changes when the operator flips it -- reads only, so a
 * wrong guess costs nothing. Then add the line here.
 *
 * A model that is absent is not an error. Setting the MODE to a DATA variant
 * already mutes the microphone on an Icom, which is the failure that matters;
 * DATA MOD only chooses between the USB codec and the ACC socket as the source.
 */
export interface DataModMenu {
  address: CivMenuAddress;
  /** The value meaning "take data audio from USB". */
  usb: number;
  /** For the log and the operator-facing message. */
  label: string;
}

export const DATA_MOD_MENUS: ReadonlyMap<number, DataModMenu> = new Map([
  // IC-7300 MkII, MEASURED on a real radio 2026-08-27 with
  // `npm run find-menu-address`: with DATA MOD on USB the address read 01, and
  // moving it to "MIC, USB" in the radio's own menu moved it to 03 -- the only
  // address in the scanned range that moved. Read back afterwards as 01 with
  // the setting returned to USB.
  //
  // 01 and 03 do not fit the manual's option ORDER, which is how it is known
  // that the byte is not an index: 01 = USB and 02 = MIC give 03 = "MIC, USB"
  // as a bitmask. Only the USB value below is measured; nothing here depends on
  // the rest of that reading being right.
  [3094, { address: { high: 0x00, low: 0x85 }, usb: 0x01, label: "USB" }],
  // 3073 (IC-7300) stays absent. Hamlib's own tables show the two models
  // disagree on every shared menu address, so the plain IC-7300's CANNOT be
  // inferred from the line above -- see the header. Measure it.
]);

export function dataModMenuFor(hamlibModel: number): DataModMenu | null {
  return DATA_MOD_MENUS.get(hamlibModel) ?? null;
}
