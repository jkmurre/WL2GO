// The Radio Profile wizard's step machine, as data rather than as component state.
//
// It lives here, in shared/ and as .ts, for the reason Module 7 learned the hard
// way: .tsx cannot be type-stripped by node:test, and the [object Object] bug
// that shipped in the profile summary was display logic over a migrating schema
// sitting somewhere no test could reach. A wizard has strictly MORE of that kind
// of logic than the flat form it replaces -- step sequencing, per-step gating,
// a review summary -- so all of it is here and the .tsx is a renderer over it.
//
// Both the guided wizard (new profiles) and the single-page editor (existing
// ones) are built on WizardDraft and toProfileInput, so the two cannot drift
// into disagreeing about what they collect.

import {
  DEFAULT_ARDOP_HOST_PORT,
  DEFAULT_BUSYDET_LEVEL,
  DEFAULT_DRIVE_LEVEL,
  DEFAULT_ICOM_AUDIO_PORT,
  DEFAULT_ICOM_CIV_PORT,
  DEFAULT_ICOM_CONTROL_PORT,
  DEFAULT_PTT_BAUD,
  defaultPtt,
  normaliseHexCommand,
  validateProfile,
  type AudioDeviceSelection,
  type PttConfig,
  type PttMethod,
  type RadioProfile,
  type RadioProfileInput,
  type TxMode,
  DEFAULT_RIGCTLD_PORT,
  type HamlibConfig,
} from "./configSchema.ts";
import { DEFAULT_PRESET_ID, findPreset } from "./pttPresets.ts";

/**
 * A profile being built or edited.
 *
 * The two ports are held as TEXT, not numbers: a form owns a half-typed value,
 * and "" or "85" must be representable without becoming NaN or 0 on the way
 * through. They are parsed once, in toProfileInput.
 */
export interface WizardDraft {
  name: string;
  kind: "usb" | "lan";
  /** Empty means "not selected", which is legal -- rig control is Module 10. */
  serialPort: string;
  /** Null means "use the system default", a real choice rather than a missing one. */
  audioInput: AudioDeviceSelection | null;
  audioOutput: AudioDeviceSelection | null;
  host: string;
  /** Icom's three ports, as text for the same reason the others are. */
  controlPort: string;
  civPort: string;
  audioPort: string;
  username: string;
  hostPort: string;
  pttMethod: PttMethod;
  /**
   * Serial path for rts/cat, "" for none and for rigctld.
   *
   * rigctld carries no port of its own any more: it means "Pat keys the radio
   * through this profile's rig", so the port it uses is the rig's.
   */
  pttPort: string;
  pttBaud: string;
  /** Raw as typed; normalised only in toProfileInput. */
  pttKeyHex: string;
  pttUnkeyHex: string;
  /**
   * Transmit drive, 0-100. A number rather than a string like the other
   * numerics, because it comes from a slider and a slider cannot produce
   * something un-parseable halfway through being typed.
   */
  driveLevel: number;
  /**
   * ardopcf's BUSYDET, 0-10, as text. Raw as typed, like the ports and baud
   * rates -- unlike driveLevel, this comes from a keyboard, and a field
   * that snapped a half-typed or momentarily-blank value to a number would
   * not let the operator backspace and retype. Parsed once, in
   * toProfileInput. See RadioProfile.busyDetLevel.
   */
  busyDetLevel: string;
  /**
   * Hamlib rig model number as text, "" for "no rig control".
   *
   * Text like the ports and for the same reason: a picker's empty value has to
   * be representable without becoming 0, which parseHamlib would read as a
   * model and reject.
   */
  rigModel: string;
  /** The radio's CAT serial port. Empty is not valid once a model is chosen. */
  rigPort: string;
  rigBaud: string;
  /** Where WL2GO's rigctld listens, and what Pat is pointed at. */
  rigctldPort: string;
  txMode: TxMode;
  /** Offered on the review step; the store makes the first profile active anyway. */
  makeActive: boolean;
}

export type WizardStep = "identity" | "audio" | "rig" | "test" | "lan" | "review";

/**
 * The steps for one branch, in order: collect, then verify, then review.
 *
 * The LAN branch has no audio or test step, and the reason is now specific
 * rather than pending. A networked Icom carries its audio on its own UDP port
 * in Icom's framed protocol; ardopcf can only open PortAudio devices
 * (PaSound.c:705), and bundled Hamlib has no Icom LAN support at all -- its one
 * Icom-UDP branch is #if 0 (src/rig.c:1210-1222). So no modem is started for a
 * LAN profile, and an audio picker or a device test there would be controls
 * with nothing behind them. Both arrive with the Icom LAN transport module.
 */
export function wizardSteps(kind: "usb" | "lan"): WizardStep[] {
  return kind === "lan"
    ? ["identity", "lan", "review"]
    : ["identity", "audio", "rig", "test", "review"];
}

export function emptyDraft(): WizardDraft {
  return {
    name: "",
    kind: "usb",
    serialPort: "",
    audioInput: null,
    audioOutput: null,
    host: "",
    controlPort: String(DEFAULT_ICOM_CONTROL_PORT),
    civPort: String(DEFAULT_ICOM_CIV_PORT),
    audioPort: String(DEFAULT_ICOM_AUDIO_PORT),
    username: "",
    hostPort: String(DEFAULT_ARDOP_HOST_PORT),
    pttMethod: "none",
    pttPort: "",
    pttBaud: String(DEFAULT_PTT_BAUD),
    pttKeyHex: "",
    pttUnkeyHex: "",
    driveLevel: DEFAULT_DRIVE_LEVEL,
    busyDetLevel: String(DEFAULT_BUSYDET_LEVEL),
    // Rig control OFF by default. It is opt-in on purpose: WL2GO tuning and
    // re-moding a radio the operator did not ask it to touch would be worse
    // than not doing it, and a wrong model number drives the wrong radio.
    rigModel: "",
    rigPort: "",
    rigBaud: String(DEFAULT_PTT_BAUD),
    rigctldPort: String(DEFAULT_RIGCTLD_PORT),
    txMode: "auto",
    makeActive: true,
  };
}

/** Loads an existing profile for editing, without losing the branch it is not on. */
export function draftFromProfile(profile: RadioProfile): WizardDraft {
  const base = emptyDraft();
  const usb = profile.interface.type === "usb" ? profile.interface.usb : null;
  const lan = profile.interface.type === "lan" ? profile.interface.lan : null;

  return {
    ...base,
    name: profile.name,
    kind: profile.interface.type,
    hostPort: String(profile.ardop.hostPort),
    serialPort: usb?.serialPort ?? "",
    audioInput: usb?.audioInput ?? null,
    audioOutput: usb?.audioOutput ?? null,
    host: lan?.host ?? "",
    controlPort: String(lan?.controlPort ?? DEFAULT_ICOM_CONTROL_PORT),
    civPort: String(lan?.civPort ?? DEFAULT_ICOM_CIV_PORT),
    audioPort: String(lan?.audioPort ?? DEFAULT_ICOM_AUDIO_PORT),
    username: lan?.username ?? "",
    rigModel: profile.hamlib ? String(profile.hamlib.model) : "",
    rigPort: profile.hamlib?.device ?? "",
    rigBaud: String(profile.hamlib?.baud ?? DEFAULT_PTT_BAUD),
    rigctldPort: String(profile.hamlib?.port ?? DEFAULT_RIGCTLD_PORT),
    txMode: profile.txMode,
    pttMethod: profile.ptt.method,
    pttPort: profile.ptt.port ?? "",
    pttBaud: String(profile.ptt.baud),
    // Seeded when a stored CAT profile has no commands at all.
    //
    // This overwrites nothing meaningful: CAT with empty commands cannot key
    // the radio, and validateProfile already refuses to save it -- so the only
    // state being replaced is one that was never valid. Profiles created before
    // there was a radio picker are all in exactly that state, and showing their
    // owner two empty hex boxes is what made this unusable.
    ...catCommandsFor(profile.ptt),
    driveLevel: profile.driveLevel,
    busyDetLevel: String(profile.busyDetLevel),
    // Editing an existing profile must never quietly re-point the active one.
    makeActive: false,
  };
}

/**
 * A stored CAT profile's commands, defaulted when it has none.
 *
 * Only ever fills a blank. A profile carrying real commands -- a preset, or hex
 * from a radio manual -- is returned untouched, so nothing an operator typed is
 * ever replaced by a guess.
 */
function catCommandsFor(ptt: PttConfig): { pttKeyHex: string; pttUnkeyHex: string } {
  const blank = ptt.keyHex.length === 0 && ptt.unkeyHex.length === 0;
  if (ptt.method !== "cat" || !blank) {
    return { pttKeyHex: ptt.keyHex, pttUnkeyHex: ptt.unkeyHex };
  }
  const preset = findPreset(DEFAULT_PRESET_ID);
  return { pttKeyHex: preset?.keyHex ?? "", pttUnkeyHex: preset?.unkeyHex ?? "" };
}

/**
 * The draft as the config store wants it. Supply an id to update a profile,
 * omit it to create one.
 *
 * A blank port field becomes NaN here on purpose rather than silently falling
 * back to the default: validateProfile rejects it, so the operator is told the
 * field is wrong instead of having a value invented for them. materialiseProfile
 * applies the default only for a port that was never supplied at all.
 */
export function toProfileInput(draft: WizardDraft, id?: string): RadioProfileInput {
  const base = {
    ...(id ? { id } : {}),
    name: draft.name,
    ardop: { hostPort: Number.parseInt(draft.hostPort, 10) },
    hamlib: hamlibFromDraft(draft),
    txMode: draft.txMode,
    ptt: pttFromDraft(draft),
    driveLevel: draft.driveLevel,
    // A blank or half-typed field becomes NaN here on purpose, same as the
    // ports above: validateProfile rejects it rather than a default being
    // invented for a value the operator was actively typing.
    busyDetLevel: Number.parseInt(draft.busyDetLevel, 10),
  };

  if (draft.kind === "lan") {
    return {
      ...base,
      interface: {
        type: "lan",
        lan: {
          host: draft.host,
          controlPort: Number.parseInt(draft.controlPort, 10),
          civPort: Number.parseInt(draft.civPort, 10),
          audioPort: Number.parseInt(draft.audioPort, 10),
          username: draft.username,
        },
      },
    };
  }

  return {
    ...base,
    interface: {
      type: "usb",
      usb: {
        serialPort: draft.serialPort || null,
        audioInput: draft.audioInput,
        audioOutput: draft.audioOutput,
      },
    },
  };
}

/**
 * The draft's PTT fields as the schema wants them.
 *
 * The hex strings are normalised HERE and nowhere earlier, so the operator can
 * type "FE FE 94 E0 1C 00 01 FD" -- which is how CI-V commands are written down
 * -- and still have ardopcf receive the only form it can parse. An unparseable
 * string becomes "", which validateProfile then rejects by name; silently
 * dropping it would leave a radio that never keys and nothing saying why.
 */
export function pttFromDraft(draft: WizardDraft): PttConfig {
  if (draft.pttMethod === "none") return defaultPtt();
  return {
    method: draft.pttMethod,
    // Deliberately empty for rigctld: that method keys through the profile's
    // RIG, so a port here would be a second, contradictory answer to "which
    // serial device?" -- and validateRigControl compares ptt.port against the
    // rig's device to catch exactly that contradiction.
    port: draft.pttMethod === "rigctld" ? null : draft.pttPort.trim() || null,
    baud: Number.parseInt(draft.pttBaud, 10),
    keyHex: normaliseHexCommand(draft.pttKeyHex) ?? "",
    unkeyHex: normaliseHexCommand(draft.pttUnkeyHex) ?? "",
  };
}

/**
 * The draft's rig-control fields as the schema wants them, or null for none.
 *
 * An empty model is the OFF switch and has to survive as null rather than
 * becoming 0: parseHamlib treats a non-positive model as no rig, but going
 * through a number first would make "" and "0" and a half-typed "3" all look
 * alike on the way to validateProfile.
 */
export function hamlibFromDraft(draft: WizardDraft): HamlibConfig | null {
  const model = Number.parseInt(draft.rigModel, 10);
  if (!Number.isInteger(model) || model <= 0) return null;
  return {
    model,
    device: draft.rigPort.trim() || null,
    baud: Number.parseInt(draft.rigBaud, 10),
    port: Number.parseInt(draft.rigctldPort, 10),
  };
}

/**
 * What stops the operator leaving this step, as sentences fit to show.
 *
 * This PARTITIONS validateProfile rather than restating it. Module 1's binding
 * invariant is that the form and the store share one validator so they "can
 * never disagree about what is acceptable", and a wizard that grew its own
 * per-step rules would be exactly that disagreement, arriving one step at a
 * time. stepIssues therefore calls validateProfile and routes each message to
 * the step that owns the field; profileWizard.test.ts asserts the routing is
 * total, so a new validation rule cannot go unreachable.
 *
 * Note what is NOT gated: the audio and test steps return [], always. An empty
 * USB selection is legal on purpose (configSchema.ts) -- an operator may build a
 * profile for a radio that is not plugged in yet, and a wizard that insisted on
 * a pick per step would silently narrow what the schema permits. Same rule as
 * addressWarnings(), 12k=, and labelled-not-hidden serial ports: warn, never
 * block.
 *
 * The "rig" step is the one exception, and it is narrower than it looks. It
 * blocks only on a PTT configuration that CONTRADICTS ITSELF -- "key by CAT
 * command" with no command to send -- never on hardware being absent. Choosing
 * a keying method and then giving it nothing to work with is not a radio that
 * has yet to be plugged in; it is a setting that cannot mean anything.
 *
 * A step that is not in this draft's branch returns [] -- asking about "lan" on
 * a USB draft is meaningless rather than wrong, and giving it a defined answer
 * keeps the invariant test's domain total.
 */
export function stepIssues(draft: WizardDraft, step: WizardStep): string[] {
  if (!wizardSteps(draft.kind).includes(step)) return [];

  const all = validateProfile(toProfileInput(draft));

  switch (step) {
    case "identity":
      return all.filter((issue) => ownedByIdentity(issue));
    case "lan":
      return all.filter((issue) => ownedByLan(issue));
    case "rig":
      // The one hardware step that CAN block, and only ever on a
      // self-contradictory PTT setup -- never on absent hardware. See the note
      // below on what stays ungated.
      return all.filter((issue) => ownedByPtt(issue));
    case "review":
      // The last gate before saving, and the only one that can see a problem
      // belonging to a step the operator skipped past -- the ARDOP host port
      // lives under a disclosure here, so nothing else claims its message.
      return all.filter(
        (issue) => !ownedByIdentity(issue) && !ownedByLan(issue) && !ownedByPtt(issue) && !ownedByDrive(issue),
      );
    case "test":
      // Where the drive slider lives. Nothing else on this step can block: the
      // sound-card and keying checks report in place and never gate a save.
      return all.filter((issue) => ownedByDrive(issue));
    case "audio":
      return [];
  }
}

// The three routing predicates below are matched against validateProfile's own
// wording. That coupling is deliberate and is what the totality test guards: if
// a message is reworded or added and nothing claims it, "review" still catches
// it (so a profile can never be saved invalid) and the test fails loudly enough
// to send someone back here.
function ownedByIdentity(issue: string): boolean {
  return issue.includes("needs a name") || issue.includes("Unsupported mode");
}

function ownedByLan(issue: string): boolean {
  // Each of Icom's three ports is named separately, so this matches the shape
  // rather than a single "LAN port" literal that no longer exists.
  return issue.includes("LAN profile needs a host") || /The LAN \S+ port must be/.test(issue);
}

function ownedByPtt(issue: string): boolean {
  return issue.startsWith("PTT ") || issue.startsWith("The PTT ");
}

function ownedByDrive(issue: string): boolean {
  return issue.includes("transmit drive level");
}

/** True when every step in this branch is clear, so the profile can be saved. */
export function canSave(draft: WizardDraft): boolean {
  return validateProfile(toProfileInput(draft)).length === 0;
}

/** The next step in this branch, or null on the last one. */
export function nextStep(draft: WizardDraft, step: WizardStep): WizardStep | null {
  const steps = wizardSteps(draft.kind);
  return steps[steps.indexOf(step) + 1] ?? null;
}

/** The previous step in this branch, or null on the first one. */
export function previousStep(draft: WizardDraft, step: WizardStep): WizardStep | null {
  const steps = wizardSteps(draft.kind);
  const index = steps.indexOf(step);
  return index > 0 ? steps[index - 1] : null;
}

/**
 * Where to land after the operator switches branch mid-wizard.
 *
 * Their current step may not exist in the new branch (audio has no LAN
 * equivalent), and dropping them at the start would throw away the name they
 * already typed. Falling back to the branch's first step after identity keeps
 * the work and stays somewhere real.
 */
export function stepAfterKindChange(kind: "usb" | "lan", step: WizardStep): WizardStep {
  const steps = wizardSteps(kind);
  return steps.includes(step) ? step : (steps[1] ?? "identity");
}

/** Titles and the one-line explanation each step leads with. */
export const STEP_COPY: Record<WizardStep, { title: string; lead: string }> = {
  identity: {
    title: "Which radio is this?",
    lead: "Give this setup a name you will recognise, and say how the radio is connected.",
  },
  audio: {
    title: "Sound card",
    lead: "The modem listens and transmits through your radio's USB audio device. Pick it for both directions.",
  },
  rig: {
    title: "Radio control",
    lead: "Optional. WL2GO records the port your radio's CAT connection uses; controlling the radio through it comes in a later version.",
  },
  test: {
    title: "Check the sound card",
    lead: "This starts the modem briefly and opens the devices you chose, which is the only way to know they work.",
  },
  lan: {
    title: "Network connection",
    lead: "Where the radio's control channel lives on your network.",
  },
  review: {
    title: "Ready to save",
    lead: "Everything WL2GO needs to reach this radio.",
  },
};
