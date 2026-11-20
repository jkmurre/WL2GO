import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CUSTOM_PRESET_ID,
  DEFAULT_PRESET_ID,
  PTT_PRESETS,
  findPreset,
  presetForCivAddress,
  presetIdForCommands,
} from "./pttPresets.ts";
import { IC7300MK2_CIV_ADDRESS, IC7300_CIV_ADDRESS, normaliseHexCommand } from "./configSchema.ts";

describe("PTT_PRESETS", () => {
  it("stores every command in the only form ardopcf can parse", () => {
    // -k/-u read uppercase hex with no separators and nothing else
    // (ARDOPCommon.c:248-305). A preset that needs normalising before use is a
    // preset that will reach the radio wrong the one time someone forgets.
    for (const preset of PTT_PRESETS) {
      assert.equal(normaliseHexCommand(preset.keyHex), preset.keyHex, preset.id);
      assert.equal(normaliseHexCommand(preset.unkeyHex), preset.unkeyHex, preset.id);
    }
  });

  it("never repeats an id or a key/unkey pair", () => {
    // Two presets with the same commands would make presetIdForCommands pick
    // whichever came first, so a saved profile could reopen naming the wrong
    // radio.
    const ids = new Set(PTT_PRESETS.map((p) => p.id));
    assert.equal(ids.size, PTT_PRESETS.length);
    const pairs = new Set(PTT_PRESETS.map((p) => `${p.keyHex}/${p.unkeyHex}`));
    assert.equal(pairs.size, PTT_PRESETS.length);
    assert.ok(!ids.has(CUSTOM_PRESET_ID), "custom must not be a real preset");
  });

  it("keys and unkeys differ for every radio", () => {
    // Identical commands would key the radio and never release it.
    for (const preset of PTT_PRESETS) {
      assert.notEqual(preset.keyHex, preset.unkeyHex, preset.id);
    }
  });

  it("agrees with the schema's Icom addresses", () => {
    assert.equal(findPreset("icom-ic7300")?.civAddress, IC7300_CIV_ADDRESS);
    assert.equal(findPreset("icom-ic7300mk2")?.civAddress, IC7300MK2_CIV_ADDRESS);
  });

  it("has a usable default so a new CAT profile is never blank", () => {
    const preset = findPreset(DEFAULT_PRESET_ID);
    assert.ok(preset, "the default preset id must exist in the table");
    assert.ok(preset.keyHex.length > 0 && preset.unkeyHex.length > 0);
  });
});

describe("presetForCivAddress", () => {
  it("maps a detected address to its radio", () => {
    assert.equal(presetForCivAddress(IC7300MK2_CIV_ADDRESS)?.id, "icom-ic7300mk2");
  });

  it("returns null for an address no preset claims", () => {
    // A radio on a non-default address is an ordinary state, not an error: the
    // prober still found it, and the caller falls back to commands built from
    // the address it actually read.
    assert.equal(presetForCivAddress(0x22), null);
  });
});

describe("presetIdForCommands", () => {
  it("recognises a saved profile written before the table existed", () => {
    assert.equal(presetIdForCommands("FEFEB6E01C0001FD", "FEFEB6E01C0000FD"), "icom-ic7300mk2");
  });

  it("is case-insensitive about what is on disk", () => {
    assert.equal(presetIdForCommands("fefe94e01c0001fd", "fefe94e01c0000fd"), "icom-ic7300");
  });

  it("refuses a half-match", () => {
    // An IC-7300 key with an IC-7300 MkII unkey is not either radio, and naming
    // one of them would misdescribe what is about to be sent.
    assert.equal(presetIdForCommands("FEFE94E01C0001FD", "FEFEB6E01C0000FD"), CUSTOM_PRESET_ID);
  });

  it("calls empty commands custom rather than guessing", () => {
    assert.equal(presetIdForCommands("", ""), CUSTOM_PRESET_ID);
  });
});
