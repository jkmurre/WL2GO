import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TuningSession, type TuningSessionOptions } from "./tuningSession.ts";
import { DEFAULT_DRIVE_LEVEL, defaultPtt } from "../../shared/configSchema.ts";
import type { AudioDevice, TuningOpenRequest, TuningState } from "../../shared/ipcContract.ts";

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

const DEVICES: AudioDevice[] = [device({ direction: "capture", index: 1 }), device({ direction: "playback", index: 2 })];

/** What the editor or wizard hands over: the DRAFT, not a saved profile. */
function target(over: Partial<TuningOpenRequest> = {}): TuningOpenRequest {
  return {
    audioInput: { name: "USB Audio CODEC", index: 1, hostApi: "Core Audio" },
    audioOutput: { name: "USB Audio CODEC", index: 2, hostApi: "Core Audio" },
    ptt: defaultPtt(),
    driveLevel: DEFAULT_DRIVE_LEVEL,
    hamlib: null,
    txMode: "auto",
    ...over,
  };
}

/**
 * A session pointed at a missing binary, so open() always fails at the spawn.
 *
 * That is enough for everything worth testing here: the refusals all happen
 * BEFORE anything is spawned, and the teardown is what has to hold when a
 * later step fails. Actually starting a modem would need a sound card.
 */
function session(over: Partial<TuningSessionOptions> = {}) {
  const states: TuningState[] = [];
  const options: TuningSessionOptions = {
    resourcesBinDir: "/nonexistent/bin",
    getCallsign: () => "M0ABC",
    listAudioDevices: async () => DEVICES,
    getModemVersion: async () => "1.0.4.1.3",
    sessionInProgress: () => null,
    onState: (state) => states.push(state),
    ...over,
  };
  return { tuning: new TuningSession(options), states };
}

describe("TuningSession.open", () => {
  it("refuses while a Winlink session is running, and spawns nothing", async () => {
    // The sound card is held exclusively and Pat owns the modem's single host
    // control socket, so attempting this mid-session would fail in a way that
    // reads as broken hardware at the worst possible moment.
    let listed = false;
    const { tuning } = session({
      sessionInProgress: () => "A Winlink session is in progress. Disconnect before tuning.",
      listAudioDevices: async () => {
        listed = true;
        return DEVICES;
      },
    });

    const state = await tuning.open(target());
    assert.equal(state.phase, "idle");
    assert.match(String(state.error), /session is in progress/);
    assert.equal(listed, false, "nothing should be touched before the refusal");
    assert.equal(tuning.isRunning(), false);
  });

  it("refuses without a callsign, because the modem would fault anyway", async () => {
    // ardopcf rejects TWOTONETEST when MYCALL is unset (HostInterface.c:1438),
    // so that every transmission can be identified. Saying so here is better
    // than a modem that starts and then refuses the only button that matters.
    const { tuning } = session({ getCallsign: () => "   " });
    const state = await tuning.open(target());
    assert.equal(state.phase, "idle");
    assert.match(String(state.error), /callsign/i);
  });

  it("tunes the draft it was given, not whichever profile is active", async () => {
    // The bug this replaces: the session read configService.activeProfile(),
    // but the window opens over a DRAFT. In the editor that is a different
    // radio; in the wizard the profile does not exist yet, so the operator
    // would have been told "no radio profile is set up" while creating one.
    //
    // The modem cannot start here (missing binary), but the devices are
    // resolved first, so a draft naming an absent device proves the draft's
    // values are what got used.
    const { tuning } = session();
    const state = await tuning.open(
      target({ audioInput: { name: "SignaLink USB", index: 7, hostApi: "Core Audio" } }),
    );
    assert.match(String(state.error), /SignaLink USB/);
  });

  it("works with no saved profiles at all, which is the wizard's case", async () => {
    // Nothing in the session consults stored configuration any more except the
    // callsign, which is station-level.
    const { tuning } = session();
    const state = await tuning.open(target());
    assert.match(String(state.error), /could not start/);
    assert.doesNotMatch(String(state.error), /No radio profile/);
  });

  it("names a missing audio device instead of starting a modem that cannot hear", async () => {
    const { tuning } = session({ listAudioDevices: async () => [] });
    const state = await tuning.open(target());
    assert.equal(state.phase, "idle");
    assert.match(String(state.error), /USB Audio CODEC/);
  });

  it("leaves nothing running when the modem fails to start", async () => {
    // The binary is missing here, so start() throws after the process manager
    // exists. Everything built so far has to come down with it -- a half-open
    // tuning session is a sound card nobody can get back.
    const { tuning } = session();
    const state = await tuning.open(target());
    assert.equal(state.phase, "idle");
    assert.match(String(state.error), /could not start/);
    assert.equal(tuning.isRunning(), false);
  });
});

describe("TuningSession when nothing is running", () => {
  it("says so rather than pretending to transmit", async () => {
    const { tuning } = session();
    const state = await tuning.transmit("twoTone");
    assert.equal(state.transmitting, false);
    assert.match(String(state.error), /not running/);
  });

  it("accepts and clamps a drive level without a modem to send it to", async () => {
    // The slider is allowed to move before the modem is up; what must not
    // happen is an out-of-range value being remembered as the level.
    const { tuning } = session();
    assert.equal((await tuning.setDriveLevel(140)).driveLevel, 100);
    assert.equal((await tuning.setDriveLevel(-20)).driveLevel, 0);
    assert.equal((await tuning.setDriveLevel(63.6)).driveLevel, 64);
  });

  it("closes cleanly when it never opened", async () => {
    // close() is called from the window unmount, from cancel, and from quit --
    // including on a session that failed to start. It must never throw.
    const { tuning } = session();
    await tuning.close();
    await tuning.stop();
    assert.equal(tuning.isRunning(), false);
  });
});
