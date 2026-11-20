import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isHybridStation, pickupLimitNote, radioOnlyProblem } from "./hybridNetwork.ts";
import type { HybridStation } from "./ipcContract.ts";

const hybrid = (callsign: string): HybridStation => ({ callsign, automaticForwarding: true, manualForwarding: false });

describe("radioOnlyProblem", () => {
  it("allows a plain callsign", () => {
    assert.equal(radioOnlyProblem("N1CALL"), null);
    assert.equal(radioOnlyProblem(" n1call "), null);
  });

  it("explains why a callsign with an SSID cannot connect Radio-Only", () => {
    assert.match(radioOnlyProblem("N1CALL-7") ?? "", /SSID \(N1CALL-7\).*-T/s);
  });
});

describe("isHybridStation", () => {
  const list = [hybrid("W1AW-10"), hybrid("K1ABC")];

  it("matches exactly, ignoring case", () => {
    assert.equal(isHybridStation("w1aw-10", list), true);
  });

  it("matches on the base callsign when the SSIDs disagree", () => {
    assert.equal(isHybridStation("W1AW-12", list), true);
    assert.equal(isHybridStation("K1ABC-10", list), true);
    assert.equal(isHybridStation("W1AW", list), true);
  });

  it("does not match a different station", () => {
    assert.equal(isHybridStation("W1AX-10", list), false);
    assert.equal(isHybridStation("W1AW-10", []), false);
  });
});

describe("pickupLimitNote", () => {
  it("says nothing below the recommendation", () => {
    assert.equal(pickupLimitNote(0), null);
    assert.equal(pickupLimitNote(1), null);
  });

  it("advises at two and blocks at three", () => {
    assert.match(pickupLimitNote(2) ?? "", /recommends 2/);
    assert.match(pickupLimitNote(3) ?? "", /at most 3/);
  });
});
