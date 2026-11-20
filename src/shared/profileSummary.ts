import { materialiseProfile, type PttConfig, type RadioProfile, type RadioProfileInput } from "./configSchema.ts";
import { txModeLabel } from "./rigModes.ts";

/**
 * The one-line summary shown under a profile's name in Settings.
 *
 * Lives here rather than in the component because .tsx cannot be type-stripped
 * by node:test, and this needs a test: it reads fields whose SHAPE has already
 * changed once (schema 2 turned the audio selections from strings into
 * objects), and a template literal renders an object as "[object Object]"
 * without any complaint from tsc. A display helper over a schema that migrates
 * is exactly the thing to keep testable.
 */
export function describeProfile(profile: RadioProfile): string {
  if (profile.interface.type === "lan") {
    const { host, controlPort } = profile.interface.lan;
    // Only the control port is shown. All three are stored and all three are
    // editable, but a summary listing them reads as a port scan rather than as
    // "which radio is this" -- and the control port is the one an operator
    // recognises as the radio's address.
    return `Network · ${host || "no host"}:${controlPort}`;
  }

  const usb = profile.interface.usb;
  // A null selection means "use the system default", which is a real choice
  // rather than a missing one -- see resolveAudioDevice.
  const audioIn = usb.audioInput?.name ?? "system default in";
  const audioOut = usb.audioOutput?.name ?? "system default out";
  const audio = audioIn === audioOut ? audioIn : `${audioIn} / ${audioOut}`;

  return `USB · ${usb.serialPort ?? "no serial port"} · ${audio} · ${describePtt(profile.ptt)} · ${describeRigControl(profile)}`;
}

/**
 * Whether WL2GO drives this radio, in a few words.
 *
 * Shown for BOTH answers rather than only when a rig is set. "No rig control"
 * is the state in which the operator has to tune and set the mode themselves,
 * and a summary that simply omits the line reads as though tuning is handled --
 * which is exactly the assumption that produced a call on the wrong frequency
 * in the wrong mode.
 */
export function describeRigControl(profile: RadioProfile): string {
  if (!profile.hamlib) return "no rig control — tune by hand";
  return `rig control on ${profile.hamlib.device ?? "no CAT port"} · ${txModeLabel(profile.txMode)}`;
}

/**
 * How the radio keys, in a few words.
 *
 * Its own function, and tested, for the reason this whole module exists: `ptt`
 * is an object, and interpolating one into a template literal renders
 * "[object Object]" with no complaint from tsc. That has already shipped once.
 */
export function describePtt(ptt: PttConfig): string {
  switch (ptt.method) {
    case "none":
      return "VOX";
    case "rts":
      return `PTT via RTS on ${ptt.port ?? "no port"}`;
    case "cat":
      return `PTT via CAT on ${ptt.port ?? "no port"}`;
    case "rigctld":
      // No address to name: this method keys through the profile's own rig,
      // which describeRigControl reports separately.
      return "PTT through rig control";
  }
}

/**
 * The same summary, for a profile that has not been saved yet.
 *
 * The wizard's review step has a RadioProfileInput rather than a RadioProfile,
 * and must not grow a second summariser: this one exists precisely because a
 * duplicate of it rendered "[object Object]" once already. materialiseProfile
 * fills the gaps exactly as the store will, so what the review step shows is
 * what the profile becomes -- including an unparseable port falling back to the
 * default, which validateProfile has already refused by the time this is read.
 */
export function describeProfileInput(input: RadioProfileInput): string {
  return describeProfile(materialiseProfile(input, input.id ?? "preview"));
}
