// Matching a SAVED audio device choice against the devices present right now.
//
// This lives in shared/ because two callers need the identical answer and used
// to compute it separately:
//
//   - main's deviceResolver.ts, which turns the match into the argument ardopcf
//     is spawned with;
//   - the renderer's device pickers, which have to say what the operator's
//     saved profile currently points at.
//
// They disagreed. The renderer required an exact index match whenever one had
// been recorded, so a device whose PortAudio index had shifted -- the ordinary
// consequence of plugging anything in -- rendered as "not currently connected"
// while the resolver happily opened it. Module 7 measured exactly that shift
// ("MacBook Pro Microphone" was index 1 with nothing attached and index 2 with
// a USB codec plugged in). One matcher, consumed by both, is the fix.
//
// Pure and .ts rather than .tsx so node:test can type-strip it: this reads a
// field whose SHAPE has already changed once (schema 2 turned the audio
// selections from strings into objects), which is precisely the kind of code
// that needs a test rather than a careful reading.

import type { AudioDevice } from "./ipcContract.ts";
import type { AudioDeviceSelection } from "./configSchema.ts";

/**
 * What a saved selection points at, given a listing.
 *
 * Six outcomes rather than the obvious three, because "resolved" and "not
 * resolved" both split further in ways the operator needs told apart: a device
 * that moved is fine but worth mentioning, and a device picked out of several
 * sharing a name was picked on a heuristic that can be confidently wrong.
 */
export type SelectionMatch =
  /** No selection was saved, which means "use the system default" -- a real choice. */
  | { kind: "default"; device: AudioDevice | null }
  /** Exactly one device has this name, and the saved index agrees or was never recorded. */
  | { kind: "exact"; device: AudioDevice }
  /** Exactly one device has this name, but its index has shifted since it was saved. */
  | { kind: "moved"; device: AudioDevice; from: number }
  /** Several devices share this name; the saved index singled one out. A heuristic. */
  | { kind: "tiebreak"; device: AudioDevice; candidates: AudioDevice[] }
  /** Nothing present has this name. */
  | { kind: "absent"; available: AudioDevice[] }
  /** Several devices share this name and the saved index matches none of them. */
  | { kind: "ambiguous"; candidates: AudioDevice[] };

/**
 * Resolves a saved selection against the current listing.
 *
 * Only devices facing the given direction are considered: the same hardware is
 * listed once per direction, and handing ardopcf a capture index for a playback
 * slot is rejected by its own bounds-and-direction check.
 *
 * A direction with no devices at all yields `absent` (or `default`, when
 * nothing was saved) rather than throwing -- an empty listing is what an
 * unplugged shack looks like, not an error.
 */
export function matchAudioSelection(
  selection: AudioDeviceSelection | null,
  devices: AudioDevice[],
  direction: "capture" | "playback",
): SelectionMatch {
  const available = devices.filter((d) => d.direction === direction);

  if (selection === null) {
    return { kind: "default", device: available.find((d) => d.isDefault) ?? null };
  }

  const candidates = available.filter((d) => d.name === selection.name);

  if (candidates.length === 0) return { kind: "absent", available };

  if (candidates.length === 1) {
    const device = candidates[0];
    // The name is the durable half of a selection and the index is only ever a
    // tiebreak, so a sole match wins even when the index has moved. Reporting
    // the move rather than swallowing it keeps the UI able to say why the
    // number on screen is not the number in the file.
    return selection.index >= 0 && selection.index !== device.index
      ? { kind: "moved", device, from: selection.index }
      : { kind: "exact", device };
  }

  const device = candidates.find((d) => d.index === selection.index);
  // A saved index of -1 (schema 1 recorded no index) reaches here only when
  // several devices share the name, and it deliberately matches none of them:
  // "no tiebreak recorded" cannot break a tie.
  return device ? { kind: "tiebreak", device, candidates } : { kind: "ambiguous", candidates };
}

/** The device a match landed on, or null when it did not resolve. */
export function matchedDevice(match: SelectionMatch): AudioDevice | null {
  switch (match.kind) {
    case "default":
      return match.device;
    case "exact":
    case "moved":
    case "tiebreak":
      return match.device;
    case "absent":
    case "ambiguous":
      return null;
  }
}

/**
 * Names that more than one device in a listing shares.
 *
 * Two identical USB dongles is an ordinary two-radio shack, and PortAudio
 * exposes no serial number or USB path to tell them apart, so the only thing
 * that distinguishes them in a dropdown is the index -- which is worth showing
 * only when it is actually needed.
 */
export function duplicatedNames(devices: AudioDevice[]): Set<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const device of devices) {
    if (seen.has(device.name)) duplicated.add(device.name);
    seen.add(device.name);
  }
  return duplicated;
}

/**
 * Labels a device with what distinguishes it from its neighbours.
 *
 * The duplicate marker and the rate note matter most: anything that helps the
 * operator tell two identically-named dongles apart earns its place, and
 * anything that does not would just be clutter.
 */
export function describeDevice(device: AudioDevice, duplicated = false): string {
  const notes: string[] = [];
  // Only shown when it is needed to tell two entries apart, so the ordinary
  // case is not cluttered with a number that means nothing to the operator.
  if (duplicated) notes.push(`device ${device.index}`);
  if (device.isDefault) notes.push("system default");
  // Advisory: ardopcf opens the stream regardless, and some drivers convert the
  // rate themselves. Worth flagging, never worth hiding the device for.
  if (!device.supports12k) notes.push("may not support 12000 Hz");
  return notes.length ? `${device.name} (${notes.join(", ")})` : device.name;
}
