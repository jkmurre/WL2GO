import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRigModels, usableRigModels } from "./rigModelService.ts";

/** Verbatim from the vendored `rigctld -l`, header and spacing intact. */
const SAMPLE = [
  " Rig #  Mfg                    Model                   Version         Status      Macro",
  "     1  Hamlib                 Dummy                   20240709.0      Stable      RIG_MODEL_DUMMY",
  "     2  Hamlib                 NET rigctl              20250211.0      Stable      RIG_MODEL_NETRIGCTL",
  "     5  TRXManager             TRXManager 5.7.630+     20210613.0      Stable      RIG_MODEL_TRXMANAGER_RIG",
  "  1035  Yaesu                  FT-991                  20241118.18     Stable      RIG_MODEL_FT991",
  "  2031  Kenwood                TS-590S                 20250515.18     Stable      RIG_MODEL_TS590S",
  "  3073  Icom                   IC-7300                 20250517.14     Stable      RIG_MODEL_IC7300",
  "  3094  Icom                   IC-7300MK2              20250517.14     Beta        RIG_MODEL_IC7300MK2",
  "  9999  Nobody                 Prototype               20200101.0      Alpha       RIG_MODEL_PROTO",
].join("\n");

describe("parseRigModels", () => {
  it("reads the model number, make and name", () => {
    const models = parseRigModels(SAMPLE);
    const mk2 = models.find((m) => m.model === 3094);
    assert.deepEqual(mk2, { model: 3094, make: "Icom", name: "IC-7300MK2", status: "Beta" });
  });

  it("keeps a name containing a space intact", () => {
    // Splitting on any whitespace turns "TRXManager 5.7.630+" into two columns
    // and shifts every field after it, so the status of one rig becomes the
    // name of the next.
    const models = parseRigModels(SAMPLE);
    assert.equal(models.find((m) => m.model === 5)?.name, "TRXManager 5.7.630+");
    assert.equal(models.find((m) => m.model === 5)?.status, "Stable");
  });

  it("skips the header and anything that is not a numbered row", () => {
    const models = parseRigModels(SAMPLE);
    assert.ok(models.every((m) => m.model > 0));
    assert.equal(parseRigModels("").length, 0);
    assert.equal(parseRigModels("total nonsense\n").length, 0);
  });
});

describe("usableRigModels", () => {
  it("drops Alpha backends, which report success and drive nothing", () => {
    // Hamlib marks a backend Alpha when nobody has driven a real radio with it.
    // Offering one produces the exact failure this module exists to fix: a rig
    // that says RPRT 0 and does not move.
    const usable = usableRigModels(parseRigModels(SAMPLE));
    assert.ok(!usable.some((m) => m.status === "Alpha"));
  });

  it("drops Hamlib's own non-radio backends", () => {
    // "Hamlib Dummy" at the top of an alphabetical list is an invitation to
    // pick it, and it drives no radio at all.
    const usable = usableRigModels(parseRigModels(SAMPLE));
    assert.ok(!usable.some((m) => m.make === "Hamlib"));
  });

  it("keeps Beta, because that is what the IC-7300 MkII is", () => {
    const usable = usableRigModels(parseRigModels(SAMPLE));
    assert.ok(usable.some((m) => m.model === 3094));
  });

  it("orders by make then model, which is how someone looks for their radio", () => {
    const usable = usableRigModels(parseRigModels(SAMPLE));
    assert.deepEqual(
      usable.map((m) => `${m.make} ${m.name}`),
      ["Icom IC-7300", "Icom IC-7300MK2", "Kenwood TS-590S", "TRXManager TRXManager 5.7.630+", "Yaesu FT-991"],
    );
  });
});
