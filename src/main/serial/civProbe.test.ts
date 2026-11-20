import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROBE_BAUD_RATES, detectRadio, type ProbePort } from "./civProbe.ts";
import { CIV_CONTROLLER_ADDRESS, buildCivFrame, parseCivFrames } from "../../shared/civFrame.ts";

const MK2 = 0xb6;

/**
 * A radio that answers on one port and speed, and stays silent everywhere else.
 *
 * `echoes` reproduces CI-V USB Echo Back, which is an operator setting on the
 * radio -- so both states have to work and both are exercised below.
 */
function fakeRadio(config: {
  answersOn: string;
  answersAt: number;
  address: number;
  ignoresBroadcast?: boolean;
  echoes?: boolean;
}) {
  const opened: string[] = [];

  const openPort = async (path: string, baud: number): Promise<ProbePort> => {
    opened.push(`${path}@${baud}`);
    let pending: number[] = [];
    return {
      async write(data) {
        const frame = parseCivFrames(data)[0];
        if (!frame) return;
        if (config.echoes) pending.push(...data);
        if (path !== config.answersOn || baud !== config.answersAt) return;
        const addressed = frame.to === config.address;
        const broadcast = frame.to === 0x00 && !config.ignoresBroadcast;
        if (!addressed && !broadcast) return;
        pending.push(...buildCivFrame(CIV_CONTROLLER_ADDRESS, config.address, [0x19, 0x00, config.address]));
      },
      async read() {
        const out = Uint8Array.from(pending);
        pending = [];
        return out;
      },
      async close() {},
    };
  };

  return { openPort, opened };
}

const TWO_PORTS = async () => [
  { path: "/dev/cu.usbmodem21101", likelyRadioInterface: true },
  { path: "/dev/cu.usbmodem21103", likelyRadioInterface: true },
];

describe("detectRadio", () => {
  it("picks the right one of two identical-looking ports", () => {
    // The whole reason this exists: an IC-7300 MkII's two USB serial nodes have
    // the same vendor, product and serial number, so nothing but asking can
    // tell them apart.
    const radio = fakeRadio({ answersOn: "/dev/cu.usbmodem21103", answersAt: 19200, address: MK2 });
    return detectRadio({ listPorts: TWO_PORTS, openPort: radio.openPort }).then((result) => {
      assert.equal(result.found?.port, "/dev/cu.usbmodem21103");
      assert.equal(result.found?.baud, 19200);
    });
  });

  it("reads the address off the radio and names the model", async () => {
    const radio = fakeRadio({ answersOn: "/dev/cu.usbmodem21101", answersAt: 19200, address: MK2 });
    const result = await detectRadio({ listPorts: TWO_PORTS, openPort: radio.openPort });
    assert.equal(result.found?.civAddress, MK2);
    assert.equal(result.found?.presetId, "icom-ic7300mk2");
    assert.match(String(result.found?.summary), /IC-7300 MkII/);
  });

  it("still succeeds for a radio on an address no preset claims", async () => {
    // An operator who changed the CI-V address has a radio that is found, not
    // one that is unrecognised: the keying commands get built from the address
    // that was actually read.
    const radio = fakeRadio({ answersOn: "/dev/cu.usbmodem21101", answersAt: 19200, address: 0x22 });
    const result = await detectRadio({ listPorts: TWO_PORTS, openPort: radio.openPort });
    assert.equal(result.found?.civAddress, 0x22);
    assert.equal(result.found?.presetId, null);
    assert.match(String(result.found?.summary), /22h/);
  });

  it("is not fooled by the radio echoing our own query back", async () => {
    const radio = fakeRadio({ answersOn: "/dev/cu.usbmodem21101", answersAt: 19200, address: MK2, echoes: true });
    const result = await detectRadio({ listPorts: TWO_PORTS, openPort: radio.openPort });
    assert.equal(result.found?.civAddress, MK2);
  });

  it("tries 19200 before anything else", async () => {
    // Both the IC-7300 default and ardopcf's assumption, so the common case
    // should not wait behind four other speeds.
    const radio = fakeRadio({ answersOn: "/dev/cu.usbmodem21101", answersAt: 9600, address: MK2 });
    await detectRadio({ listPorts: TWO_PORTS, openPort: radio.openPort });
    assert.equal(radio.opened[0], "/dev/cu.usbmodem21101@19200");
    assert.equal(PROBE_BAUD_RATES[0], 19200);
  });

  it("finds a radio at a non-default speed", async () => {
    const radio = fakeRadio({ answersOn: "/dev/cu.usbmodem21103", answersAt: 115200, address: MK2 });
    const result = await detectRadio({ listPorts: TWO_PORTS, openPort: radio.openPort });
    assert.equal(result.found?.baud, 115200);
  });

  it("falls back to the address sweep when the radio ignores a general call", async () => {
    // MK2 is 0xB6, and that is the point. Hamlib's own prober sweeps 0x01-0x7f
    // (icom.c:9955), which cannot reach any modern Icom -- 0x94, 0xB6, 0xA4,
    // 0xA2 and 0x98 are all above its ceiling. Copying that range verbatim is
    // what this test caught.
    const radio = fakeRadio({
      answersOn: "/dev/cu.usbmodem21101",
      answersAt: 19200,
      address: MK2,
      ignoresBroadcast: true,
    });
    const result = await detectRadio({ listPorts: TWO_PORTS, openPort: radio.openPort });
    assert.equal(result.found?.civAddress, MK2);
  });

  it("sweeps high addresses that are in no preset", async () => {
    // The exhaustive tier: a radio on an address we neither broadcast-found nor
    // have a preset for, above 0x7f.
    const radio = fakeRadio({
      answersOn: "/dev/cu.usbmodem21101",
      answersAt: 19200,
      address: 0xd2,
      ignoresBroadcast: true,
    });
    const result = await detectRadio({ listPorts: TWO_PORTS, openPort: radio.openPort });
    assert.equal(result.found?.civAddress, 0xd2);
    assert.equal(result.found?.presetId, null);
  });

  it("never probes the broadcast or controller address during a sweep", async () => {
    // 0x00 is "everyone" and 0xE0 is us. Either would draw an answer that means
    // nothing, and radioAddressFromReply discards both -- but sending them at
    // all is wasted time on the slowest pass in the app.
    const targets: number[] = [];
    await detectRadio({
      listPorts: async () => [{ path: "/dev/cu.a", likelyRadioInterface: true }],
      openPort: async () => ({
        async write(data) {
          targets.push(data[2]);
        },
        async read() {
          return new Uint8Array();
        },
        async close() {},
      }),
    });
    const sweptControllerAddress = targets.filter((t) => t === 0xe0);
    assert.deepEqual(sweptControllerAddress, []);
  });

  it("reports what it tried rather than a bare failure", async () => {
    const radio = fakeRadio({ answersOn: "/dev/nothing", answersAt: 19200, address: MK2 });
    const result = await detectRadio({ listPorts: TWO_PORTS, openPort: radio.openPort });
    assert.equal(result.found, null);
    assert.equal(result.attempts.length, 2 * PROBE_BAUD_RATES.length);
    assert.match(result.message, /switched on/);
  });

  it("says so plainly when there are no serial ports at all", async () => {
    const result = await detectRadio({ listPorts: async () => [], openPort: async () => { throw new Error("no"); } });
    assert.equal(result.found, null);
    assert.match(result.message, /No serial ports/);
  });

  it("keeps looking past a port it cannot open", async () => {
    // Usually one ardopcf already holds. Stopping at the first busy port would
    // report "no radio" while the radio is sitting on the next one.
    const radio = fakeRadio({ answersOn: "/dev/cu.usbmodem21103", answersAt: 19200, address: MK2 });
    const result = await detectRadio({
      listPorts: TWO_PORTS,
      openPort: async (path, baud) => {
        if (path === "/dev/cu.usbmodem21101") throw new Error("Resource busy");
        return radio.openPort(path, baud);
      },
    });
    assert.equal(result.found?.port, "/dev/cu.usbmodem21103");
  });

  it("never sends a command that could key the transmitter", async () => {
    // Guard, not a behaviour test: the prober opens the radio's control port,
    // so what it is allowed to write there is worth pinning down.
    const written: number[][] = [];
    await detectRadio({
      listPorts: TWO_PORTS,
      openPort: async () => ({
        async write(data) {
          written.push(Array.from(data));
        },
        async read() {
          return new Uint8Array();
        },
        async close() {},
      }),
    });
    assert.ok(written.length > 0);
    for (const frame of written) {
      // Byte 4 is the command. Note it is NOT enough to check that 0x1C is
      // absent from the frame: 0x1C is also a perfectly ordinary destination
      // ADDRESS, which the sweep does reach. The command position is the only
      // place the distinction lives.
      assert.equal(frame[4], 0x19, `not an identity query: ${frame.join(",")}`);
      assert.equal(frame[5], 0x00, `not the read-ID subcommand: ${frame.join(",")}`);
    }
  });
});
