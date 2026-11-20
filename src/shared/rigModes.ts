// Transmit mode, in three vocabularies that must not drift apart: what the
// operator picks, what Hamlib calls it, and what it reads as on screen.
//
// Pure and shared because all three are used in different processes -- the
// profile editor renders the labels, the main process sends the Hamlib name,
// and the readiness check quotes it back in a warning. A second copy of this
// mapping is how "USB-DATA" ends up selecting USB somewhere.

import type { TxMode } from "./configSchema.ts";

/**
 * Hamlib's mode names, from rig.h's RIG_MODE_* and what rigctld accepts on
 * `\set_mode`.
 *
 * PKTUSB/PKTLSB are the DATA variants, and on Icom they are what makes the
 * radio take its modulation from the sound card instead of the microphone --
 * Hamlib sends CI-V 0x26 with the data-mode flag for any backend declaring
 * `.data_mode_supported = 1`, which the IC-7300 family does
 * (rigs/icom/ic7300.c:499). Plain USB is what WL2GO left the radio in before
 * this existed, and it is why an operator's voice reached the transmitter.
 */
export type HamlibMode = "USB" | "LSB" | "PKTUSB" | "PKTLSB";

/**
 * "auto" resolves to USB-DATA.
 *
 * Every HF Winlink ARDOP gateway publishes an upper-sideband dial frequency,
 * on every band -- the 40m and 80m ones included, where voice convention would
 * say LSB. Data modes do not follow that convention, so "the band is below
 * 10 MHz" is NOT a reason to pick LSB here, and deriving the sideband from the
 * frequency would put the radio on the wrong one for most of the band plan.
 */
export function hamlibMode(txMode: TxMode): HamlibMode {
  switch (txMode) {
    case "auto":
    case "usb-data":
      return "PKTUSB";
    case "lsb-data":
      return "PKTLSB";
    case "usb":
      return "USB";
    case "lsb":
      return "LSB";
  }
}

/** What the picker shows. */
export function txModeLabel(txMode: TxMode): string {
  switch (txMode) {
    case "auto":
      return "Automatic (USB-DATA)";
    case "usb-data":
      return "USB-DATA";
    case "lsb-data":
      return "LSB-DATA";
    case "usb":
      return "USB";
    case "lsb":
      return "LSB";
  }
}

/**
 * The one-line consequence of each choice, shown under the picker.
 *
 * The DATA distinction is the entire point of this control and is invisible
 * from the name, so it is spelled out rather than left to be discovered on the
 * air.
 */
export function txModeNote(txMode: TxMode): string {
  switch (txMode) {
    case "auto":
      return "USB-DATA, which is right for every Winlink gateway on HF.";
    case "usb-data":
    case "lsb-data":
      return "A DATA mode: the radio transmits the sound card, not the microphone.";
    case "usb":
    case "lsb":
      return "NOT a data mode. Most radios transmit the microphone in this mode, so anything said near the radio goes out on the air. Pick a DATA mode unless you know this radio is wired otherwise.";
  }
}

/**
 * Whether a mode the radio reported back is the one we asked for.
 *
 * Compared leniently on case and whitespace only. It is deliberately NOT
 * lenient about USB vs PKTUSB: those differ by exactly the thing that decides
 * whether the microphone is live, and treating them as equivalent would defeat
 * the read-back entirely.
 */
export function modeMatches(reported: string | null, wanted: HamlibMode): boolean {
  return (reported ?? "").trim().toUpperCase() === wanted;
}
