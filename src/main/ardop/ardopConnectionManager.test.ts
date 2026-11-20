import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ArdopConnectionManager,
  assessRadioReadiness,
  describeModemFailure,
  type ChannelCheckClient,
} from "./ardopConnectionManager.ts";
import { ArdopProcessManager, NO_AUDIO_DEVICE } from "./ardopProcessManager.ts";
import type { PatConnectionManager } from "../pat/patConnectionManager.ts";
import {
  DEFAULT_BUSYDET_LEVEL,
  DEFAULT_DRIVE_LEVEL,
  defaultPtt,
  type PttConfig,
  type RadioProfile,
} from "../../shared/configSchema.ts";
import type { AudioDevice, ChannelCheckEvent, ConnectionState } from "../../shared/ipcContract.ts";
import type { RigSession } from "../rigctl/rigSession.ts";
import { FinalIdWatcher } from "./finalIdWatcher.ts";

function device(over: Partial<AudioDevice> = {}): AudioDevice {
  return {
    direction: "capture",
    index: 1,
    name: "USB Audio CODEC",
    hostApi: "Core Audio",
    maxChannels: 2,
    isDefault: false,
    supports12k: true,
    ...over,
  };
}

const PRESENT: AudioDevice[] = [
  device({ direction: "capture", index: 1 }),
  device({ direction: "playback", index: 2 }),
];

function usbProfile(over: Partial<RadioProfile> = {}): RadioProfile {
  return {
    id: "p1",
    name: over.name ?? "IC-7300",
    mode: "ardop",
    ardop: { hostPort: 8515 },
    hamlib: over.hamlib ?? null,
    txMode: over.txMode ?? "auto",
    ptt: over.ptt ?? { method: "cat", port: "/dev/cu.x", baud: 19200, keyHex: "AA", unkeyHex: "BB" },
    driveLevel: DEFAULT_DRIVE_LEVEL,
    busyDetLevel: DEFAULT_BUSYDET_LEVEL,
    interface: {
      type: "usb",
      usb: {
        serialPort: "/dev/cu.usbmodem21101",
        audioInput: { name: "USB Audio CODEC", index: 1, hostApi: "Core Audio" },
        audioOutput: { name: "USB Audio CODEC", index: 2, hostApi: "Core Audio" },
      },
    },
    // Spread LAST so every field is overridable. It used to sit above the
    // hard-coded ones, which made an override silently do nothing -- a test
    // that passes for the wrong reason is worse than no test.
    ...over,
  };
}

describe("assessRadioReadiness", () => {
  it("is ready when both saved devices are present", () => {
    const readiness = assessRadioReadiness(usbProfile(), PRESENT);
    assert.equal(readiness.ok, true);
    assert.equal(readiness.reason, null);
  });

  it("names the missing device rather than saying 'not ready'", () => {
    // This string is what a greyed-out menu entry shows. "Cannot connect" would
    // send the operator hunting; the device name tells them what to plug in.
    const readiness = assessRadioReadiness(usbProfile(), []);
    assert.equal(readiness.ok, false);
    assert.match(String(readiness.reason), /USB Audio CODEC/);
  });

  it("says so plainly when there is no profile at all", () => {
    const readiness = assessRadioReadiness(null, PRESENT);
    assert.equal(readiness.ok, false);
    assert.match(String(readiness.reason), /No radio profile/);
  });

  it("refuses a LAN profile, and names it rather than blaming the hardware", () => {
    // The honest state of things: a networked Icom speaks its own framed
    // protocol on three UDP ports, bundled Hamlib has no support for it, and
    // ardopcf can only open PortAudio devices. Half-connecting, or silently
    // falling back to the USB codec, would both be worse than refusing.
    const lan: RadioProfile = {
      ...usbProfile(),
      name: "7300 over LAN",
      interface: {
        type: "lan",
        lan: { host: "10.0.0.9", controlPort: 50001, civPort: 50002, audioPort: 50003, username: "op" },
      },
    };
    const readiness = assessRadioReadiness(lan, PRESENT);
    assert.equal(readiness.ok, false);
    assert.match(String(readiness.reason), /network profile/i);
    assert.match(String(readiness.reason), /7300 over LAN/);
  });

  it("warns about VOX without refusing, because plenty of interfaces key on audio", () => {
    // Same rule as 12k= and addressWarnings(): warn, never block. Refusing here
    // would strand an operator whose radio is in VOX and working.
    const readiness = assessRadioReadiness(usbProfile({ ptt: defaultPtt() }), PRESENT);
    assert.equal(readiness.ok, true);
    assert.match(readiness.warnings.join(" "), /VOX/);
  });

  it("warns when rig-control keying has no rig behind it", () => {
    // The configuration in which nothing keys at all: ardopcf hands PTT to its
    // host and Pat has no rig to act on it with. validateProfile refuses to
    // save it, but a hand-edited config still reaches here.
    const ptt: PttConfig = { method: "rigctld", port: null, baud: 19200, keyHex: "", unkeyHex: "" };
    const readiness = assessRadioReadiness(usbProfile({ ptt, hamlib: null }), PRESENT);
    assert.equal(readiness.ok, true);
    assert.match(readiness.warnings.join(" "), /will not transmit/);
  });

  it("says plainly when it will not tune the radio, rather than leaving it assumed", () => {
    // A profile with no rig is fine and stays dialable -- tuning by hand is an
    // ordinary way to work. What is not fine is the operator believing WL2GO
    // set the frequency and the mode when it did not.
    const readiness = assessRadioReadiness(usbProfile({ hamlib: null }), PRESENT);
    assert.equal(readiness.ok, true);
    assert.match(readiness.warnings.join(" "), /will not tune the radio or set its mode/);
  });

  it("says nothing about tuning once a rig is configured", () => {
    const readiness = assessRadioReadiness(
      usbProfile({ hamlib: { model: 3094, device: "/dev/cu.usbmodem21101", baud: 19200, port: 4532 } }),
      PRESENT,
    );
    assert.equal(readiness.ok, true);
    assert.doesNotMatch(readiness.warnings.join(" "), /will not tune/);
  });

  it("carries the resolver's own warnings through untouched", () => {
    // A device whose index moved still resolves, and the resolver's warning
    // about the tiebreak has to survive to the operator -- dropping it is how
    // the wrong radio transmits with nobody told why.
    const duplicated: AudioDevice[] = [
      device({ direction: "capture", index: 1 }),
      device({ direction: "capture", index: 5 }),
      device({ direction: "playback", index: 2 }),
    ];
    const readiness = assessRadioReadiness(usbProfile(), duplicated);
    assert.equal(readiness.ok, true);
    assert.match(readiness.warnings.join(" "), /More than one audio input/);
  });

  it("passes a 12k warning through without refusing the device", () => {
    const unsupported: AudioDevice[] = [
      device({ direction: "capture", index: 1, supports12k: false }),
      device({ direction: "playback", index: 2 }),
    ];
    const readiness = assessRadioReadiness(usbProfile(), unsupported);
    assert.equal(readiness.ok, true);
    assert.match(readiness.warnings.join(" "), /12000 Hz/);
  });
});

describe("ArdopConnectionManager.abort", () => {
  /**
   * Records the ORDER of everything abort does.
   *
   * The order is the behaviour under test, not an implementation detail: under
   * rig-control keying Pat holds the asserted PTT, so the rigctl unkey is the
   * only thing that stops the carrier and it is also by far the fastest of the
   * three steps. Anything that pushes it behind a round trip to Pat or a
   * process kill leaves the transmitter on for longer.
   */
  function harness(profile: RadioProfile, over: { rigUnkeys?: boolean } = {}) {
    const order: string[] = [];
    const session = {
      abort: async () => {
        order.push("pat-abort");
      },
      getState: () => ({}) as ConnectionState,
    } as unknown as PatConnectionManager;

    const modem = {
      resetModem: async () => {
        order.push("modem-kill");
        return { ok: true, message: "" };
      },
    } as unknown as ArdopProcessManager;

    const rig = {
      stopTransmitting: async () => {
        order.push("rig-unkey");
        return over.rigUnkeys ?? true;
      },
      prepareForCall: async () => ({ ok: true, snapshot: null, error: null }),
      restore: async () => {},
    } as unknown as RigSession;

    const manager = new ArdopConnectionManager({
      getProfile: () => profile,
      listAudioDevices: async () => PRESENT,
      getModem: () => modem,
      getSession: () => session,
      getRig: () => rig,
    });
    return { manager, order };
  }

  const RIG = { model: 3094, device: "/dev/cu.usbmodem21101", baud: 19200, port: 4532 };
  const RIG_KEYED = usbProfile({
    hamlib: RIG,
    ptt: { method: "rigctld" as const, port: null, baud: 19200, keyHex: "", unkeyHex: "" },
  });

  it("unkeys through rig control FIRST, before telling Pat or killing the modem", async () => {
    const { manager, order } = harness(RIG_KEYED);
    const result = await manager.abort();
    assert.equal(result.ok, true);
    assert.deepEqual(order, ["rig-unkey", "pat-abort", "modem-kill"]);
  });

  it("still does all three when the first one fails", async () => {
    // Each covers a case the others do not. An abort that gave up after a
    // refused unkey would leave the modem running and Pat mid-session.
    const { manager, order } = harness(RIG_KEYED, { rigUnkeys: false });
    await manager.abort();
    assert.deepEqual(order, ["rig-unkey", "pat-abort", "modem-kill"]);
  });

  it("reports honestly when the radio did not acknowledge the unkey", async () => {
    // The one answer that must never be given here is a confident "stopped".
    // An operator who believes the transmitter is off walks away from a radio
    // that is still keyed.
    const { manager } = harness(RIG_KEYED, { rigUnkeys: false });
    const result = await manager.abort();
    assert.equal(result.ok, false);
    assert.match(result.message, /may not have stopped/i);
    assert.match(result.message, /Switch the radio off/);
  });

  it("does not complain about rig control for a profile that keys by CAT", async () => {
    // With CAT keying the serial port closing IS the unkey, so a rig that
    // cannot be reached is not a reason to warn about a stuck transmitter.
    const { manager, order } = harness(usbProfile({ hamlib: RIG }), { rigUnkeys: false });
    const result = await manager.abort();
    assert.equal(result.ok, true);
    assert.deepEqual(order, ["rig-unkey", "pat-abort", "modem-kill"]);
  });

  it("heals rig control BEFORE asking it to prepare the radio", async () => {
    // The relaunch-only trap: a rig client that died between attempts used to
    // reach prepareForCall dead, which failed the session with "rig control is
    // not running ... try again" -- advice that could not work, because nothing
    // on the connect path ever brought the client back.
    const order: string[] = [];
    const session = {
      beginModemStart() {},
      failSession() {},
      getState: () => ({}) as ConnectionState,
    } as unknown as PatConnectionManager;
    const rig = {
      prepareForCall: async () => {
        order.push("rig-prepare");
        // Refused, so the test never reaches the modem spawn.
        return { ok: false, snapshot: null, error: "nope" };
      },
      restore: async () => {},
      stopTransmitting: async () => true,
    } as unknown as RigSession;

    const manager = new ArdopConnectionManager({
      getProfile: () => RIG_KEYED,
      listAudioDevices: async () => PRESENT,
      getModem: () => new ArdopProcessManager({ resourcesBinDir: "/nonexistent/bin", hostPort: 8515 }),
      getSession: () => session,
      getRig: () => rig,
      ensureRig: async () => {
        order.push("ensure-rig");
      },
    });
    await manager.connect({ target: "K0RMS" });
    assert.deepEqual(order, ["ensure-rig", "rig-prepare"]);
  });

  it("says so when rig-control keying has no rig control running at all", async () => {
    const manager = new ArdopConnectionManager({
      getProfile: () => RIG_KEYED,
      listAudioDevices: async () => PRESENT,
      getModem: () => null,
      getSession: () => null,
      getRig: () => null,
    });
    const result = await manager.abort();
    assert.equal(result.ok, false);
    assert.match(result.message, /rig control is not running/);
  });
});

describe("describeModemFailure", () => {
  it("passes the stale-port message through, because it names its own fix", () => {
    const stale = 'Something is already listening on port 8515, so the modem cannot start. Use "Reset modem".';
    assert.equal(describeModemFailure(stale), stale);
  });

  it("reads an immediate exit as the sound card, which is what it almost always is", () => {
    // ardopcf exits without saying why when it cannot open a device. That is
    // the single most common real-world failure, and "exited with code=1" tells
    // an operator nothing they can act on.
    const described = describeModemFailure("ardopcf exited with code=1 signal=null before opening its host port");
    assert.match(described, /sound card/i);
    assert.doesNotMatch(described, /exited with code/);
  });

  it("mentions microphone permission only on macOS, where TCC can cause it", () => {
    const described = describeModemFailure("ardopcf exited with code=1 signal=null");
    if (process.platform === "darwin") assert.match(described, /Privacy & Security/);
    else assert.doesNotMatch(described, /Privacy & Security/);
  });

  it("passes a missing-binary message through, since it already names the fix", () => {
    const missing = "ardopcf binary not found at /r/bin/ardopcf. Run: npm run build:ardopcf";
    assert.equal(describeModemFailure(missing), missing);
  });

  it("never returns an empty string, whatever it was handed", () => {
    for (const reason of ["", "   ", "something unexpected"]) {
      assert.ok(describeModemFailure(reason).trim().length > 0, reason);
    }
  });
});

/**
 * connect() against a real ArdopProcessManager pointed at a missing binary.
 *
 * Real object rather than a stub on purpose: the defect these cover was that
 * connect() resolved the audio devices, put them in a LOG LINE, and started a
 * modem that had never been told about them -- so every on-air session ran
 * NOSOUND with no keying. A stub asserting "start was called" is exactly what
 * failed to catch it. buildArgs() is the observable that cannot lie.
 *
 * start() fails on the missing binary, which is fine: configure() has already
 * happened by then, and the failure path is separately covered above.
 */
describe("ArdopConnectionManager.connect", () => {
  function harness(profile: RadioProfile) {
    const modem = new ArdopProcessManager({ resourcesBinDir: "/nonexistent/bin", hostPort: 8515 });
    const session = {
      beginModemStart() {},
      failSession() {},
      getState: () => ({}) as ConnectionState,
    } as unknown as PatConnectionManager;

    const manager = new ArdopConnectionManager({
      getProfile: () => profile,
      listAudioDevices: async () => PRESENT,
      getModem: () => modem,
      getSession: () => session,
    });
    return { manager, modem };
  }

  it("carries the profile's drive level to the modem", async () => {
    // Regression, and it made the whole tuning window pointless: connect() used
    // to pass no host commands at all, so every on-air session ran at
    // ardopcf's built-in DriveLevel of 100 (ARDOPC.c:105) no matter what the
    // operator had set. -H is the ONLY route in, because ardopcf keeps a single
    // host control socket and Pat holds it for the whole session.
    const { manager, modem } = harness(usbProfile({ driveLevel: 60 }));
    await manager.connect({ target: "K0RMS" });

    const args = modem.buildArgs();
    assert.ok(args.includes("-H"), `no host commands: ${args.join(" ")}`);
    assert.match(args[args.indexOf("-H") + 1] ?? "", /DRIVELEVEL 60/);
  });

  it("carries the profile's busy detector level to the modem", async () => {
    // Same route as drive level, and for the same reason: -H at spawn is the
    // only way in. Without this every session ran at ardopcf's built-in
    // BusyDet of 5 (ARDOPC.c) no matter what the operator had set.
    const { manager, modem } = harness(usbProfile({ busyDetLevel: 8 }));
    await manager.connect({ target: "K0RMS" });

    const args = modem.buildArgs();
    assert.match(args[args.indexOf("-H") + 1] ?? "", /BUSYDET 8/);
  });

  it("hands the resolved devices and the profile's keying to the modem", async () => {
    const { manager, modem } = harness(usbProfile());
    await manager.connect({ target: "K0RMS" });

    const args = modem.buildArgs();
    // The devices are the positionals, and they are the RESOLVED indices rather
    // than the names stored in the profile.
    assert.deepEqual(args.slice(-3), ["8515", "1", "2"]);
    assert.ok(!args.includes(NO_AUDIO_DEVICE), `the modem was still deaf: ${args.join(" ")}`);
    // ...and the keying reached it, so the radio can actually transmit.
    assert.ok(args.includes("-c"), `no CAT keying: ${args.join(" ")}`);
    assert.deepEqual(args.slice(args.indexOf("-c"), args.indexOf("-c") + 6), [
      "-c",
      "/dev/cu.x:19200",
      "-k",
      "AA",
      "-u",
      "BB",
    ]);
  });

  it("still spawns cleanly for a VOX profile", async () => {
    // The opposite failure to the one above: now that connect() passes ptt
    // unconditionally, "none" must produce no keying flags rather than empty
    // ones. An "-c :19200 -k  -u " command line would make ardopcf open a
    // serial port that does not exist.
    const { manager, modem } = harness(usbProfile({ ptt: defaultPtt() }));
    await manager.connect({ target: "K0RMS" });

    const args = modem.buildArgs();
    assert.deepEqual(args.slice(-3), ["8515", "1", "2"]);
    for (const flag of ["-c", "-p", "-k", "-u"]) {
      assert.ok(!args.includes(flag), `${flag} reached a VOX command line: ${args.join(" ")}`);
    }
  });

  it("refuses radio-only with an SSID callsign, and names the fix", async () => {
    // Pat's own refusal (connect.go:133-137) is a bare log line and a generic
    // "Session failure"; checking here is what turns it into advice.
    const { manager } = (() => {
      const base = harness(usbProfile());
      const withCallsign = new ArdopConnectionManager({
        getProfile: () => usbProfile(),
        listAudioDevices: async () => PRESENT,
        getModem: () => base.modem,
        getSession: () => ({ beginModemStart() {}, getState: () => ({}) as ConnectionState }) as unknown as PatConnectionManager,
        getCallsign: () => "N1CALL-7",
      });
      return { manager: withCallsign };
    })();
    await assert.rejects(
      manager.connect({ target: "K0RMS", radioOnly: true }),
      /callsign without an SSID/,
    );
  });

  it("never gives the session modem a WebGui port", async () => {
    // Only the tuning session may set -G, and only on a scratch port. The
    // session modem is the one Pat attaches to and must stay closed.
    const { manager, modem } = harness(usbProfile());
    await manager.connect({ target: "K0RMS" });
    assert.ok(!modem.buildArgs().includes("-G"));
  });
});

/**
 * The pre-dial clear-channel check, end to end through connect().
 *
 * These use a stub modem whose start() succeeds and the createHostClient seam,
 * because the behaviour under test is the sequencing around the check: dialled
 * or not dialled, the check's client always closed, the teardown always run.
 * The window state machine itself is covered in clearChannelMonitor.test.ts.
 */
describe("ArdopConnectionManager clear-channel check", () => {
  function checkHarness(over: { clientConnectFails?: boolean; rig?: RigSession | null } = {}) {
    const calls: string[] = [];
    const events: ChannelCheckEvent[] = [];
    const logs: string[] = [];

    const modem = {
      configure(config: { hostCommands?: string[] }) {
        calls.push(`configure:${(config.hostCommands ?? []).join(";")}`);
      },
      start: async () => {
        calls.push("modem-start");
      },
      stop: async () => {
        calls.push("modem-stop");
      },
      getState: () => ({ hostPort: 8515 }),
    } as unknown as ArdopProcessManager;

    const session = {
      beginModemStart() {
        calls.push("begin-modem-start");
      },
      beginChannelCheck() {
        calls.push("begin-channel-check");
      },
      failSession(reason: string) {
        calls.push(`fail:${reason}`);
      },
      connect: async (_transport: string, url: string) => {
        calls.push(`dial:${url}`);
        return {} as ConnectionState;
      },
      getState: () => ({}) as ConnectionState,
    } as unknown as PatConnectionManager;

    let lineListener: ((line: string) => void) | null = null;
    let closeListener: (() => void) | null = null;
    const client: ChannelCheckClient = {
      connect: async () => {
        if (over.clientConnectFails) throw new Error("connection refused");
        calls.push("client-connect");
      },
      onLine: (listener) => {
        lineListener = listener;
        return () => {};
      },
      onClose: (listener) => {
        closeListener = listener;
        return () => {};
      },
      send: async (command: string) => {
        calls.push(`client-send:${command}`);
      },
      close: async () => {
        calls.push("client-close");
      },
    };

    const manager = new ArdopConnectionManager({
      // VOX profile so the finally's releasePtt touches no serial port; a rig
      // (and its hamlib profile) only when the test brings one.
      getProfile: () =>
        over.rig
          ? usbProfile({
              ptt: defaultPtt(),
              hamlib: { model: 3094, device: "/dev/cu.x", baud: 19200, port: 4532 },
            })
          : usbProfile({ ptt: defaultPtt() }),
      listAudioDevices: async () => PRESENT,
      getModem: () => modem,
      getSession: () => session,
      getRig: () => over.rig ?? null,
      ensureRig: async () => {
        calls.push("ensure-rig");
      },
      onLog: (message) => logs.push(message),
      onChannelCheck: (event) => events.push(event),
      createHostClient: () => client,
      channelClearWindowMs: 50,
      qsySettleMs: 0,
    });

    return {
      manager,
      calls,
      events,
      logs,
      emitLine: (line: string) => lineListener?.(line),
      emitClose: () => closeListener?.(),
    };
  }

  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("dials only after the window stays clear, with the listener closed first", async () => {
    const { manager, calls, events } = checkHarness();
    await manager.connect({ target: "K0RMS" });

    const dial = calls.findIndex((c) => c.startsWith("dial:"));
    assert.ok(dial !== -1, `never dialled: ${calls.join(", ")}`);
    assert.ok(calls.indexOf("begin-channel-check") < dial, "the stage moved before the dial");
    assert.ok(calls.indexOf("client-close") < dial, "our listener must detach before Pat attaches");
    assert.equal(events.at(-1)?.phase, "done");
  });

  it("holds on BUSY TRUE, and a cancel ends the session without dialling", async () => {
    const { manager, calls, events, emitLine } = checkHarness();
    const done = manager.connect({ target: "K0RMS" });

    await settle(10);
    emitLine("BUSY TRUE");
    assert.equal(events.at(-1)?.phase, "holding");
    assert.equal(events.at(-1)?.promptOperator, true);

    manager.channelDecision("abort");
    await done;

    assert.ok(!calls.some((c) => c.startsWith("dial:")), `dialled anyway: ${calls.join(", ")}`);
    assert.ok(calls.some((c) => c.startsWith("fail:") && /clear channel/.test(c)));
    assert.ok(calls.includes("client-close"));
    assert.ok(calls.includes("modem-stop"), "the teardown must still run");
    assert.equal(events.at(-1)?.phase, "done");
  });

  it("dials immediately on a forced connect, and says so in the log", async () => {
    const { manager, calls, logs, emitLine } = checkHarness();
    const done = manager.connect({ target: "K0RMS" });

    await settle(10);
    emitLine("BUSY TRUE");
    manager.channelDecision("force");
    await done;

    assert.ok(calls.some((c) => c.startsWith("dial:")));
    assert.ok(logs.some((l) => /busy channel/.test(l)));
  });

  it("degrades to a clear verdict when the check itself cannot run", async () => {
    // The check must never be the thing that kills a session; Pat's own
    // busy-channel prompt remains as the fallback.
    const { manager, calls, logs } = checkHarness({ clientConnectFails: true });
    await manager.connect({ target: "K0RMS" });

    assert.ok(calls.some((c) => c.startsWith("dial:")), `never dialled: ${calls.join(", ")}`);
    assert.ok(logs.some((l) => /could not run/.test(l)));
  });

  it("ends the check as an abort when the host socket dies under it", async () => {
    const { manager, calls, emitClose } = checkHarness();
    const done = manager.connect({ target: "K0RMS" });

    await settle(10);
    emitClose();
    await done;

    assert.ok(!calls.some((c) => c.startsWith("dial:")));
    assert.ok(calls.includes("modem-stop"));
  });

  it("resets the busy detector before the window opens", async () => {
    // LISTEN TRUE calls ClearBusy() in ardopcf, discarding averages from
    // before the pre-tune -- without it the first seconds of the window are
    // judged on what the radio heard on the OLD frequency.
    const { manager, calls } = checkHarness();
    await manager.connect({ target: "K0RMS" });
    const reset = calls.indexOf("client-send:LISTEN TRUE");
    const dial = calls.findIndex((c) => c.startsWith("dial:"));
    assert.ok(reset !== -1, `never reset: ${calls.join(", ")}`);
    assert.ok(reset < dial, "the reset must precede the dial");
  });

  it("hands the target bandwidth to the modem at spawn, for the busy detector", async () => {
    // Pat only sets ARQBW at dial time -- AFTER the check -- so without this
    // the busy detector sizes its passband from the default 2000MAX however
    // narrow the actual call will be.
    const { manager, calls } = checkHarness();
    await manager.connect({ target: "K0RMS", bandwidth: "500MAX" });
    const configure = calls.find((c) => c.startsWith("configure:"));
    assert.match(configure ?? "", /ARQBW 500MAX/);
  });

  it("leaves ARQBW alone when the row names no valid bandwidth", async () => {
    const { manager, calls } = checkHarness();
    await manager.connect({ target: "K0RMS", bandwidth: "garbage" });
    const configure = calls.find((c) => c.startsWith("configure:"));
    assert.doesNotMatch(configure ?? "", /ARQBW/);
  });

  it("heals rig control again immediately before the pre-tune", async () => {
    // The regression that kept the check on the wrong frequency: the DATA MOD
    // CI-V probe inside prepareForCall kills the rigctld client socket on
    // radios that cannot answer it, so the pre-tune's readFrequencyHz --
    // which arrives AFTER the top-of-connect heal -- read null on every
    // session and silently degraded to listening wherever the dial was left.
    const calls2: string[] = [];
    const rig = {
      prepareForCall: async () => {
        calls2.push("rig-prepare");
        return { ok: true, snapshot: null, error: null };
      },
      readFrequencyHz: async () => {
        calls2.push("read-freq");
        return 7_000_000;
      },
      setFrequencyHz: async () => {
        calls2.push("set-freq");
        return true;
      },
      restore: async () => {},
      stopTransmitting: async () => true,
    } as unknown as RigSession;

    const { manager, calls } = checkHarness({ rig });
    await manager.connect({ target: "K0RMS", dialKhz: 7101.5 });

    assert.ok(calls2.includes("read-freq"), `never pre-tuned: ${calls2.join(", ")}`);
    assert.ok(calls2.includes("set-freq"), `never tuned: ${calls2.join(", ")}`);
    // At least the top-of-connect heal, the pre-tune heal, and the teardown
    // heal -- the pre-tune one is the regression fix under test.
    assert.ok(calls.filter((c) => c === "ensure-rig").length >= 3, calls.join(", "));
  });
});

/**
 * The teardown's hold on modem.stop() until the final station ID is out.
 *
 * The regression these guard was deterministic: on the far-station-closes
 * branch ardopcf defers the IDFrame + CW ID by three seconds, Pat reports the
 * session over immediately, and the old teardown's SIGTERM beat the mandatory
 * ID by a third of a second every time.
 */
describe("ArdopConnectionManager sign-off wait", () => {
  function signOffHarness(over: { watcher?: FinalIdWatcher | null } = {}) {
    const calls: string[] = [];
    const watcher =
      over.watcher === undefined
        ? new FinalIdWatcher({ quietGraceMs: 1_000, doneGraceMs: 20, capMs: 5_000 })
        : over.watcher;

    const modem = {
      configure() {},
      start: async () => {},
      stop: async () => {
        calls.push("modem-stop");
      },
      resetModem: async () => {
        calls.push("modem-reset");
      },
      getState: () => ({ hostPort: 8515 }),
    } as unknown as ArdopProcessManager;

    const session = {
      beginModemStart() {},
      beginChannelCheck() {},
      failSession() {},
      connect: async (
        _transport: string,
        _url: string,
        context: { beforeFinish?: () => Promise<unknown> } = {},
      ) => {
        calls.push("dial");
        // Pat's /api/connect has resolved; the real manager awaits the
        // sign-off before marking the session finished.
        if (context.beforeFinish) await context.beforeFinish();
        calls.push("finished");
        return {} as ConnectionState;
      },
      abort: async () => {},
      getState: () => ({}) as ConnectionState,
    } as unknown as PatConnectionManager;

    const client: ChannelCheckClient = {
      connect: async () => {},
      onLine: () => () => {},
      onClose: () => () => {},
      send: async () => {},
      close: async () => {},
    };

    const manager = new ArdopConnectionManager({
      getProfile: () => usbProfile({ ptt: defaultPtt() }),
      listAudioDevices: async () => PRESENT,
      getModem: () => modem,
      getSession: () => session,
      createHostClient: () => client,
      channelClearWindowMs: 10,
      getSignOffWaiter: () => watcher,
    });

    return { manager, calls, watcher };
  }

  it("holds modem.stop until the deferred ID has gone out", async () => {
    const { manager, calls, watcher } = signOffHarness();
    const done = manager.connect({ target: "K0RMS" });

    // The session transmits, mail finishes, and the deferred ID follows.
    await new Promise((resolve) => setTimeout(resolve, 30));
    watcher?.noteTransmit(true);
    watcher?.noteTransmit(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(!calls.includes("modem-stop"), "stopped before the ID went out");

    watcher?.noteIdStart();
    watcher?.noteTransmit(true);
    watcher?.noteTransmit(false);
    await done;

    assert.ok(calls.includes("modem-stop"));
    assert.ok(calls.indexOf("finished") < calls.indexOf("modem-stop"));
  });

  it("does not delay a session that never keyed the transmitter", async () => {
    const { manager, calls } = signOffHarness();
    const before = Date.now();
    await manager.connect({ target: "K0RMS" });
    assert.ok(calls.includes("modem-stop"));
    // Well under the 1 s quiet grace: no-transmit resolves immediately. (The
    // ~200 ms floor is the channel check's own host-handoff settle.)
    assert.ok(Date.now() - before < 700, "the teardown waited on nothing");
  });

  it("abort marks the watcher so the teardown never waits out an ID", async () => {
    const { manager, watcher } = signOffHarness();
    watcher?.noteTransmit(true); // keyed: without the abort this would wait
    await manager.abort();
    assert.equal(await watcher?.wait(), "aborted");
  });

  it("stops immediately when no watcher is wired, as before", async () => {
    const { manager, calls } = signOffHarness({ watcher: null });
    await manager.connect({ target: "K0RMS" });
    assert.ok(calls.includes("modem-stop"));
  });
});
