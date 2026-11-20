import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_ARDOP_HOST_PORT, materialiseProfile, validateProfile } from "./configSchema.ts";
import { DEFAULT_PRESET_ID, findPreset } from "./pttPresets.ts";
import {
  canSave,
  draftFromProfile,
  emptyDraft,
  nextStep,
  previousStep,
  stepAfterKindChange,
  stepIssues,
  toProfileInput,
  wizardSteps,
  type WizardDraft,
} from "./profileWizard.ts";

function usbDraft(overrides: Partial<WizardDraft> = {}): WizardDraft {
  return { ...emptyDraft(), name: "IC-7300", ...overrides };
}

function lanDraft(overrides: Partial<WizardDraft> = {}): WizardDraft {
  return { ...emptyDraft(), name: "Flex", kind: "lan", host: "192.168.1.50", ...overrides };
}

describe("wizardSteps", () => {
  it("walks USB through collect, verify, review", () => {
    assert.deepEqual(wizardSteps("usb"), ["identity", "audio", "rig", "test", "review"]);
  });

  it("gives LAN no audio or test step", () => {
    // Module 9 owns "verify reachability (LAN)" and its hardware spike is
    // unrun, so a test step here would test nothing.
    assert.deepEqual(wizardSteps("lan"), ["identity", "lan", "review"]);
  });

  it("starts and ends both branches in the same place", () => {
    for (const kind of ["usb", "lan"] as const) {
      const steps = wizardSteps(kind);
      assert.equal(steps[0], "identity");
      assert.equal(steps[steps.length - 1], "review");
    }
  });
});

describe("stepIssues", () => {
  it("blocks the first step until the profile has a name", () => {
    assert.deepEqual(stepIssues(usbDraft({ name: "" }), "identity"), ["A profile needs a name."]);
    assert.deepEqual(stepIssues(usbDraft(), "identity"), []);
  });

  it("blocks the LAN step without a host", () => {
    assert.deepEqual(stepIssues(lanDraft({ host: "" }), "lan"), ["A LAN profile needs a host address."]);
  });

  it("blocks the LAN step on an unusable port, naming which of the three", () => {
    assert.deepEqual(stepIssues(lanDraft({ controlPort: "" }), "lan"), [
      "The LAN control port must be between 1 and 65535.",
    ]);
    assert.deepEqual(stepIssues(lanDraft({ audioPort: "0" }), "lan"), [
      "The LAN audio port must be between 1 and 65535.",
    ]);
  });

  it("never gates the audio step, even with nothing selected at all", () => {
    // A USB profile with no devices chosen is legal on purpose: an operator may
    // build a profile for a radio that has not arrived yet. A wizard that
    // insisted on a pick would silently narrow what the schema permits.
    const draft = usbDraft({ audioInput: null, audioOutput: null });
    assert.deepEqual(stepIssues(draft, "audio"), []);
    assert.ok(canSave(draft));
  });

  it("never gates the serial step, which Module 10 has not claimed yet", () => {
    assert.deepEqual(stepIssues(usbDraft({ serialPort: "" }), "rig"), []);
  });

  it("never gates the test step, so a failed open cannot strand a profile", () => {
    assert.deepEqual(stepIssues(usbDraft(), "test"), []);
  });

  it("catches the ARDOP host port at review, where it is edited", () => {
    const draft = usbDraft({ hostPort: "" });
    assert.deepEqual(stepIssues(draft, "review"), ["The ARDOP host port must be between 1 and 65535."]);
    // And it is not double-reported by an earlier step.
    assert.deepEqual(stepIssues(draft, "identity"), []);
  });

  it("answers for a step outside this branch rather than being undefined there", () => {
    // Keeps the partition invariant below defined over every (draft, step) pair.
    assert.deepEqual(stepIssues(usbDraft(), "lan"), []);
    assert.deepEqual(stepIssues(lanDraft(), "audio"), []);
  });
});

describe("stepIssues partitions validateProfile", () => {
  // The binding invariant of this module. Module 1's rule is that the form and
  // the store share ONE validator so they "can never disagree about what is
  // acceptable"; per-step gating is the obvious place for that to be forked by
  // accident. These assert the wizard's gates are a re-routing of
  // validateProfile's output and nothing else -- so a rule added there cannot
  // become unreachable here, and a step cannot invent a rule of its own.
  const drafts: WizardDraft[] = [
    usbDraft(),
    usbDraft({ name: "" }),
    usbDraft({ name: "   " }),
    usbDraft({ hostPort: "" }),
    usbDraft({ hostPort: "0" }),
    usbDraft({ hostPort: "70000" }),
    usbDraft({ name: "", hostPort: "abc" }),
    usbDraft({ serialPort: "/dev/cu.usbmodem21101" }),
    usbDraft({ audioInput: { name: "USB Audio CODEC", index: 1, hostApi: "Core Audio" } }),
    lanDraft(),
    lanDraft({ host: "" }),
    lanDraft({ controlPort: "" }),
    lanDraft({ civPort: "99999" }),
    lanDraft({ audioPort: "0" }),
    lanDraft({ name: "", host: "", controlPort: "", civPort: "", audioPort: "" }),
    // PTT is the one hardware step that can block, and only when the setting
    // contradicts itself. Routed to "rig"; the totality assertion below is what
    // proves it reaches exactly one step.
    usbDraft({ pttMethod: "rts", pttPort: "" }),
    usbDraft({ pttMethod: "cat", pttPort: "/dev/cu.usbmodem21101", pttKeyHex: "", pttUnkeyHex: "ZZ" }),
    usbDraft({ pttMethod: "cat", pttPort: "", pttBaud: "abc" }),
    usbDraft({ pttMethod: "rigctld", pttPort: "not-an-address" }),
    usbDraft({ pttMethod: "none", pttPort: "" }),
  ];

  it("routes every issue to exactly one step, and invents none", () => {
    for (const draft of drafts) {
      const expected = validateProfile(toProfileInput(draft));
      const routed = wizardSteps(draft.kind).flatMap((step) => stepIssues(draft, step));

      assert.deepEqual(
        [...routed].sort(),
        [...expected].sort(),
        `steps did not account for exactly the issues in ${JSON.stringify(draft)}`,
      );
      // Exactly one step, not several: a message shown twice reads as two
      // separate problems.
      assert.equal(routed.length, new Set(routed).size, "an issue was claimed by more than one step");
    }
  });

  it("means a draft that clears every step is one the store will accept", () => {
    for (const draft of drafts) {
      const clear = wizardSteps(draft.kind).every((step) => stepIssues(draft, step).length === 0);
      assert.equal(clear, canSave(draft), `gating and validateProfile disagreed on ${JSON.stringify(draft)}`);
    }
  });
});

describe("toProfileInput", () => {
  it("omits the id when creating and carries it when editing", () => {
    assert.equal(toProfileInput(usbDraft()).id, undefined);
    assert.equal(toProfileInput(usbDraft(), "p123").id, "p123");
  });

  it("stores an unselected serial port as null, not as an empty string", () => {
    const input = toProfileInput(usbDraft({ serialPort: "" }));
    assert.ok(input.interface.type === "usb");
    assert.equal(input.interface.usb.serialPort, null);
  });

  it("only emits the branch it is on, so a USB profile cannot carry LAN fields", () => {
    // The schema's discriminated union makes this unrepresentable on disk; this
    // asserts the draft, which holds both branches, does not leak the other.
    const input = toProfileInput(usbDraft({ host: "192.168.1.50", username: "flex" }));
    assert.equal(input.interface.type, "usb");
    assert.equal("lan" in input.interface, false);
  });

  it("lets a blank port fail validation rather than inventing a default", () => {
    // Silently substituting 8515 would tell the operator their typo was fine.
    const input = toProfileInput(usbDraft({ hostPort: "" }));
    assert.ok(Number.isNaN(input.ardop?.hostPort));
    assert.equal(validateProfile(input).length, 1);
  });
});

describe("draftFromProfile", () => {
  it("round-trips a saved USB profile unchanged", () => {
    const profile = materialiseProfile(
      toProfileInput(
        usbDraft({
          serialPort: "/dev/cu.usbmodem21101",
          audioInput: { name: "USB Audio CODEC", index: 1, hostApi: "Core Audio" },
          audioOutput: { name: "USB Audio CODEC", index: 2, hostApi: "Core Audio" },
          hostPort: "8515",
        }),
      ),
      "p1",
    );

    const reloaded = materialiseProfile(toProfileInput(draftFromProfile(profile), "p1"), "p1");
    assert.deepEqual(reloaded, profile);
  });

  it("fills in a stored CAT profile that has no commands at all", () => {
    // The state every profile created before there was a radio picker is in.
    // CAT with empty commands cannot key the radio and validateProfile refuses
    // to save it, so nothing valid is being overwritten -- and the alternative
    // is showing its owner two empty hex boxes with no way to know what goes in
    // them, which is exactly the report this came from.
    const profile = materialiseProfile(toProfileInput(usbDraft()), "p1");
    const stranded = {
      ...profile,
      ptt: { method: "cat" as const, port: "/dev/cu.usbmodem21101", baud: 19200, keyHex: "", unkeyHex: "" },
    };

    const draft = draftFromProfile(stranded);
    assert.equal(draft.pttKeyHex, findPreset(DEFAULT_PRESET_ID)?.keyHex);
    assert.equal(draft.pttUnkeyHex, findPreset(DEFAULT_PRESET_ID)?.unkeyHex);
    assert.deepEqual(validateProfile(toProfileInput(draft, "p1")), []);
  });

  it("never replaces commands the operator already has", () => {
    // Including ones that match no preset: hex copied out of a radio manual is
    // the whole reason the custom option exists.
    const profile = materialiseProfile(toProfileInput(usbDraft()), "p1");
    const custom = {
      ...profile,
      ptt: { method: "cat" as const, port: "/dev/cu.x", baud: 19200, keyHex: "0011", unkeyHex: "0022" },
    };

    const draft = draftFromProfile(custom);
    assert.equal(draft.pttKeyHex, "0011");
    assert.equal(draft.pttUnkeyHex, "0022");
  });

  it("leaves a VOX profile's empty commands empty", () => {
    // Seeding here would put CAT commands on a profile that does not use CAT.
    const profile = materialiseProfile(toProfileInput(usbDraft()), "p1");
    const draft = draftFromProfile(profile);
    assert.equal(draft.pttMethod, "none");
    assert.equal(draft.pttKeyHex, "");
    assert.equal(draft.pttUnkeyHex, "");
  });

  it("round-trips a saved LAN profile unchanged", () => {
    const profile = materialiseProfile(toProfileInput(lanDraft({ username: "flex" })), "p2");
    const reloaded = materialiseProfile(toProfileInput(draftFromProfile(profile), "p2"), "p2");
    assert.deepEqual(reloaded, profile);
  });

  it("keeps a schema 1 selection that lifted to an unknown index", () => {
    // index -1 means "no tiebreak recorded". Opening the editor must not turn
    // that into a guess; only the operator touching the field may.
    const profile = materialiseProfile(
      toProfileInput(usbDraft({ audioInput: { name: "USB Audio CODEC", index: -1, hostApi: "" } })),
      "p3",
    );
    assert.equal(draftFromProfile(profile).audioInput?.index, -1);
  });

  it("does not offer to re-point the active profile when editing", () => {
    const profile = materialiseProfile(toProfileInput(usbDraft()), "p4");
    assert.equal(draftFromProfile(profile).makeActive, false);
  });

  it("defaults the ARDOP host port for a new profile", () => {
    assert.equal(emptyDraft().hostPort, String(DEFAULT_ARDOP_HOST_PORT));
  });
});

describe("step navigation", () => {
  it("moves forward and back within a branch", () => {
    const draft = usbDraft();
    assert.equal(nextStep(draft, "identity"), "audio");
    assert.equal(previousStep(draft, "audio"), "identity");
  });

  it("reports the ends of the sequence rather than wrapping", () => {
    const draft = usbDraft();
    assert.equal(previousStep(draft, "identity"), null);
    assert.equal(nextStep(draft, "review"), null);
  });

  it("keeps the operator somewhere real when they switch branch", () => {
    // "audio" does not exist on the LAN branch; dropping them back to the start
    // would throw away the name they already typed.
    assert.equal(stepAfterKindChange("lan", "audio"), "lan");
    assert.equal(stepAfterKindChange("usb", "lan"), "audio");
    // A step both branches share is kept exactly.
    assert.equal(stepAfterKindChange("lan", "identity"), "identity");
    assert.equal(stepAfterKindChange("usb", "review"), "review");
  });
});
