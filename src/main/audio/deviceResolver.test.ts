import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AudioDevice } from "../../shared/ipcContract.ts";
import { resolveAudioDevice, toSelection } from "./deviceResolver.ts";

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

const usbCapture = device({ name: "USB Audio Device", index: 1 });
const builtinCapture = device({ name: "MacBook Pro Microphone", index: 2, isDefault: true });
const usbPlayback = device({ name: "USB Audio Device", index: 1, direction: "playback", maxChannels: 2 });

describe("resolveAudioDevice", () => {
  it("resolves a saved name to the index ardopcf is given", () => {
    const result = resolveAudioDevice(
      { name: "USB Audio Device", index: 1, hostApi: "Core Audio" },
      [usbCapture, builtinCapture],
      "capture",
    );
    assert.equal(result.ok, true);
    assert.ok(result.ok);
    // An index, not the name: ardopcf's own ResolveDevice() would treat the
    // name as a substring and take the first match.
    assert.equal(result.argument, "1");
    assert.equal(result.device?.name, "USB Audio Device");
    assert.deepEqual(result.warnings, []);
  });

  it("follows a device whose index moved since the profile was saved", () => {
    // Unplugging anything renumbers PortAudio's list, so this is the ordinary
    // case rather than an unusual one.
    const result = resolveAudioDevice(
      { name: "USB Audio Device", index: 5, hostApi: "Core Audio" },
      [usbCapture, builtinCapture],
      "capture",
    );
    assert.ok(result.ok);
    assert.equal(result.argument, "1");
    assert.equal(result.movedFrom, 5);
    assert.deepEqual(result.warnings, []);
  });

  it("only considers devices facing the right way", () => {
    // The same hardware appears once per direction; picking the capture entry
    // for a playback slot would hand ardopcf an index it rejects.
    const result = resolveAudioDevice(
      { name: "USB Audio Device", index: 1, hostApi: "Core Audio" },
      [usbCapture, usbPlayback],
      "playback",
    );
    assert.ok(result.ok);
    assert.equal(result.device?.direction, "playback");
  });

  it("names an absent device and what is present instead", () => {
    const result = resolveAudioDevice(
      { name: "SignaLink USB", index: 1, hostApi: "Core Audio" },
      [builtinCapture],
      "capture",
    );
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.reason, "absent");
    assert.match(result.message, /SignaLink USB/);
    assert.match(result.message, /MacBook Pro Microphone/);
  });

  it("says so when there are no devices at all rather than listing nothing", () => {
    const result = resolveAudioDevice({ name: "SignaLink USB", index: 1, hostApi: "" }, [], "capture");
    assert.ok(!result.ok);
    assert.match(result.message, /No audio input devices were found/);
  });

  it("uses the saved index to tell two identical devices apart", () => {
    const first = device({ name: "USB Audio Device", index: 1 });
    const second = device({ name: "USB Audio Device", index: 4 });
    const result = resolveAudioDevice(
      { name: "USB Audio Device", index: 4, hostApi: "Core Audio" },
      [first, second],
      "capture",
    );
    assert.ok(result.ok);
    assert.equal(result.argument, "4");
    // Resolved, but on a heuristic -- PortAudio exposes no serial number, so if
    // the two swapped indices this is confidently wrong. It must say so.
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /More than one audio input/);
  });

  it("refuses to guess between identical devices when the saved index is gone", () => {
    const first = device({ name: "USB Audio Device", index: 1 });
    const second = device({ name: "USB Audio Device", index: 4 });
    const result = resolveAudioDevice(
      { name: "USB Audio Device", index: 9, hostApi: "Core Audio" },
      [first, second],
      "capture",
    );
    assert.ok(!result.ok);
    assert.equal(result.reason, "ambiguous");
    // Guessing here is a coin flip on which radio transmits.
    assert.match(result.message, /2 audio input devices/);
    assert.match(result.message, /1, 4/);
  });

  it("still resolves a device PortAudio predicts cannot do 12000 Hz", () => {
    // ardopcf never calls Pa_IsFormatSupported -- it opens the stream -- and
    // CoreAudio resamples transparently, so refusing here would strand hardware
    // that works. It is a warning, and the open is the real answer.
    const result = resolveAudioDevice(
      { name: "Odd Card", index: 7, hostApi: "Core Audio" },
      [device({ name: "Odd Card", index: 7, supports12k: false })],
      "capture",
    );
    assert.ok(result.ok);
    assert.equal(result.argument, "7");
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /may not support the 12000 Hz/);
  });

  it("treats no selection as the system default, which is a real choice", () => {
    const result = resolveAudioDevice(null, [usbCapture, builtinCapture], "capture");
    assert.ok(result.ok);
    // ardopcf's ResolveDevice() maps this onto Pa_GetDefaultInputDevice.
    assert.equal(result.argument, "DEFAULT");
    assert.equal(result.device?.name, "MacBook Pro Microphone");
  });

  it("accepts a default selection even when nothing is marked default", () => {
    const result = resolveAudioDevice(null, [], "playback");
    assert.ok(result.ok);
    assert.equal(result.argument, "DEFAULT");
    assert.equal(result.device, null);
  });
});

describe("toSelection", () => {
  it("records the name, the index tiebreak and the host API", () => {
    assert.deepEqual(toSelection(usbCapture), {
      name: "USB Audio Device",
      index: 1,
      hostApi: "Core Audio",
    });
  });
});
