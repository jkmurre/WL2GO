import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCivFrames } from "./civFrame.ts";
import {
  buildMenuReadFrame,
  buildMenuWriteFrame,
  dataModMenuFor,
  formatMenuAddress,
  menuValueFromReply,
  writeAcknowledged,
} from "./civMenu.ts";

const MK2 = 0xb6;
const DATA_MOD = { high: 0x00, low: 0x74 };

describe("menu frames", () => {
  it("builds a read as FE FE <radio> E0 1A 05 <hi> <lo> FD", () => {
    assert.deepEqual(
      Array.from(buildMenuReadFrame(MK2, DATA_MOD)),
      [0xfe, 0xfe, 0xb6, 0xe0, 0x1a, 0x05, 0x00, 0x74, 0xfd],
    );
  });

  it("builds a write with the value after the address", () => {
    assert.deepEqual(
      Array.from(buildMenuWriteFrame(MK2, DATA_MOD, [0x01])),
      [0xfe, 0xfe, 0xb6, 0xe0, 0x1a, 0x05, 0x00, 0x74, 0x01, 0xfd],
    );
  });

  it("prints an address the way Icom's reference and Hamlib both write it", () => {
    assert.equal(formatMenuAddress(DATA_MOD), "1A 05 00 74");
  });
});

describe("menuValueFromReply", () => {
  const reply = (payload: number[]) =>
    parseCivFrames([0xfe, 0xfe, 0xe0, MK2, ...payload, 0xfd]);

  it("reads the value bytes out of a matching reply", () => {
    assert.deepEqual(menuValueFromReply(reply([0x1a, 0x05, 0x00, 0x74, 0x01]), DATA_MOD), [0x01]);
  });

  it("ignores a reply for a DIFFERENT menu address", () => {
    // A radio with CI-V Transceive on sends unsolicited frames. Taking any
    // 1A 05 frame as the answer would report another menu item's value as
    // this one's -- and then write it back on restore.
    assert.equal(menuValueFromReply(reply([0x1a, 0x05, 0x00, 0x60, 0x09]), DATA_MOD), null);
  });

  it("ignores our own echo, which is the query coming back", () => {
    // With CI-V USB Echo Back on, the radio returns our frame first. It has
    // the right address and no value, so it must not read as "set to nothing".
    const echo = parseCivFrames([0xfe, 0xfe, MK2, 0xe0, 0x1a, 0x05, 0x00, 0x74, 0xfd]);
    assert.equal(menuValueFromReply(echo, DATA_MOD), null);
  });

  it("ignores a NAK", () => {
    assert.equal(menuValueFromReply(reply([0xfa]), DATA_MOD), null);
  });

  it("finds the answer among unrelated traffic", () => {
    const frames = parseCivFrames([
      0xfe, 0xfe, MK2, 0xe0, 0x1a, 0x05, 0x00, 0x74, 0xfd, // our echo
      0xfe, 0xfe, 0xe0, MK2, 0x00, 0x00, 0x50, 0x45, 0x07, 0x00, 0xfd, // transceive freq
      0xfe, 0xfe, 0xe0, MK2, 0x1a, 0x05, 0x00, 0x74, 0x00, 0xfd, // the answer
    ]);
    assert.deepEqual(menuValueFromReply(frames, DATA_MOD), [0x00]);
  });
});

describe("writeAcknowledged", () => {
  it("accepts FB and rejects FA", () => {
    assert.equal(writeAcknowledged(parseCivFrames([0xfe, 0xfe, 0xe0, MK2, 0xfb, 0xfd])), true);
    assert.equal(writeAcknowledged(parseCivFrames([0xfe, 0xfe, 0xe0, MK2, 0xfa, 0xfd])), false);
    assert.equal(writeAcknowledged([]), false);
  });
});

describe("dataModMenuFor", () => {
  // These assertions are the guard, not placeholders. Hamlib's own tables show
  // the IC-7300 and the MkII disagree on every shared menu address -- BEEP is
  // 00 23 vs 00 24, BACKLIGHT 00 81 vs 01 15 -- so an address inferred from a
  // sibling model writes into an unrelated setting on someone's radio. Anything
  // added to the map must come from `npm run find-menu-address` or the model's
  // own CI-V reference, never from a lookalike.

  it("carries the MEASURED IC-7300 MkII address", () => {
    const menu = dataModMenuFor(3094);
    assert.ok(menu, "the MkII address was measured on 2026-08-27 and should be here");
    assert.equal(formatMenuAddress(menu.address), "1A 05 00 85");
    assert.equal(menu.usb, 0x01);
  });

  it("has no address for a radio nobody has measured", () => {
    assert.equal(dataModMenuFor(3073), null, "IC-7300: measure it, do not infer it from the MkII");
    assert.equal(dataModMenuFor(1), null);
  });
});
