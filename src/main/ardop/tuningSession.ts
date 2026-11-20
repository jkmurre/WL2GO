// The tuning window's own modem, host connection and level meter.
//
// This is the piece that lets an operator set their transmit drive so the
// radio's ALC is barely moving -- the thing every VARA and Winlink Express user
// expects to find and WL2GO had no control over at all. ardopcf multiplies every
// transmitted sample by DriveLevel (Modulate.c:782), so it scales the two-tone
// test as well as a real session, which is what makes tuning against it valid.
//
// It runs a SECOND modem on a scratch port rather than reusing the session one,
// for two reasons that are both hard limits:
//
//   * ardopcf keeps one host control socket (TCPHostInterface.c:670), and Pat
//     holds it during a session. Opening it ourselves mid-session would cut Pat
//     off from its own modem.
//   * The sound card is held exclusively, so the tuning modem and a session
//     modem cannot coexist. That is why this is refused during a session rather
//     than attempted and reported as broken hardware.
//
// It is also the easiest place in the whole app to leave a radio keyed, so the
// teardown below is unconditional and runs on every path.

import type { Writable } from "node:stream";
import type { AudioDevice, TuningOpenRequest, TuningState } from "../../shared/ipcContract.ts";
import { RECEIVE_LEVEL_FULL_SCALE } from "../../shared/webguiProtocol.ts";
import { resolveAudioDevice } from "../audio/deviceResolver.ts";
import { findFreePortPair, isPortFree } from "../util/tcpProbe.ts";
import { ArdopProcessManager } from "./ardopProcessManager.ts";
import { ArdopHostClient } from "./ardopHostClient.ts";
import { ArdopWebguiClient, webguiVersionRefusal } from "./ardopWebgui.ts";
import { releasePtt } from "../serial/pttTester.ts";
import { defaultPtt, type HamlibConfig, type PttConfig, type TxMode } from "../../shared/configSchema.ts";
import { RigctldProcessManager } from "../rigctl/rigctldProcessManager.ts";
import { RigctlClient } from "../rigctl/rigctlClient.ts";
import { hamlibMode } from "../../shared/rigModes.ts";

/** How long the two-tone test transmits. ardopcf's own fixed duration. */
export const TWO_TONE_SECONDS = 5;

export interface TuningSessionOptions {
  resourcesBinDir: string;
  getCallsign: () => string;
  listAudioDevices: () => Promise<AudioDevice[]>;
  /** The vendored modem's version, for the meter's protocol assertion. */
  getModemVersion: () => Promise<string | null>;
  /** Refusal reason when a session is running, or null. */
  sessionInProgress: () => string | null;
  /**
   * Releases the resident rigctld so the tuning session can open the CAT port,
   * and puts it back afterwards.
   *
   * Needed because the tuning window edits a DRAFT profile -- possibly for a
   * different radio, possibly for one that does not exist yet -- so it cannot
   * reuse the resident rig, and one serial port cannot have two owners.
   * sessionInProgress() does not cover this: it guards against a live session,
   * and rig control is resident whether or not one is running.
   */
  suspendRigControl?: () => Promise<void>;
  resumeRigControl?: () => Promise<void>;
  onState: (state: TuningState) => void;
  onLog?: (message: string) => void;
  /**
   * Where the tuning modem's own output goes. Same file the session modem uses.
   *
   * Absent, the process was spawned with its stdout piped and nothing reading
   * it, so everything ardopcf said about the operator's audio -- the input
   * peaks it now reports at CONSOLELOG 2, and any device error -- was written
   * to a pipe and discarded. The tuning window is where an operator goes when
   * the radio is not working, so it is the last place that output should be
   * thrown away.
   */
  createLogStream?: () => Writable;
}

export class TuningSession {
  private readonly opts: TuningSessionOptions;
  private modem: ArdopProcessManager | null = null;
  private host: ArdopHostClient | null = null;
  private meter: ArdopWebguiClient | null = null;
  private webguiPort: number | null = null;
  private starting = false;
  /** Kept so close() can command the unkey without needing the caller again. */
  private ptt: PttConfig = defaultPtt();
  /** The tuning session's OWN rigctld, on the draft's CAT port. Null for none. */
  private rigctld: RigctldProcessManager | null = null;
  private rig: RigctlClient | null = null;
  /** True once the resident rig control has been stood down and owes a resume. */
  private rigSuspended = false;

  private state: TuningState = idleState();

  constructor(options: TuningSessionOptions) {
    this.opts = options;
  }

  getState(): TuningState {
    return this.state;
  }

  private setState(patch: Partial<TuningState>): void {
    this.state = { ...this.state, ...patch };
    this.opts.onState(this.state);
  }

  isRunning(): boolean {
    return this.modem !== null;
  }

  /**
   * Starts a modem with the DRAFT's devices and keying.
   *
   * Takes them as an argument rather than reading the active profile, for the
   * same reason the sound-card and keying tests do: this runs from the editor
   * and from the wizard, so the active profile is either a different radio or
   * -- in the wizard -- no radio at all, because the profile being tuned does
   * not exist yet. The whole point of the step is to try a setting before it is
   * saved.
   *
   * Real devices, not NOSOUND: the audio has to go through the operator's own
   * path for the radio to do anything with it. So this is also a moment macOS
   * may ask for microphone consent.
   */
  async open(request: TuningOpenRequest): Promise<TuningState> {
    const busy = this.opts.sessionInProgress();
    if (busy) {
      this.setState({ ...idleState(), error: busy });
      return this.state;
    }
    if (this.modem || this.starting) return this.state;

    const callsign = this.opts.getCallsign().trim().toUpperCase();
    if (!callsign) {
      // Not a nicety. ardopcf refuses TWOTONETEST without MYCALL
      // (HostInterface.c:1438-1442) so that every transmission can be
      // identified -- so without a callsign the button would fault, not tune.
      this.setState({ ...idleState(), error: "Set your callsign in Settings first: the modem will not transmit without one." });
      return this.state;
    }

    this.starting = true;
    this.setState({ ...idleState(), phase: "starting" });

    try {
      const devices = await this.opts.listAudioDevices();
      const capture = resolveAudioDevice(request.audioInput, devices, "capture");
      const playback = resolveAudioDevice(request.audioOutput, devices, "playback");
      if (!capture.ok) throw new Error(capture.message);
      if (!playback.ok) throw new Error(playback.message);

      const hostPort = await findFreePortPair();
      const webguiPort = await freeWebguiPort(hostPort);
      this.webguiPort = webguiPort;

      // Rig control BEFORE the modem, and the resident one stood down first:
      // one serial port, one owner. Also before the modem because the mode has
      // to be right for the two-tone test to modulate anything at all -- in
      // plain USB an Icom transmits its microphone, so the test would produce
      // no ALC movement however the drive level was set, which is exactly the
      // "drive level does nothing" the operator sees.
      await this.startRigControl(request.hamlib, request.txMode);

      const modem = new ArdopProcessManager({
        resourcesBinDir: this.opts.resourcesBinDir,
        hostPort,
        ...(this.opts.createLogStream ? { createLogStream: this.opts.createLogStream } : {}),
      });
      modem.configure({
        captureDevice: capture.argument,
        playbackDevice: playback.argument,
        ptt: request.ptt,
        // MYCALL is what makes TWOTONETEST legal to ardopcf, and DRIVELEVEL
        // starts the session where the profile left it rather than at full
        // scale.
        hostCommands: [`MYCALL ${callsign}`, `DRIVELEVEL ${request.driveLevel}`],
        webguiPort,
      });

      // Registered before it is known to be healthy: a modem that started and
      // then failed readiness is still a process holding a sound card, and
      // quitting must stop it.
      this.modem = modem;
      // Recorded BEFORE the modem can possibly key anything, so close() always
      // knows what to send even if start() itself fails.
      this.ptt = request.ptt;
      await modem.start();

      const host = new ArdopHostClient({ port: hostPort });
      await host.connect();
      this.host = host;
      this.bridgePttToRig(host);

      this.startMeter(webguiPort);

      this.setState({
        phase: "ready",
        driveLevel: request.driveLevel,
        receiveLevel: 0,
        transmitting: false,
        error: null,
        meterUnavailable: this.state.meterUnavailable,
      });
      this.opts.onLog?.(`Tuning modem started on port ${hostPort} at drive level ${request.driveLevel}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Everything that got as far as existing is torn down, including a modem
      // that started before a later step failed.
      await this.close();
      this.setState({ ...idleState(), error: `The tuning modem could not start: ${message}` });
    } finally {
      this.starting = false;
    }

    return this.state;
  }

  /** Sets the drive level on the running modem. Does not save the profile. */
  async setDriveLevel(level: number): Promise<TuningState> {
    const clamped = Math.max(0, Math.min(100, Math.round(level)));
    // Optimistic, then corrected: the modem echoes DriveLevel back on the
    // WebGui socket, so a rejected value does not stay on screen.
    this.setState({ driveLevel: clamped });

    const host = this.host;
    if (!host) return this.state;
    const result = await host.send(`DRIVELEVEL ${clamped}`);
    if (!result.ok) this.setState({ error: result.reply });
    return this.state;
  }

  /**
   * Transmits. Either two tones for five seconds, or one ID frame.
   *
   * The caller is responsible for having asked the operator first -- this is
   * the point at which the radio actually goes on the air.
   */
  async transmit(kind: "twoTone" | "id"): Promise<TuningState> {
    const host = this.host;
    if (!host) {
      this.setState({ error: "The tuning modem is not running." });
      return this.state;
    }
    if (this.state.transmitting) return this.state;

    this.setState({ transmitting: true, error: null });
    const result = await host.send(kind === "twoTone" ? "TWOTONETEST" : "SENDID");
    if (!result.ok) {
      this.setState({ transmitting: false, error: result.reply });
      return this.state;
    }

    // ardopcf transmits from its background loop and reports nothing when it
    // finishes, so the flag is cleared on the known duration. Erring long is
    // right: the button staying disabled a moment too long is harmless, while
    // re-enabling early invites a second transmission on top of the first.
    const settleMs = (kind === "twoTone" ? TWO_TONE_SECONDS + 1 : 3) * 1000;
    setTimeout(() => {
      if (this.host) this.setState({ transmitting: false });
    }, settleMs);
    return this.state;
  }

  /**
   * Stops everything, in every circumstance.
   *
   * Called on close, on cancel, on an error part-way through open(), on window
   * destroy and on app quit. Stopping the modem is what releases the radio:
   * ardopcf sends its unkey command as it shuts down, and killing the process
   * drops RTS with the port. Ordered meter, then host, then modem, so nothing is
   * reading a socket that is about to disappear.
   */
  async close(): Promise<TuningState> {
    this.meter?.close();
    this.meter = null;

    // Unkey through rig control FIRST, while every socket is still open.
    //
    // Under rig-control keying this is the only thing that stops the carrier:
    // ardopcf was given no PTT arguments, so the transmitter is keyed by US in
    // response to its host notifications, and killing the modem does not undo
    // that any more than killing it undoes bytes already written to a serial
    // port. Ordered before the host and modem shutdown so it cannot be skipped
    // by either of them failing.
    if (this.rig) await this.rig.send("\\set_ptt 0").catch(() => undefined);

    await this.host?.close().catch(() => {});
    this.host = null;

    const modem = this.modem;
    this.modem = null;
    this.webguiPort = null;
    if (modem) {
      await modem.stop().catch(() => {});
      this.opts.onLog?.("Tuning modem stopped and the sound card released");
    }

    // Unconditional, and AFTER the modem has let go of the port.
    //
    // Stopping the modem is not enough to release the radio. ardopcf sends its
    // unkey as part of finishing a transmission -- so a modem that is killed,
    // crashes, or hangs mid-transmission never sends it, and with CAT keying
    // the radio stays TRANSMITTING. Killing a process does not undo a command
    // already written to a serial port.
    //
    // This is not hypothetical: ardopcf did exactly that on macOS until the
    // PaSound.c fixes of 2026-08-27, keying the radio and then dying before it
    // could ever unkey. Belt and braces is the right ratio for the one failure
    // this project's stated differentiator is about.
    await releasePtt(this.ptt);

    // The tuning rigctld goes last, and the resident one comes back after it,
    // so the CAT port is never wanted by two processes at once.
    await this.stopRigControl();

    this.setState({ ...idleState(), error: this.state.error });
    return this.state;
  }

  /** Registered with the quit path, which expects a stop(). */
  async stop(): Promise<void> {
    await this.close();
  }

  /**
   * Stands the resident rigctld down and brings one up on the draft's radio.
   *
   * Everything here is best-effort and reported through `meterUnavailable`-style
   * state rather than by refusing to open: an operator whose rig settings are
   * wrong is precisely the operator who needs the tuning window, and refusing to
   * open it would leave them with no way to test anything.
   */
  private async startRigControl(hamlib: HamlibConfig | null, txMode: TxMode): Promise<void> {
    if (!hamlib?.device) return;

    // The resident rigctld holds this same serial port whenever a rig profile
    // is active, so it has to let go before we can open it.
    if (this.opts.suspendRigControl) {
      await this.opts.suspendRigControl();
      this.rigSuspended = true;
    }

    // A scratch port, never the profile's. Pat may still be pointed at that
    // one, and answering on it would be worse than not listening.
    const port = await findFreeRigctlPort(hamlib.port);
    const manager = new RigctldProcessManager({
      resourcesBinDir: this.opts.resourcesBinDir,
      port,
      model: hamlib.model,
      device: hamlib.device,
      baudRate: hamlib.baud,
    });
    this.rigctld = manager;

    try {
      await manager.start();
      const client = new RigctlClient({ port });
      await client.connect();
      this.rig = client;

      const wanted = hamlibMode(txMode);
      const set = await client.send(`\\set_mode ${wanted} 0`);
      this.opts.onLog?.(
        set.ok
          ? `Tuning session set the radio to ${wanted} on port ${port}`
          : `The radio would not switch to ${wanted} for tuning: ${set.error}`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.onLog?.(`Rig control could not start for tuning: ${message}`);
      await this.stopRigControl();
    }
  }

  /** Drops the tuning rigctld and hands the CAT port back to the resident one. */
  private async stopRigControl(): Promise<void> {
    await this.rig?.close().catch(() => {});
    this.rig = null;

    const manager = this.rigctld;
    this.rigctld = null;
    if (manager) await manager.stop().catch(() => {});

    if (this.rigSuspended) {
      this.rigSuspended = false;
      await this.opts.resumeRigControl?.().catch(() => {});
    }
  }

  /**
   * Turns the modem's PTT notifications into rig-control keying.
   *
   * With ptt.method "rigctld" ardopcf is given no PTT arguments, so it leaves
   * RadioControl false and reports "PTT TRUE"/"PTT FALSE" to whoever holds its
   * host socket (PaSound.c:1655-1670). During a session that is Pat, which keys
   * through Hamlib itself. HERE it is WL2GO -- so without this bridge the
   * tuning window's two-tone test would generate audio into a radio that never
   * keys, and every drive level would look identical because none of them
   * reached the air.
   *
   * ArdopHostClient already routes "PTT " lines to its unprompted-line
   * listeners rather than treating them as command replies, which is what makes
   * this a subscription rather than a protocol change.
   */
  private bridgePttToRig(host: ArdopHostClient): void {
    host.onLine((line) => {
      if (!line.startsWith("PTT ")) return;
      const keyed = line.slice("PTT ".length).trim().toUpperCase() === "TRUE";
      // Not awaited: this is a notification handler, and an unkey that queued
      // behind a slow key would be exactly the wrong thing to serialise. The
      // client's own queue keeps the two commands in order.
      void this.rig?.send(`\\set_ptt ${keyed ? 1 : 0}`);
      this.setState({ transmitting: keyed });
    });
  }

  private startMeter(webguiPort: number): void {
    void this.opts
      .getModemVersion()
      .then((version) => {
        if (!this.modem || this.webguiPort !== webguiPort) return;
        const refusal = webguiVersionRefusal(version);
        if (refusal) {
          // The meter goes; tuning stays. A level readout is not worth
          // refusing to let someone set their drive level over.
          this.setState({ meterUnavailable: refusal });
          return;
        }

        const meter = new ArdopWebguiClient({
          port: webguiPort,
          onReading: (reading) => {
            if (reading.kind === "receiveLevel") {
              this.setState({ receiveLevel: reading.value });
            } else {
              this.setState({ driveLevel: reading.value });
            }
          },
          onDesynchronised: (reason) => this.setState({ meterUnavailable: reason }),
          onError: (message) => this.opts.onLog?.(`Level meter: ${message}`),
        });
        meter.connect();
        this.meter = meter;
        this.setState({ meterUnavailable: null });
      })
      .catch(() => {
        this.setState({ meterUnavailable: "WL2GO could not check the modem version, so the meter is off." });
      });
  }
}

function idleState(): TuningState {
  return {
    phase: "idle",
    driveLevel: 100,
    receiveLevel: 0,
    receiveLevelFullScale: RECEIVE_LEVEL_FULL_SCALE,
    transmitting: false,
    error: null,
    meterUnavailable: null,
  };
}

/**
 * A scratch port for the tuning session's rigctld, clear of the profile's own.
 *
 * Never the configured one: Pat may still be pointed at that address, and a
 * daemon answering there for a DRAFT profile's radio would be worse than
 * nothing at all.
 */
async function findFreeRigctlPort(configuredPort: number): Promise<number> {
  for (let port = configuredPort + 1; port < configuredPort + 40; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error("No free port was available for rig control.");
}

/**
 * A free port for the WebGui, clear of the host port and its data port.
 *
 * ardopcf's data port is always hostPort + 1 (undocumented but relied on
 * throughout), so a WebGui landing there would collide with the modem's own
 * listener rather than with some other program.
 */
async function freeWebguiPort(hostPort: number): Promise<number> {
  for (let port = hostPort + 2; port < hostPort + 40; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error("No free port was available for the modem's status stream.");
}
