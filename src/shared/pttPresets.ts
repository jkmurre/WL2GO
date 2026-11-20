// The radios whose CAT keying commands WL2GO already knows.
//
// This exists because two empty hex boxes are not a usable control. An operator
// who has never seen a CI-V frame has no way to fill them in, and getting them
// wrong produces a radio that dials and never transmits -- with nothing on
// screen naming the cause. A model picker turns that into a choice from a list.
//
// Pure and shared so the picker, the CI-V prober and the profile summary all
// read one table. A preset the prober can find but the picker cannot show would
// be a detection that fills in "custom".

import { icomPttCommands } from "./configSchema.ts";

export type RadioMake = "icom" | "kenwood" | "yaesu" | "other";

export interface PttPreset {
  /** Stable id, stored nowhere -- derived from the hex when a profile loads. */
  id: string;
  label: string;
  make: RadioMake;
  /** Icom only. What the CI-V prober matches a detected address against. */
  civAddress: number | null;
  keyHex: string;
  unkeyHex: string;
  /** Shown under the picker, so a preset is never an unexplained magic string. */
  note: string;
}

/** The id used when the operator is typing their own commands. */
export const CUSTOM_PRESET_ID = "custom";

/**
 * Icom's PTT is one CI-V command with the radio's address baked in, so these
 * are generated rather than transcribed -- the same helper the schema uses.
 *
 * Addresses are the factory defaults, taken from Hamlib's own rig definitions
 * (rigs/icom/ic7300.c:400,509,615,671 and ic7610.c:161) rather than from a web
 * page -- Hamlib is bundled, so the source is checkable and stays checkable.
 *
 * An operator who changed the address in the radio's menu is covered twice
 * over: the prober reads the real address off the radio, and the raw commands
 * stay editable.
 */
function icom(id: string, label: string, civAddress: number): PttPreset {
  return {
    id,
    label,
    make: "icom",
    civAddress,
    ...icomPttCommands(civAddress),
    note: `CI-V address ${civAddress.toString(16).toUpperCase().padStart(2, "0")}h, Icom's default for this model. Change it below if you set a different address in the radio.`,
  };
}

/**
 * Kenwood and Elecraft key with ASCII text, not binary -- "TX;" and "RX;" --
 * which ardopcf still wants as hex because its parser reads nothing else.
 * 54/58/3B is "T","X",";".
 */
const KENWOOD_KEY = "54583B";
const KENWOOD_UNKEY = "52583B";

export const PTT_PRESETS: readonly PttPreset[] = [
  icom("icom-ic7300", "Icom IC-7300", 0x94),
  icom("icom-ic7300mk2", "Icom IC-7300 MkII", 0xb6),
  icom("icom-ic705", "Icom IC-705", 0xa4),
  icom("icom-ic7610", "Icom IC-7610", 0x98),
  icom("icom-ic9700", "Icom IC-9700", 0xa2),
  {
    id: "kenwood",
    label: "Kenwood / Elecraft",
    make: "kenwood",
    civAddress: null,
    keyHex: KENWOOD_KEY,
    unkeyHex: KENWOOD_UNKEY,
    note: 'The ASCII commands "TX;" and "RX;", which most Kenwood and Elecraft radios share.',
  },
];

/**
 * Yaesu is deliberately absent.
 *
 * Its CAT PTT is a five-byte binary opcode that differs between models, so
 * there is no single entry that would work -- and a preset that keys nothing is
 * worse than no preset, because it looks configured. Yaesu owners pick Custom
 * and copy the two commands out of their radio's CAT reference.
 */
export const CUSTOM_PRESET_NOTE =
  "Type the radio's own key and unkey commands as hex. Yaesu radios need this: " +
  "their CAT keying opcode differs between models, so there is no one preset that fits.";

export function findPreset(id: string): PttPreset | null {
  return PTT_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** The preset for a detected CI-V address, or null when it is not one we know. */
export function presetForCivAddress(civAddress: number): PttPreset | null {
  return PTT_PRESETS.find((preset) => preset.civAddress === civAddress) ?? null;
}

/**
 * Which preset a saved profile's commands correspond to, or "custom".
 *
 * Derived rather than stored, so a profile written before this table existed --
 * or hand-edited, or filled in from a radio manual -- still opens showing its
 * model instead of dropping the operator into the raw hex. Compared on both
 * commands: a key that matches with an unkey that does not is not that radio,
 * and showing its name would be a lie about what is about to be sent.
 */
export function presetIdForCommands(keyHex: string, unkeyHex: string): string {
  const key = keyHex.toUpperCase();
  const unkey = unkeyHex.toUpperCase();
  const match = PTT_PRESETS.find((preset) => preset.keyHex === key && preset.unkeyHex === unkey);
  return match?.id ?? CUSTOM_PRESET_ID;
}

/** The preset a new CAT profile starts on, so the commands are never blank. */
export const DEFAULT_PRESET_ID = "icom-ic7300";
