import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEVICE_LIST_HEADER, StaleArdopcfError, parseDeviceList } from "./audioDeviceService.ts";

/** Builds a listing the way ardopcf does, header included. */
function listing(...rows: string[]): string {
  return [DEVICE_LIST_HEADER, ...rows].join("\n") + "\n";
}

describe("parseDeviceList", () => {
  it("parses ardopcf's tab-separated listing", () => {
    const devices = parseDeviceList(
      listing(
        "CAPTURE\t0\tCore Audio\t1\t-\t12k=yes\tiPhone Microphone",
        "CAPTURE\t2\tCore Audio\t1\tdefault\t12k=yes\tMacBook Pro Microphone",
        "PLAYBACK\t3\tCore Audio\t2\tdefault\t12k=no\tMacBook Pro Speakers",
      ),
    );
    assert.equal(devices.length, 3);
    assert.deepEqual(devices[0], {
      direction: "capture",
      index: 0,
      name: "iPhone Microphone",
      hostApi: "Core Audio",
      maxChannels: 1,
      isDefault: false,
      supports12k: true,
    });
    assert.equal(devices[1].isDefault, true);
    assert.equal(devices[2].direction, "playback");
    assert.equal(devices[2].maxChannels, 2);
    assert.equal(devices[2].supports12k, false);
  });

  it("keeps a device that is listed for both directions", () => {
    const devices = parseDeviceList(
      listing(
        "CAPTURE\t1\tCore Audio\t1\t-\t12k=yes\tUSB Audio Device",
        "PLAYBACK\t1\tCore Audio\t2\t-\t12k=yes\tUSB Audio Device",
      ),
    );
    assert.equal(devices.length, 2);
    assert.deepEqual(
      devices.map((d) => d.direction),
      ["capture", "playback"],
    );
    assert.ok(devices.every((d) => d.index === 1));
  });

  it("keeps a name containing a tab intact", () => {
    // The reason the name is the LAST column: it comes from the driver, so it
    // is the one field that could carry a tab of its own.
    const devices = parseDeviceList(listing("CAPTURE\t4\tCore Audio\t1\t-\t12k=yes\tOdd\tName"));
    assert.equal(devices[0].name, "Odd\tName");
    assert.equal(devices[0].hostApi, "Core Audio");
  });

  it("ignores banner and comment lines", () => {
    const devices = parseDeviceList(
      ["ardopcf Version 1.0.4.1.3", DEVICE_LIST_HEADER, "", "CAPTURE\t0\tCore Audio\t1\t-\t12k=yes\tMic"].join("\n"),
    );
    assert.equal(devices.length, 1);
    assert.equal(devices[0].name, "Mic");
  });

  it("skips malformed rows rather than throwing", () => {
    const devices = parseDeviceList(
      listing(
        "CAPTURE\tnotanumber\tCore Audio\t1\t-\t12k=yes\tMic",
        "CAPTURE\t1\ttoo\tfew",
        "PLAYBACK\t3\tCore Audio\t2\t-\t12k=yes\tGood",
      ),
    );
    assert.equal(devices.length, 1);
    assert.equal(devices[0].name, "Good");
  });

  it("returns an empty list when the listing has a header and no devices", () => {
    assert.deepEqual(parseDeviceList(listing()), []);
  });

  it("refuses output with no version header instead of degrading", () => {
    // The old three-column format. Parsing it leniently would leave hostApi,
    // isDefault and supports12k blank everywhere and silently disable every
    // feature built on them, with nothing to notice.
    assert.throws(() => parseDeviceList("CAPTURE\t0\tMic\nPLAYBACK\t1\tSpeakers"), StaleArdopcfError);
    assert.throws(() => parseDeviceList(""), StaleArdopcfError);
  });

  it("names the fix when the binary is stale", () => {
    // The message is the whole value of failing here rather than later: the
    // operator (or the developer with a stale tree) gets one command to run.
    assert.throws(() => parseDeviceList(""), /npm run build:ardopcf/);
  });
});
