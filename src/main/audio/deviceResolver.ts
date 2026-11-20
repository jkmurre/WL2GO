import type { AudioDevice } from "../../shared/ipcContract.ts";
import type { AudioDeviceSelection } from "../../shared/configSchema.ts";
import { matchAudioSelection } from "../../shared/audioSelection.ts";

/**
 * Turns a saved device choice into the argument ardopcf is spawned with.
 *
 * Why WL2GO resolves this rather than letting ardopcf do it: ardopcf's own
 * ResolveDevice() (vendor PaSound.c) treats a non-numeric argument as a
 * CASE-INSENSITIVE SUBSTRING and takes the first device that matches. So
 * "USB Audio Device" silently picks one of two identical dongles, and a name
 * that matches nothing makes ardopcf exit during startup -- which reaches the
 * operator as "the modem failed to start", naming nothing.
 *
 * A fully numeric argument takes a different path in that same function:
 * strtol, then a bounds and direction check, returning paNoDevice rather than
 * falling through to the substring match. So resolving here and passing an
 * INDEX is unambiguous by construction, and every failure gets named before a
 * process is ever spawned.
 *
 * WHICH device a selection points at is decided by matchAudioSelection in
 * shared/, not here. The renderer's pickers ask the same question and used to
 * answer it differently -- claiming a device was absent when its index had
 * merely moved, while this function opened it without complaint. This module
 * owns only what main needs on top: the ardopcf argument, and the wording an
 * operator reads.
 *
 * Pure, so every branch below is unit tested without hardware.
 */

export type ResolvedAudioDevice =
  | {
      ok: true;
      /** The argument for ardopcf: a decimal index, or "DEFAULT". */
      argument: string;
      device: AudioDevice | null;
      /** Set when the index moved since the profile was saved. Informational. */
      movedFrom?: number;
      /** Non-fatal, worth showing. Never a reason to refuse. */
      warnings: string[];
    }
  | {
      ok: false;
      reason: "absent" | "ambiguous";
      message: string;
    };

/**
 * A null selection means "system default", which is a legitimate choice rather
 * than a missing one -- ardopcf's ResolveDevice() maps "DEFAULT" onto
 * Pa_GetDefaultInputDevice/OutputDevice.
 */
export function resolveAudioDevice(
  selection: AudioDeviceSelection | null,
  devices: AudioDevice[],
  direction: "capture" | "playback",
): ResolvedAudioDevice {
  const label = direction === "capture" ? "input" : "output";
  const match = matchAudioSelection(selection, devices, direction);

  if (match.kind === "absent") {
    return {
      ok: false,
      reason: "absent",
      message:
        `The audio ${label} "${selection?.name ?? ""}" is not connected. ` +
        (match.available.length
          ? `Available: ${match.available.map((d) => d.name).join(", ")}.`
          : `No audio ${label} devices were found at all.`),
    };
  }

  if (match.kind === "ambiguous") {
    // Several devices share this name and the saved index no longer points at
    // any of them. Guessing would be a coin flip on which radio transmits, so
    // say so instead and let the operator pick.
    return {
      ok: false,
      reason: "ambiguous",
      message:
        `There are ${match.candidates.length} audio ${label} devices called "${selection?.name ?? ""}" ` +
        `(indices ${match.candidates.map((d) => d.index).join(", ")}), and the one this profile ` +
        `was saved with is gone. Choose it again in the profile.`,
    };
  }

  if (match.kind === "default") {
    return { ok: true, argument: "DEFAULT", device: match.device, warnings: [] };
  }

  const chosen = match.device;
  const warnings: string[] = [];

  if (match.kind === "tiebreak") {
    // The index tiebreak resolved it, but it is a heuristic: PortAudio exposes
    // no serial number or USB path, so if the two devices swapped indices this
    // is confidently wrong. Say so rather than imply certainty.
    warnings.push(
      `More than one audio ${label} is called "${chosen.name}". WL2GO picked index ` +
        `${chosen.index} because that is what this profile was saved with. If the wrong ` +
        `radio responds, choose the device again.`,
    );
  }

  // Orthogonal to how the device was matched -- it depends only on the device
  // landed on -- so it is appended after the mapping rather than carried by the
  // matcher.
  //
  // Advisory only. ardopcf never asks Pa_IsFormatSupported -- it just opens the
  // stream -- and CoreAudio resamples transparently, so this prediction can be
  // wrong in the operator's favour. Refusing here would strand working
  // hardware; the open in testAudioDevices is the real answer.
  if (!chosen.supports12k) {
    warnings.push(
      `"${chosen.name}" may not support the 12000 Hz the modem uses. That is a prediction, ` +
        `not a verdict -- some drivers convert the rate themselves. Test it to find out.`,
    );
  }

  return {
    ok: true,
    argument: String(chosen.index),
    device: chosen,
    ...(match.kind === "moved" ? { movedFrom: match.from } : {}),
    warnings,
  };
}

/** Records what to save for a device the operator just picked. */
export function toSelection(device: AudioDevice): AudioDeviceSelection {
  return { name: device.name, index: device.index, hostApi: device.hostApi };
}
