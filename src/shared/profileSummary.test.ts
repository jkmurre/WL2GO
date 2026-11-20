import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BUSYDET_LEVEL, DEFAULT_DRIVE_LEVEL, defaultPtt, type RadioProfile } from "./configSchema.ts";
import { describePtt, describeProfile, describeProfileInput, describeRigControl } from "./profileSummary.ts";

function usbProfile(usb: Partial<RadioProfile["interface"] & object> | object): RadioProfile {
  return {
    id: "p1",
    name: "IC-7300",
    mode: "ardop",
    ardop: { hostPort: 8515 },
    hamlib: null,
    txMode: "auto",
    ptt: defaultPtt(),
    driveLevel: DEFAULT_DRIVE_LEVEL,
    busyDetLevel: DEFAULT_BUSYDET_LEVEL,
    interface: {
      type: "usb",
      usb: { serialPort: null, audioInput: null, audioOutput: null, ...usb },
    },
  };
}

describe("describeProfile", () => {
  it("names the audio devices rather than rendering the objects", () => {
    // The bug this guards: schema 2 turned these into objects, and a template
    // literal renders one as "[object Object]" with no complaint from tsc.
    const summary = describeProfile(
      usbProfile({
        serialPort: "/dev/cu.usbmodem21101",
        audioInput: { name: "USB Audio Device", index: 1, hostApi: "Core Audio" },
        audioOutput: { name: "USB Audio Device", index: 1, hostApi: "Core Audio" },
      }),
    );
    assert.equal(summary, "USB · /dev/cu.usbmodem21101 · USB Audio Device · VOX · no rig control — tune by hand");
    assert.doesNotMatch(summary, /\[object/);
  });

  it("shows both devices when they differ", () => {
    const summary = describeProfile(
      usbProfile({
        serialPort: "/dev/cu.usbmodem21101",
        audioInput: { name: "Radio In", index: 1, hostApi: "Core Audio" },
        audioOutput: { name: "Radio Out", index: 2, hostApi: "Core Audio" },
      }),
    );
    assert.match(summary, /Radio In \/ Radio Out/);
  });

  it("calls an unset device the system default, not a missing one", () => {
    // Null is a real choice -- ardopcf maps DEFAULT onto the system device --
    // so saying "no audio in" would misdescribe a working profile.
    const summary = describeProfile(usbProfile({ serialPort: "/dev/cu.usbmodem21101" }));
    assert.match(summary, /system default in \/ system default out/);
  });

  it("says when no serial port is chosen", () => {
    assert.match(describeProfile(usbProfile({})), /no serial port/);
  });

  it("describes a LAN profile by host and port", () => {
    const profile: RadioProfile = {
      id: "p2",
      name: "Flex",
      mode: "ardop",
      ardop: { hostPort: 8515 },
      hamlib: null,
      txMode: "auto",
      ptt: defaultPtt(),
      driveLevel: DEFAULT_DRIVE_LEVEL,
    busyDetLevel: DEFAULT_BUSYDET_LEVEL,
      interface: {
        type: "lan",
        lan: { host: "192.168.1.50", controlPort: 50001, civPort: 50002, audioPort: 50003, username: "op" },
      },
    };
    assert.equal(describeProfile(profile), "Network · 192.168.1.50:50001");
  });

  it("does not render an empty host as a bare colon", () => {
    const profile: RadioProfile = {
      id: "p3",
      name: "Unset",
      mode: "ardop",
      ardop: { hostPort: 8515 },
      hamlib: null,
      txMode: "auto",
      ptt: defaultPtt(),
      driveLevel: DEFAULT_DRIVE_LEVEL,
    busyDetLevel: DEFAULT_BUSYDET_LEVEL,
      interface: {
        type: "lan",
        lan: { host: "", controlPort: 50001, civPort: 50002, audioPort: 50003, username: "" },
      },
    };
    assert.match(describeProfile(profile), /no host/);
  });
});

describe("describeRigControl", () => {
  it("says plainly when there is none, rather than omitting the line", () => {
    // A summary that simply leaves rig control out reads as though tuning is
    // handled -- which is the assumption that produced a call on the wrong
    // frequency in the wrong mode.
    assert.equal(describeRigControl(usbProfile({})), "no rig control — tune by hand");
  });

  it("names the CAT port and the transmit mode", () => {
    const summary = describeRigControl({
      ...usbProfile({}),
      hamlib: { model: 3094, device: "/dev/cu.usbmodem21101", baud: 19200, port: 4532 },
      txMode: "usb-data",
    });
    assert.match(summary, /\/dev\/cu\.usbmodem21101/);
    assert.match(summary, /USB-DATA/);
  });
});

describe("describeProfileInput", () => {
  it("summarises a profile that has not been saved yet", () => {
    // The wizard's review step has an input, not a profile. It must not grow a
    // second summariser: a duplicate of this logic is what rendered
    // "[object Object]" in Settings once already.
    const summary = describeProfileInput({
      name: "IC-7300",
      interface: {
        type: "usb",
        usb: {
          serialPort: "/dev/cu.usbmodem21101",
          audioInput: { name: "USB Audio CODEC", index: 1, hostApi: "Core Audio" },
          audioOutput: { name: "USB Audio CODEC", index: 2, hostApi: "Core Audio" },
        },
      },
    });
    assert.equal(summary, "USB · /dev/cu.usbmodem21101 · USB Audio CODEC · VOX · no rig control — tune by hand");
    assert.doesNotMatch(summary, /object Object/);
  });

  it("agrees with describeProfile on the same data", () => {
    const iface = {
      type: "lan" as const,
      lan: { host: "192.168.1.50", controlPort: 50001, civPort: 50002, audioPort: 50003, username: "op" },
    };
    assert.equal(
      describeProfileInput({ name: "Flex", interface: iface }),
      describeProfile({
        id: "p9",
        name: "Flex",
        mode: "ardop",
        ardop: { hostPort: 8515 },
        hamlib: null,
        txMode: "auto",
        ptt: defaultPtt(),
        driveLevel: DEFAULT_DRIVE_LEVEL,
    busyDetLevel: DEFAULT_BUSYDET_LEVEL,
        interface: iface,
      }),
    );
  });

  it("describes an untouched draft without inventing selections", () => {
    const summary = describeProfileInput({
      name: "New radio",
      interface: { type: "usb", usb: { serialPort: null, audioInput: null, audioOutput: null } },
    });
    // "system default" is a real choice, and a profile for a radio that is not
    // plugged in yet is legal -- neither should read as an error here.
    assert.equal(summary, "USB · no serial port · system default in / system default out · VOX · no rig control — tune by hand");
  });
});

describe("describePtt", () => {
  // The reason this module exists at all: ptt is an OBJECT, and interpolating
  // one into a template literal renders "[object Object]" with no complaint
  // from tsc. That has already shipped once, in this very summary, when the
  // audio selections stopped being strings.
  it("never renders an object", () => {
    const methods = ["none", "rts", "cat", "rigctld"] as const;
    for (const method of methods) {
      const text = describePtt({ method, port: "/dev/cu.x", baud: 19200, keyHex: "", unkeyHex: "" });
      assert.doesNotMatch(text, /object Object/);
      assert.ok(text.length > 0);
    }
  });

  it("says VOX rather than nothing when no keying is configured", () => {
    assert.equal(describePtt(defaultPtt()), "VOX");
  });

  it("names the missing port rather than rendering null", () => {
    const text = describePtt({ method: "rts", port: null, baud: 19200, keyHex: "", unkeyHex: "" });
    assert.doesNotMatch(text, /null/);
    assert.match(text, /no port/);
  });
});
