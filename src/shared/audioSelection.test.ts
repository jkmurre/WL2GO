import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AudioDevice } from "./ipcContract.ts";
import {
  describeDevice,
  duplicatedNames,
  matchAudioSelection,
  matchedDevice,
} from "./audioSelection.ts";

function device(partial: Partial<AudioDevice> & { name: string; index: number }): AudioDevice {
  return {
    direction: "capture",
    hostApi: "Core Audio",
    maxChannels: 1,
    isDefault: false,
    supports12k: true,
    ...partial,
  };
}

const codec = device({ name: "USB Audio CODEC", index: 1 });
const builtin = device({ name: "MacBook Pro Microphone", index: 2, isDefault: true });

describe("matchAudioSelection", () => {
  it("treats no selection as the system default, and finds it", () => {
    const match = matchAudioSelection(null, [codec, builtin], "capture");
    assert.equal(match.kind, "default");
    assert.equal(matchedDevice(match)?.name, "MacBook Pro Microphone");
  });

  it("still reports default when nothing is flagged as the default", () => {
    const match = matchAudioSelection(null, [codec], "capture");
    assert.equal(match.kind, "default");
    assert.equal(matchedDevice(match), null);
  });

  it("matches a device whose index is unchanged", () => {
    const match = matchAudioSelection(
      { name: "USB Audio CODEC", index: 1, hostApi: "Core Audio" },
      [codec, builtin],
      "capture",
    );
    assert.equal(match.kind, "exact");
    assert.equal(matchedDevice(match)?.index, 1);
  });

  it("follows a sole match whose index has moved, and says where from", () => {
    // THE bug this module exists to fix. Module 7 measured this shift on real
    // hardware: a device's PortAudio index changes whenever anything else is
    // plugged in or removed. The renderer used to call this "not connected"
    // while the resolver opened it without complaint.
    const match = matchAudioSelection(
      { name: "USB Audio CODEC", index: 5, hostApi: "Core Audio" },
      [codec, builtin],
      "capture",
    );
    assert.equal(match.kind, "moved");
    assert.ok(match.kind === "moved");
    assert.equal(match.device.index, 1);
    assert.equal(match.from, 5);
  });

  it("treats an unrecorded index as agreement, not as a move", () => {
    // -1 is what a schema 1 profile lifts to: "no tiebreak recorded". It must
    // not read as a device that moved from index -1.
    const match = matchAudioSelection(
      { name: "USB Audio CODEC", index: -1, hostApi: "" },
      [codec],
      "capture",
    );
    assert.equal(match.kind, "exact");
  });

  it("uses the saved index to tell two identically-named devices apart", () => {
    const first = device({ name: "USB Audio CODEC", index: 1 });
    const second = device({ name: "USB Audio CODEC", index: 4 });
    const match = matchAudioSelection(
      { name: "USB Audio CODEC", index: 4, hostApi: "Core Audio" },
      [first, second],
      "capture",
    );
    // Resolved, but on a heuristic: PortAudio exposes no serial number, so two
    // dongles that swapped indices resolve confidently wrong. The kind carries
    // that so callers can warn rather than imply certainty.
    assert.equal(match.kind, "tiebreak");
    assert.ok(match.kind === "tiebreak");
    assert.equal(match.device.index, 4);
    assert.equal(match.candidates.length, 2);
  });

  it("refuses to guess between identical devices when the saved index is gone", () => {
    const first = device({ name: "USB Audio CODEC", index: 1 });
    const second = device({ name: "USB Audio CODEC", index: 4 });
    const match = matchAudioSelection(
      { name: "USB Audio CODEC", index: 9, hostApi: "Core Audio" },
      [first, second],
      "capture",
    );
    assert.equal(match.kind, "ambiguous");
    assert.equal(matchedDevice(match), null);
  });

  it("cannot break a tie with an index that was never recorded", () => {
    // A migrated schema 1 selection has index -1 and two dongles share its
    // name. Guessing the first would be a coin flip on which radio transmits.
    const first = device({ name: "USB Audio CODEC", index: 1 });
    const second = device({ name: "USB Audio CODEC", index: 4 });
    const match = matchAudioSelection({ name: "USB Audio CODEC", index: -1, hostApi: "" }, [first, second], "capture");
    assert.equal(match.kind, "ambiguous");
  });

  it("reports an absent device alongside what is present instead", () => {
    const match = matchAudioSelection({ name: "SignaLink USB", index: 1, hostApi: "" }, [builtin], "capture");
    assert.equal(match.kind, "absent");
    assert.ok(match.kind === "absent");
    assert.deepEqual(match.available.map((d) => d.name), ["MacBook Pro Microphone"]);
  });

  it("only considers devices facing the right way", () => {
    // The same hardware is listed once per direction, and ardopcf's own bounds
    // check rejects a capture index handed to a playback slot.
    const playback = device({ name: "USB Audio CODEC", index: 3, direction: "playback", maxChannels: 2 });
    const match = matchAudioSelection(
      { name: "USB Audio CODEC", index: 1, hostApi: "Core Audio" },
      [codec, playback],
      "playback",
    );
    assert.equal(match.kind, "moved");
    assert.equal(matchedDevice(match)?.direction, "playback");
  });

  it("reports absent rather than throwing when a direction has no devices at all", () => {
    // An unplugged shack is a normal state, not an error.
    const match = matchAudioSelection({ name: "USB Audio CODEC", index: 1, hostApi: "" }, [], "playback");
    assert.equal(match.kind, "absent");
    assert.ok(match.kind === "absent");
    assert.deepEqual(match.available, []);
  });
});

describe("duplicatedNames", () => {
  it("reports only names carried by more than one device", () => {
    const names = duplicatedNames([
      device({ name: "USB Audio CODEC", index: 1 }),
      device({ name: "USB Audio CODEC", index: 4 }),
      builtin,
    ]);
    assert.deepEqual([...names], ["USB Audio CODEC"]);
  });

  it("is empty when every name is unique", () => {
    assert.equal(duplicatedNames([codec, builtin]).size, 0);
  });
});

describe("describeDevice", () => {
  it("shows the bare name when nothing distinguishes it", () => {
    assert.equal(describeDevice(codec), "USB Audio CODEC");
  });

  it("adds the index only when the name is shared", () => {
    assert.equal(describeDevice(codec, true), "USB Audio CODEC (device 1)");
  });

  it("marks the system default", () => {
    assert.equal(describeDevice(builtin), "MacBook Pro Microphone (system default)");
  });

  it("flags an unsupported rate as a note, never by omission", () => {
    // The device stays in the list: the prediction is advisory and CoreAudio
    // contradicts it routinely.
    const odd = device({ name: "Odd Card", index: 7, supports12k: false });
    assert.equal(describeDevice(odd), "Odd Card (may not support 12000 Hz)");
  });

  it("combines every note in a stable order", () => {
    const odd = device({ name: "Odd Card", index: 7, isDefault: true, supports12k: false });
    assert.equal(describeDevice(odd, true), "Odd Card (device 7, system default, may not support 12000 Hz)");
  });
});
