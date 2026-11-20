import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pttTestUnavailableReason, releasePtt, testPtt, type KeyablePort } from "./pttTester.ts";
import { defaultPtt, type PttConfig } from "../../shared/configSchema.ts";

const CAT: PttConfig = {
  method: "cat",
  port: "/dev/cu.usbmodem21101",
  baud: 19200,
  keyHex: "FEFEB6E01C0001FD",
  unkeyHex: "FEFEB6E01C0000FD",
};

const RTS: PttConfig = { method: "rts", port: "/dev/cu.usbserial", baud: 19200, keyHex: "", unkeyHex: "" };

/** Records everything that reaches the wire, in order. */
function recorder(over: Partial<KeyablePort> = {}) {
  const events: string[] = [];
  const port: KeyablePort = {
    async write(data) {
      events.push(`write ${Buffer.from(data).toString("hex").toUpperCase()}`);
    },
    async setRts(on) {
      events.push(`rts ${on}`);
    },
    async close() {
      events.push("close");
    },
    ...over,
  };
  return { events, openPort: async () => port };
}

const NO_WAIT = async () => {};

describe("pttTestUnavailableReason", () => {
  it("refuses VOX, because there is nothing for WL2GO to key", () => {
    assert.match(String(pttTestUnavailableReason(defaultPtt())), /VOX/);
  });

  it("refuses rig control until it is built", () => {
    assert.ok(pttTestUnavailableReason({ ...CAT, method: "rigctld", port: "127.0.0.1:4532" }));
  });

  it("refuses a CAT profile with no port", () => {
    assert.match(String(pttTestUnavailableReason({ ...CAT, port: null })), /port/);
  });

  it("refuses a CAT profile with a malformed command", () => {
    // An odd number of hex digits cannot be sent, and ardopcf would read it
    // wrong rather than reject it. Better to say so before keying anything.
    assert.ok(pttTestUnavailableReason({ ...CAT, keyHex: "FEF" }));
    assert.ok(pttTestUnavailableReason({ ...CAT, unkeyHex: "" }));
  });

  it("allows a complete CAT or RTS profile", () => {
    assert.equal(pttTestUnavailableReason(CAT), null);
    assert.equal(pttTestUnavailableReason(RTS), null);
  });
});

describe("testPtt", () => {
  it("sends the key command and then the unkey command", async () => {
    const rec = recorder();
    const result = await testPtt(CAT, { openPort: rec.openPort, wait: NO_WAIT });
    assert.equal(result.ok, true);
    assert.deepEqual(rec.events, [
      "write FEFEB6E01C0001FD",
      "write FEFEB6E01C0000FD",
      "close",
    ]);
  });

  it("raises and drops RTS", async () => {
    const rec = recorder();
    await testPtt(RTS, { openPort: rec.openPort, wait: NO_WAIT });
    assert.deepEqual(rec.events, ["rts true", "rts false", "close"]);
  });

  it("normalises hex the operator typed with spaces before sending it", async () => {
    const rec = recorder();
    await testPtt({ ...CAT, keyHex: "fe fe b6 e0 1c 00 01 fd", unkeyHex: "FE:FE:B6:E0:1C:00:00:FD" }, {
      openPort: rec.openPort,
      wait: NO_WAIT,
    });
    assert.equal(rec.events[0], "write FEFEB6E01C0001FD");
    assert.equal(rec.events[1], "write FEFEB6E01C0000FD");
  });

  it("still unkeys when the wait is interrupted", async () => {
    // The radio is keyed at this point. Whatever went wrong, it has to be
    // released -- leaving a transmitter keyed is the failure this app's whole
    // premise is about.
    const rec = recorder();
    const result = await testPtt(CAT, {
      openPort: rec.openPort,
      wait: async () => {
        throw new Error("interrupted");
      },
    });
    assert.equal(result.ok, false);
    assert.ok(rec.events.includes("write FEFEB6E01C0000FD"), `never unkeyed: ${rec.events.join(", ")}`);
    assert.equal(rec.events.at(-1), "close");
  });

  it("still unkeys when the unkey write fails the first time", async () => {
    // The port is always closed, even when the release could not be sent, so a
    // stuck port is not held open on top of a stuck transmitter.
    let writes = 0;
    const events: string[] = [];
    const result = await testPtt(CAT, {
      wait: NO_WAIT,
      openPort: async () => ({
        async write() {
          writes += 1;
          events.push(`write ${writes}`);
          if (writes === 2) throw new Error("port went away");
        },
        async setRts() {},
        async close() {
          events.push("close");
        },
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(events.at(-1), "close");
  });

  it("names a port it could not open, and does not claim success", async () => {
    const result = await testPtt(CAT, {
      openPort: async () => {
        throw new Error("Resource busy");
      },
      wait: NO_WAIT,
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /Resource busy/);
    // The likeliest cause, and both things the operator can do about it.
    assert.match(result.message, /Detect my radio/);
  });

  it("refuses before opening anything when the profile cannot key", async () => {
    let opened = false;
    const result = await testPtt(defaultPtt(), {
      openPort: async () => {
        opened = true;
        throw new Error("should not reach here");
      },
      wait: NO_WAIT,
    });
    assert.equal(result.ok, false);
    assert.equal(opened, false, "a VOX profile must not open the port at all");
  });
});

describe("releasePtt", () => {
  it("sends the unkey command on its own", async () => {
    // The safety net for a modem that died mid-transmission. ardopcf sends its
    // own unkey only as part of COMPLETING a transmission, so a crash or a kill
    // leaves a CAT-keyed radio transmitting -- killing a process cannot undo
    // bytes already written to a serial port.
    const rec = recorder();
    await releasePtt(CAT, { openPort: rec.openPort });
    assert.deepEqual(rec.events, ["write FEFEB6E01C0000FD", "close"]);
  });

  it("drops RTS", async () => {
    const rec = recorder();
    await releasePtt(RTS, { openPort: rec.openPort });
    assert.deepEqual(rec.events, ["rts false", "close"]);
  });

  it("does nothing for VOX or rig control", async () => {
    let opened = false;
    const open = async () => {
      opened = true;
      throw new Error("should not open");
    };
    await releasePtt(defaultPtt(), { openPort: open });
    await releasePtt({ ...CAT, method: "rigctld", port: "127.0.0.1:4532" }, { openPort: open });
    assert.equal(opened, false);
  });

  it("never throws, whatever goes wrong", async () => {
    // It runs on paths that are already handling a failure -- a crashed modem,
    // an unplugged radio -- and an exception here would mask the real one.
    await releasePtt(CAT, {
      openPort: async () => {
        throw new Error("Resource busy");
      },
    });
    await releasePtt(CAT, {
      openPort: async () => ({
        async write() {
          throw new Error("port went away");
        },
        async setRts() {},
        async close() {
          throw new Error("and close failed too");
        },
      }),
    });
  });

  it("still closes the port when the unkey could not be sent", async () => {
    const events: string[] = [];
    await releasePtt(CAT, {
      openPort: async () => ({
        async write() {
          throw new Error("nope");
        },
        async setRts() {},
        async close() {
          events.push("close");
        },
      }),
    });
    assert.deepEqual(events, ["close"]);
  });
});
