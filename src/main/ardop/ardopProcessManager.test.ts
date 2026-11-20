import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ArdopProcessManager, NO_AUDIO_DEVICE } from "./ardopProcessManager.ts";
import type { PttConfig } from "../../shared/configSchema.ts";

describe("ArdopProcessManager", () => {
  const manager = new ArdopProcessManager({ resourcesBinDir: "/r/bin", hostPort: 8515 });

  it("resolves the ardopcf binary from the vendored tree", () => {
    assert.ok(manager.binaryPath.includes("ardopcf"));
    assert.ok(manager.binaryPath.startsWith("/r/bin"));
    assert.ok(manager.binaryPath.includes(process.platform));
    assert.ok(manager.binaryPath.includes(process.arch));
  });

  it("starts idle and reports its host port", () => {
    const state = manager.getState();
    assert.equal(state.state, "idle");
    assert.equal(state.pid, null);
    assert.equal(state.hostPort, 8515);
    assert.equal(manager.isRunning(), false);
  });

  it("reports a missing binary without throwing, and does not claim to be running", async () => {
    const info = await manager.inspect();
    assert.equal(info.exists, false);
    assert.equal(manager.getState().binary?.exists, false);
    assert.equal(manager.isRunning(), false);
  });

  it("refuses to start when the binary is absent, naming the build command", async () => {
    await assert.rejects(manager.start(500), /npm run build:ardopcf/);
    assert.equal(manager.getState().state, "failed");
  });

  it("stopping an unstarted manager is a no-op", async () => {
    const fresh = new ArdopProcessManager({ resourcesBinDir: "/r/bin", hostPort: 8515 });
    await fresh.stop();
    assert.equal(fresh.getState().state, "stopped");
  });

  it("passes a resolved device index through as a positional", () => {
    // The boundary between deviceResolver and the spawn: resolveAudioDevice
    // returns a decimal index precisely because ardopcf's ResolveDevice() then
    // takes its numeric path instead of matching the argument as a substring.
    // Nothing else asserts these two halves still agree.
    const withDevices = new ArdopProcessManager({
      resourcesBinDir: "/r/bin",
      hostPort: 8515,
      captureDevice: "1",
      playbackDevice: "4",
    });
    const args = withDevices.buildArgs();
    assert.deepEqual(args.slice(-3), ["8515", "1", "4"]);
    // Options still precede the positionals; macOS getopt may stop at the first
    // non-option, so this ordering is load-bearing rather than cosmetic.
    assert.ok(args.indexOf("--hostbind") < args.indexOf("8515"));
  });

  it("passes DEFAULT through rather than substituting NOSOUND", () => {
    // "Use the system default" is a real choice: ardopcf's ResolveDevice() maps
    // DEFAULT onto Pa_GetDefaultInputDevice/OutputDevice. buildArgs uses ?? so
    // only null and undefined mean "no audio" -- turning DEFAULT into NOSOUND
    // would silently produce a modem that cannot hear anything.
    const withDefaults = new ArdopProcessManager({
      resourcesBinDir: "/r/bin",
      hostPort: 8515,
      captureDevice: "DEFAULT",
      playbackDevice: "DEFAULT",
    });
    assert.deepEqual(withDefaults.buildArgs().slice(-3), ["8515", "DEFAULT", "DEFAULT"]);
  });

  it("falls back to no audio only when no device is given at all", () => {
    assert.deepEqual(manager.buildArgs().slice(-3), ["8515", NO_AUDIO_DEVICE, NO_AUDIO_DEVICE]);
  });

  const withPtt = (ptt: PttConfig) =>
    new ArdopProcessManager({ resourcesBinDir: "/r/bin", hostPort: 8515, ptt }).buildArgs();

  it("keys by RTS with the baud as a suffix, because there is no flag for it", () => {
    // ardopcf has no baud option: it reads a ":baud" suffix off the port string
    // with strlop(port, ':') at PaSound.c:445-448, defaulting to 19200.
    const args = withPtt({ method: "rts", port: "/dev/cu.usbmodem21101", baud: 19200, keyHex: "", unkeyHex: "" });
    const at = args.indexOf("-p");
    assert.notEqual(at, -1);
    assert.equal(args[at + 1], "/dev/cu.usbmodem21101:19200");
  });

  it("keys by CAT with the command pair ardopcf can actually parse", () => {
    const args = withPtt({
      method: "cat",
      port: "/dev/cu.usbmodem21101",
      baud: 19200,
      keyHex: "FEFEB6E01C0001FD",
      unkeyHex: "FEFEB6E01C0000FD",
    });
    assert.equal(args[args.indexOf("-c") + 1], "/dev/cu.usbmodem21101:19200");
    assert.equal(args[args.indexOf("-k") + 1], "FEFEB6E01C0001FD");
    assert.equal(args[args.indexOf("-u") + 1], "FEFEB6E01C0000FD");
  });

  it("passes NO PTT options for rigctld, so the host does the keying", () => {
    // Regression, and it is the reason rig-control keying never worked. "-p
    // <ip>:<port>" makes PaSound.c:517-537 set PTTMode = PTTHAMLIB, and
    // RadioPTT() has no PTTHAMLIB branch -- in our PaSound.c or upstream's
    // ALSASound.c -- so ardopcf keyed nothing at all while reporting itself as
    // being in control. With no PTT arguments it leaves RadioControl false and
    // reports "PTT TRUE"/"PTT FALSE" to its host, which is what Pat acts on.
    const args = withPtt({ method: "rigctld", port: "127.0.0.1:4532", baud: 19200, keyHex: "", unkeyHex: "" });
    assert.ok(!args.includes("-p"), "-p would re-enable the branch that keys nothing");
    assert.ok(!args.includes("-c"));
    assert.ok(!args.includes("-k"));
  });

  it("passes no PTT options at all for VOX", () => {
    const args = withPtt({ method: "none", port: null, baud: 19200, keyHex: "", unkeyHex: "" });
    assert.ok(!args.includes("-p"));
    assert.ok(!args.includes("-c"));
  });

  it("passes no PTT options when a method has no port to use", () => {
    // validateProfile refuses to save this, but a hand-edited config can still
    // produce it. Spawning "-p" with nothing after it would shift every
    // positional along by one and hand the modem a nonsense capture device.
    const args = withPtt({ method: "rts", port: null, baud: 19200, keyHex: "", unkeyHex: "" });
    assert.ok(!args.includes("-p"));
    assert.deepEqual(args.slice(-3), ["8515", NO_AUDIO_DEVICE, NO_AUDIO_DEVICE]);
  });

  it("keeps the PTT options in front of the positionals", () => {
    // The load-bearing ordering: macOS getopt may stop at the first non-option,
    // so anything after the positionals is silently ignored.
    const args = new ArdopProcessManager({
      resourcesBinDir: "/r/bin",
      hostPort: 8515,
      captureDevice: "1",
      playbackDevice: "4",
      ptt: { method: "cat", port: "/dev/cu.x", baud: 19200, keyHex: "AA", unkeyHex: "BB" },
    }).buildArgs();

    assert.deepEqual(args.slice(-3), ["8515", "1", "4"]);
    for (const option of ["--hostbind", "-m", "-c", "-k", "-u"]) {
      assert.ok(args.indexOf(option) < args.indexOf("8515"), `${option} came after the positionals`);
    }
  });

  it("never enables the WebGui", () => {
    // Belt and braces alongside vendor patch 0006, which puts that listener on
    // the same --hostbind address and removes its developer mode outright.
    //
    // Worth a test anyway, because the WebGui is not merely a display: its '2'
    // message fires TWOTONETEST -- a real five-second transmission -- and that
    // one is NOT gated by developer mode. Nothing should turn this on until a
    // module deliberately does, and then only on loopback.
    for (const options of [
      { resourcesBinDir: "/r/bin", hostPort: 8515 },
      { resourcesBinDir: "/r/bin", hostPort: 8515, captureDevice: "1", playbackDevice: "4" },
    ]) {
      const args = new ArdopProcessManager(options).buildArgs();
      assert.ok(!args.includes("-G"), `-G reached the command line: ${args.join(" ")}`);
      assert.ok(!args.includes("--webgui"), `--webgui reached the command line: ${args.join(" ")}`);
      // A negative port is how developer mode used to be requested. Patch 0006
      // makes ardopcf refuse it; this makes sure we never ask.
      assert.ok(!args.some((arg) => /^-\d+$/.test(arg)), `negative port argument: ${args.join(" ")}`);
    }
  });

  it("only enables the WebGui when a caller deliberately asks", () => {
    // The counterpart to the test above. -G is not forbidden outright -- the
    // tuning session needs it on a scratch port -- so what has to hold is that
    // it appears if and ONLY if webguiPort was set, and still before the
    // positionals like every other option.
    const withGui = new ArdopProcessManager({ resourcesBinDir: "/r/bin", hostPort: 8515, webguiPort: 18701 });
    const args = withGui.buildArgs();
    const at = args.indexOf("-G");
    assert.notEqual(at, -1);
    assert.equal(args[at + 1], "18701");
    assert.ok(at < args.indexOf("8515"), "-G came after the positionals");
  });

  it("passes host commands as one semicolon-joined -H", () => {
    // ardopcf takes a single string, not repeated flags (ARDOPCommon.c, -H).
    // This is the only route to DRIVELEVEL on a modem Pat will attach to: the
    // host control socket is a scalar, so opening a second connection while Pat
    // holds it would displace Pat's.
    const manager = new ArdopProcessManager({
      resourcesBinDir: "/r/bin",
      hostPort: 8515,
      hostCommands: ["MYCALL M0ABC", "DRIVELEVEL 60"],
    });
    const args = manager.buildArgs();
    const at = args.indexOf("-H");
    assert.notEqual(at, -1);
    assert.equal(args[at + 1], "CONSOLELOG 2;SQUELCH 3;MYCALL M0ABC;DRIVELEVEL 60");
    assert.ok(at < args.indexOf("8515"), "-H came after the positionals");
  });

  it("always asks for DEBUG console output, whatever the caller sent", () => {
    // Not decoration. ardopcf reports the receive peak to the log only at
    // CONSOLELOG <= 2 (PaSound.c:1416), so a modem started without this leaves
    // a log in which "heard nothing" and "heard the station perfectly" are
    // byte-identical -- and that is the one question a failed session asks.
    for (const hostCommands of [undefined, [], ["", "   "], ["DRIVELEVEL 60"]]) {
      const args = new ArdopProcessManager({ resourcesBinDir: "/r/bin", hostPort: 8515, hostCommands }).buildArgs();
      const at = args.indexOf("-H");
      assert.notEqual(at, -1, `no -H for ${JSON.stringify(hostCommands)}`);
      assert.match(args[at + 1] ?? "", /^CONSOLELOG 2(;|$)/);
    }
  });

  it("always opens the squelch, whatever the caller sent", () => {
    // SoundInput.c:1796 will not attempt acquisition below the squelch, and
    // ardopcf's default of 5 (ARDOPC.c:109) demands 9 dB before the decoder
    // looks at all. Left to the callers this would be forgotten on exactly the
    // modem that needed it.
    for (const hostCommands of [undefined, [], ["DRIVELEVEL 60"]]) {
      const args = new ArdopProcessManager({ resourcesBinDir: "/r/bin", hostPort: 8515, hostCommands }).buildArgs();
      const at = args.indexOf("-H");
      assert.ok((args[at + 1] ?? "").includes("SQUELCH 3"), `no SQUELCH for ${JSON.stringify(hostCommands)}`);
    }
  });

  it("records received audio only when a directory is given", () => {
    const off = new ArdopProcessManager({ resourcesBinDir: "/r/bin", hostPort: 8515 }).buildArgs();
    assert.equal(off.includes("-w"), false, "recording is opt-in");
    assert.equal(off.includes("-l"), false, "no log directory without recording");
  });

  it("pairs -w with -l, because -w alone writes somewhere nobody will look", () => {
    // StartRxWav falls back to the process CWD when the log directory is empty
    // (PaSound.c:189-198), and WL2GO passes -m, so nothing else sets one. For a
    // packaged app that fallback is a directory the operator cannot find.
    const args = new ArdopProcessManager({
      resourcesBinDir: "/r/bin",
      hostPort: 8515,
      recordRxAudioDir: "/var/logs/wl2go",
    }).buildArgs();
    const w = args.indexOf("-w");
    const l = args.indexOf("-l");
    assert.notEqual(args.indexOf("-T"), -1, "transmit audio is recorded too");
    assert.notEqual(w, -1, "no -w");
    assert.notEqual(l, -1, "no -l");
    assert.equal(args[l + 1], "/var/logs/wl2go");
    assert.ok(w < args.indexOf("8515"), "-w came after the positionals");
    assert.ok(l < args.indexOf("8515"), "-l came after the positionals");
  });

  it("refuses a host command containing the separator", () => {
    // It would silently become two commands. Nothing WL2GO builds contains a
    // semicolon, so this can only be a bug -- and a bug that reaches ardopcf as
    // a valid-looking pair of commands is the worst kind.
    const manager = new ArdopProcessManager({
      resourcesBinDir: "/r/bin",
      hostPort: 8515,
      hostCommands: ["DRIVELEVEL 60;TWOTONETEST"],
    });
    assert.throws(() => manager.buildArgs(), /semicolon/);
  });

  it("configure() replaces the previous spawn's settings rather than merging", () => {
    // Merging would let one profile's keying survive into a session with a
    // profile that has none, and a radio that keys when nothing asked it to is
    // the worst failure this app can have.
    const manager = new ArdopProcessManager({
      resourcesBinDir: "/r/bin",
      hostPort: 8515,
      captureDevice: "1",
      playbackDevice: "2",
      ptt: { method: "cat", port: "/dev/cu.x", baud: 19200, keyHex: "AA", unkeyHex: "BB" },
    });
    assert.ok(manager.buildArgs().includes("-c"));

    manager.configure({ captureDevice: "3", playbackDevice: "4" });
    const args = manager.buildArgs();
    assert.deepEqual(args.slice(-3), ["8515", "3", "4"]);
    for (const flag of ["-c", "-k", "-u", "-p"]) {
      assert.ok(!args.includes(flag), `${flag} survived a configure() that dropped keying`);
    }
  });

  it("always binds the host interface to loopback", () => {
    // The whole point of patch 0005. An open host port is a TNC control
    // interface -- including transmit -- for anyone who can reach the machine.
    const args = manager.buildArgs();
    const at = args.indexOf("--hostbind");
    assert.notEqual(at, -1);
    assert.equal(args[at + 1], "127.0.0.1");
  });

  it("exposes the no-audio device name used for the self-test", () => {
    // The self-test must never claim the sound card; ardopcf skips audio
    // initialisation entirely for this device name.
    assert.equal(NO_AUDIO_DEVICE, "NOSOUND");
  });
});
