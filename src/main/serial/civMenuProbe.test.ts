import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffScans, menuAddresses, scanMenu, type MenuReading } from "./civMenuProbe.ts";
import type { ProbePort } from "./civProbe.ts";
import { buildMenuReadFrame, type CivMenuAddress } from "../../shared/civMenu.ts";

const MK2 = 0xb6;

describe("menuAddresses", () => {
  it("walks the low byte as decimal digits, not as binary", () => {
    // Icom's addresses are BCD-ish: every low byte in Hamlib's tables is a
    // valid pair of decimal digits (0x23, 0x81, 0x95, 0x60). Scanning 0x00-0xFF
    // would spend most of a pass on addresses that cannot exist.
    const addresses = menuAddresses({ firstHigh: 0, lastHigh: 0 });
    assert.equal(addresses.length, 100);
    assert.deepEqual(addresses[0], { high: 0, low: 0x00 });
    assert.deepEqual(addresses[10], { high: 0, low: 0x10 });
    assert.deepEqual(addresses[99], { high: 0, low: 0x99 });
    assert.ok(!addresses.some((a) => (a.low & 0x0f) > 9 || a.low >> 4 > 9));
  });

  it("covers every high byte in the range", () => {
    assert.equal(menuAddresses({ firstHigh: 0, lastHigh: 2 }).length, 300);
  });
});

describe("scanMenu", () => {
  /** A radio that answers for a few addresses and ignores the rest. */
  function fakeRadio(values: Map<string, number[]>): ProbePort {
    let pending: number[] = [];
    return {
      write: async (data) => {
        const frame = Array.from(data);
        const key = `${frame[6]},${frame[7]}`;
        const value = values.get(key);
        pending = value ? [0xfe, 0xfe, 0xe0, MK2, 0x1a, 0x05, frame[6]!, frame[7]!, ...value, 0xfd] : [];
      },
      read: async () => Uint8Array.from(pending),
      close: async () => {},
    };
  }

  it("keeps only the addresses that answered", async () => {
    // Most of the range is silence, which is the ordinary answer for a menu
    // item that does not exist -- not an error worth reporting.
    const port = fakeRadio(new Map([["0,116", [0x01]], ["0,96", [0x09]]]));
    const readings = await scanMenu(port, MK2, { firstHigh: 0, lastHigh: 0 });
    assert.equal(readings.length, 2);
    assert.deepEqual(readings.map((r) => r.value), [[0x09], [0x01]]);
  });

  it("asks with a read frame, so a wrong address cannot change anything", async () => {
    // The property that makes this safe to run against someone's radio.
    const sent: number[][] = [];
    const port: ProbePort = {
      write: async (data) => void sent.push(Array.from(data)),
      read: async () => new Uint8Array(),
      close: async () => {},
    };
    await scanMenu(port, MK2, { firstHigh: 0, lastHigh: 0 });
    const expected = Array.from(buildMenuReadFrame(MK2, { high: 0, low: 0 }));
    assert.deepEqual(sent[0], expected);
    // A read frame is the address and nothing after it: no value byte anywhere.
    assert.ok(sent.every((frame) => frame.length === expected.length));
  });
});

describe("diffScans", () => {
  const reading = (address: CivMenuAddress, value: number[]): MenuReading => ({ address, value });

  it("reports the one address whose value moved", () => {
    const before = [reading({ high: 0, low: 0x60 }, [0x09]), reading({ high: 0, low: 0x74 }, [0x00])];
    const after = [reading({ high: 0, low: 0x60 }, [0x09]), reading({ high: 0, low: 0x74 }, [0x01])];
    const changed = diffScans(before, after);
    assert.equal(changed.length, 1);
    assert.deepEqual(changed[0]?.address, { high: 0, low: 0x74 });
    assert.equal(changed[0]?.summary, "1A 05 00 74: 00 -> 01");
  });

  it("reports ALL of them when more than one moved", () => {
    // An operator who nudged the dial while in the menu changed two settings.
    // Picking one silently would hand back the address of the wrong thing.
    const before = [reading({ high: 0, low: 0x60 }, [0x09]), reading({ high: 0, low: 0x74 }, [0x00])];
    const after = [reading({ high: 0, low: 0x60 }, [0x08]), reading({ high: 0, low: 0x74 }, [0x01])];
    assert.equal(diffScans(before, after).length, 2);
  });

  it("finds nothing when nothing changed", () => {
    const same = [reading({ high: 0, low: 0x74 }, [0x00])];
    assert.deepEqual(diffScans(same, same), []);
  });

  it("ignores an address that only appeared in one of the two scans", () => {
    // A read that timed out once is not a change; treating it as one would
    // report a random address as the answer.
    const before = [reading({ high: 0, low: 0x74 }, [0x00])];
    const after = [reading({ high: 0, low: 0x74 }, [0x00]), reading({ high: 1, low: 0x15 }, [0x02])];
    assert.deepEqual(diffScans(before, after), []);
  });
});
