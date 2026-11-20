// The radio's state around one session: put it into a transmit mode that is
// safe to send data in, and put it back afterwards.
//
// WHAT THIS DOES NOT DO IS AS IMPORTANT AS WHAT IT DOES.
//
// It does not DECIDE the frequency. There is exactly one VFO writer per
// session, chosen by ArdopConnectionManager: when the pre-dial clear-channel
// check can pre-tune (rig control plus a dial frequency), WL2GO tunes through
// readFrequencyHz/setFrequencyHz below, drops `freq=` from Pat's URL so Pat's
// own qsy() never runs, and restores the frequency itself in the session
// teardown. When it cannot, Pat owns the frequency exactly as before: `freq=`
// sends Connect() through a.qsy(), which stores the old dial frequency and
// restores it on a deferred call when the session ends (app/connect.go:236-247).
// Both writers at once would leave the operator on whichever one happened to
// land last, which is why the choice is exclusive.
//
// It also runs against the RESIDENT rigctld -- the one Pat is already talking
// to -- rather than starting its own. rigctld accepts many simultaneous
// connections, unlike ardopcf's single host socket, so this is safe; and it has
// to be this way, because Pat opens its rig once at startup
// (app/app.go:455-500) and would not survive the port being taken away.

import type { RadioProfile } from "../../shared/configSchema.ts";
import { hamlibMode, modeMatches, type HamlibMode } from "../../shared/rigModes.ts";
import { formatRawBytes, labelledValue, parseRawBytes, type RigctlClient } from "./rigctlClient.ts";
import { CIV_CONTROLLER_ADDRESS, parseCivFrames, type CivFrame } from "../../shared/civFrame.ts";
import {
  buildMenuReadFrame,
  buildMenuWriteFrame,
  dataModMenuFor,
  formatMenuAddress,
  menuValueFromReply,
  writeAcknowledged,
  type DataModMenu,
} from "../../shared/civMenu.ts";

/**
 * FE FE <to> <from> 1A 05 <hi> <lo> <value> FD -- the answer to a menu read.
 *
 * Ten, for the one-byte values every menu item WL2GO addresses uses. A radio
 * that answered with more would simply not be read, which is the state the
 * whole DATA MOD path already treats as ordinary.
 */
const MENU_ANSWER_BYTES = 10;

/** FE FE <to> <from> FB FD -- the acknowledgement to a write. */
const CIV_ACK_BYTES = 6;

/**
 * One CI-V exchange through rigctld, tolerant of the radio's echo setting.
 *
 * `\\send_cmd` cannot do this. For a binary reply it prints the FIRST
 * FD-terminated chunk and returns (rigctl_parse.c:5463-5470) -- and on a radio
 * with CI-V USB Echo Back on, that chunk is OUR OWN COMMAND coming back, not
 * the answer. `\\send_cmd_rx` takes an exact byte count instead, so it can be
 * told to read past the echo.
 *
 * Which means the count depends on a setting in the operator's radio, so both
 * are tried. THE ORDER IS FORCED, and getting it backwards loses the data:
 * asking for MORE bytes than arrive makes Hamlib time out and DISCARD what it
 * read, so a too-long request destroys the very bytes the retry would need.
 * Asking too short only leaves bytes behind, and Hamlib flushes the port before
 * its next write (rigctl_parse.c:5312) -- so short-then-long always converges.
 * Measured both ways against an IC-7300 MkII on 2026-08-27.
 *
 * The retry re-sends the frame, which is why every caller here sends only
 * idempotent ones: reading a menu item, and writing a value that is already
 * being written unconditionally.
 */
async function sendCivFrame(
  client: RigctlClient,
  frame: Uint8Array,
  replyBytes: number,
): Promise<CivFrame[]> {
  for (const total of [replyBytes, frame.length + replyBytes]) {
    const result = await client.send(`\\send_cmd_rx ${formatRawBytes(frame)} ${total}`);
    if (!result.ok) continue;
    const frames = parseCivFrames(parseRawBytes(result.lines.join(" ")));
    // Anything addressed FROM the controller is the echo. Only the radio
    // answering in its own name proves the exchange completed.
    if (frames.some((civ) => civ.from !== CIV_CONTROLLER_ADDRESS)) return frames;
  }
  return [];
}

/** The radio's mode as it was before WL2GO changed it. */
export interface RigSnapshot {
  mode: string;
  passband: string;
  /**
   * The DATA MOD value read before it was changed, or null when it was not
   * touched -- no address for this model, no CI-V address, or the read failed.
   */
  dataMod: { menu: DataModMenu; value: number[] } | null;
}

export interface RigPrepareResult {
  ok: boolean;
  /** Null when nothing was changed, so there is nothing to put back. */
  snapshot: RigSnapshot | null;
  /** Named and actionable when ok is false. */
  error: string | null;
}

export interface RigSessionOptions {
  /** The live connection to the resident rigctld, or null when none runs. */
  getClient: () => RigctlClient | null;
  onLog?: (message: string) => void;
}

export class RigSession {
  private readonly opts: RigSessionOptions;

  constructor(options: RigSessionOptions) {
    this.opts = options;
  }

  /**
   * Puts the radio into the profile's transmit mode, and says what it was.
   *
   * A profile with no rig control succeeds with a null snapshot: "WL2GO does
   * not drive this radio" is a supported configuration, not a failure, and it
   * is exactly what every profile did before rig control existed.
   */
  async prepareForCall(profile: RadioProfile): Promise<RigPrepareResult> {
    if (!profile.hamlib) return { ok: true, snapshot: null, error: null };

    const client = this.opts.getClient();
    if (!client) {
      return {
        ok: false,
        snapshot: null,
        error:
          `"${profile.name}" is set up for rig control, but rig control is not running. ` +
          `Check the radio is switched on and connected, then try again.`,
      };
    }

    const wanted = hamlibMode(profile.txMode);

    // Read BEFORE writing, so there is something to put back even if the write
    // half fails. A snapshot taken afterwards would record our own change.
    const before = await client.send("\\get_mode");
    if (!before.ok) {
      return { ok: false, snapshot: null, error: `The radio's current mode could not be read: ${before.error}.` };
    }
    const snapshot: RigSnapshot = {
      mode: labelledValue(before.lines, "Mode") ?? "",
      passband: labelledValue(before.lines, "Passband") ?? "0",
      dataMod: null,
    };

    const set = await client.send(`\\set_mode ${wanted} 0`);
    if (!set.ok) {
      return { ok: false, snapshot, error: `The radio would not switch to ${wanted}: ${set.error}.` };
    }

    // Read back, and treat a mismatch as a failure.
    //
    // Not belt-and-braces. Hamlib reports RPRT 0 for a mode a backend accepted
    // but the radio did not act on -- the dummy backend answers RPRT 0 to
    // "\set_mode NOSUCH 0" -- and the difference between USB and PKTUSB is
    // precisely whether the microphone is live. Transmitting after an
    // unverified mode change is how an operator's voice ends up on the air.
    const after = await client.send("\\get_mode");
    const reported = after.ok ? labelledValue(after.lines, "Mode") : null;
    if (!modeMatches(reported, wanted)) {
      return {
        ok: false,
        snapshot,
        error: describeModeMismatch(profile, wanted, reported, after.error),
      };
    }

    // DATA MOD last, and NON-BLOCKING on purpose.
    //
    // Setting the mode above is what mutes the microphone on an Icom, so the
    // failure that matters is already handled by the time this runs. This only
    // chooses between the USB codec and the ACC socket as the data audio
    // source, and a radio whose address WL2GO has not measured is an ordinary
    // state rather than a reason to refuse a session.
    this.restoreAddress = civAddressFromProfile(profile);
    snapshot.dataMod = await this.applyDataMod(client, profile);

    this.opts.onLog?.(`Radio set to ${wanted} (was ${snapshot.mode || "unknown"})`);
    return { ok: true, snapshot, error: null };
  }

  /**
   * Points the radio's data modulation at the USB codec, if we know how.
   *
   * Returns what it read first, so restore() can put it back, or null when
   * nothing was changed. Every branch that cannot proceed says so in the log
   * and returns null -- this must never throw into prepareForCall, because a
   * menu setting is not worth failing a session over.
   */
  private async applyDataMod(
    client: RigctlClient,
    profile: RadioProfile,
  ): Promise<RigSnapshot["dataMod"]> {
    const menu = profile.hamlib ? dataModMenuFor(profile.hamlib.model) : null;
    if (!menu) return null;

    // The radio's CI-V address comes from the profile's own keying commands,
    // which is where WL2GO already records it.
    const radioAddress = civAddressFromProfile(profile);
    if (radioAddress === null) {
      this.opts.onLog?.("The radio's CI-V address is not known, so DATA MOD was left alone.");
      return null;
    }

    // A radio whose menu read has failed once is not probed again this run.
    // Not just economy: on such radios the failing \send_cmd_rx is what makes
    // rigctld drop this client's connection, so re-probing every session
    // re-kills the freshly healed rig client -- taking the pre-tune, the mode
    // restore and the unkey path down with it.
    const probeKey = `${profile.hamlib?.model ?? 0}:${radioAddress}`;
    if (this.dataModUnreadable.has(probeKey)) return null;

    const current = await this.readMenu(client, radioAddress, menu);
    if (!current) {
      this.dataModUnreadable.add(probeKey);
      this.opts.onLog?.(
        `DATA MOD could not be read at ${formatMenuAddress(menu.address)}; it was left alone ` +
          `and will not be probed again for this radio until the app restarts.`,
      );
      return null;
    }
    if (current.length === 1 && current[0] === menu.usb) return null; // already right

    const acked = writeAcknowledged(
      await sendCivFrame(client, buildMenuWriteFrame(radioAddress, menu.address, [menu.usb]), CIV_ACK_BYTES),
    );
    if (!acked) {
      this.opts.onLog?.("The radio did not acknowledge a DATA MOD change.");
      return null;
    }

    // Read back, exactly as the mode change above does, and for the same
    // reason: write.ok only says rigctld put the bytes on the wire. The radio
    // answers a write with ACK or NAK, and a NAK -- or a menu item this model
    // will not accept in this mode -- would otherwise be logged as a success.
    //
    // The read-back is checked rather than the ACK because it is authoritative
    // whichever way rigctld happens to report the reply frame.
    const verified = await this.readMenu(client, radioAddress, menu);
    if (!verified || verified.length !== 1 || verified[0] !== menu.usb) {
      this.opts.onLog?.(
        `The radio did not take the DATA MOD change; it is still ` +
          `${(verified ?? current).map(hex).join(" ")}. Set DATA MOD to ${menu.label} by hand ` +
          `if the sound card is not being transmitted.`,
      );
      // Nothing to put back: reporting a change that did not happen would have
      // restore() write the old value over a setting it never altered.
      return null;
    }

    this.opts.onLog?.(`Radio DATA MOD set to ${menu.label} (was ${current.map(hex).join(" ")})`);
    return { menu, value: current };
  }

  /** One menu read, decoded, or null for anything that did not come back. */
  private async readMenu(
    client: RigctlClient,
    radioAddress: number,
    menu: DataModMenu,
  ): Promise<number[] | null> {
    const frames = await sendCivFrame(client, buildMenuReadFrame(radioAddress, menu.address), MENU_ANSWER_BYTES);
    return menuValueFromReply(frames, menu.address);
  }

  /**
   * Puts the mode back. Best effort, and deliberately silent about failing.
   *
   * This runs in a teardown, after the session's own outcome has already been
   * decided. A failure here is worth a log line and nothing more: replacing a
   * real session result with "could not restore the mode" would bury what
   * actually happened.
   */
  async restore(snapshot: RigSnapshot | null): Promise<void> {
    if (!snapshot) return;
    const client = this.opts.getClient();
    if (!client) return;

    // DATA MOD first, while the radio is still in the data mode we set. Some
    // Icom menu items are only addressable in the mode they belong to, and
    // putting the mode back first would be the ordering that discovers it.
    if (snapshot.dataMod) {
      const { menu, value } = snapshot.dataMod;
      const address = this.restoreAddress;
      if (address !== null) {
        const acked = writeAcknowledged(
          await sendCivFrame(client, buildMenuWriteFrame(address, menu.address, value), CIV_ACK_BYTES),
        );
        this.opts.onLog?.(
          acked
            ? `Radio DATA MOD put back to ${value.map(hex).join(" ")}`
            : "The radio's DATA MOD could not be put back.",
        );
      }
    }

    if (!snapshot.mode) return;
    const result = await client.send(`\\set_mode ${snapshot.mode} ${snapshot.passband || "0"}`);
    this.opts.onLog?.(
      result.ok
        ? `Radio put back to ${snapshot.mode}`
        : `The radio's mode could not be put back to ${snapshot.mode}: ${result.error}`,
    );
  }

  /** The CI-V address the last prepareForCall used, so restore can reach it. */
  private restoreAddress: number | null = null;

  /** Radios (model:address) whose DATA MOD read failed; never re-probed. */
  private readonly dataModUnreadable = new Set<string>();

  /**
   * The dial frequency in Hz, or null when it cannot be read. Never throws:
   * the caller degrades to not pre-tuning, which is what every session did
   * before the clear-channel check existed.
   */
  async readFrequencyHz(): Promise<number | null> {
    const client = this.opts.getClient();
    if (!client) return null;
    const result = await client.send("\\get_freq");
    if (!result.ok) return null;
    const value = labelledValue(result.lines, "Frequency");
    const hz = value === null ? Number.NaN : Number.parseInt(value, 10);
    return Number.isFinite(hz) && hz > 0 ? hz : null;
  }

  /** Sets the dial frequency. Returns false, and logs, when the radio refuses. */
  async setFrequencyHz(hz: number): Promise<boolean> {
    const client = this.opts.getClient();
    if (!client) return false;
    const wanted = Math.round(hz);
    const result = await client.send(`\\set_freq ${wanted}`);
    if (!result.ok) {
      this.opts.onLog?.(`The radio would not tune to ${wanted} Hz: ${result.error}`);
      return false;
    }

    // Read back, exactly as prepareForCall does for the mode, and for the
    // same reason: RPRT 0 only says a backend accepted the command. A dial
    // that silently did not move would put the clear-channel listen -- and
    // the call -- on the wrong frequency, which is the bug this path exists
    // to prevent. On a mismatch the caller degrades to letting Pat tune at
    // dial time, exactly as if the pre-tune had never been attempted.
    const reported = await this.readFrequencyHz();
    if (reported === null || Math.abs(reported - wanted) > 1) {
      this.opts.onLog?.(
        `The radio reports ${reported === null ? "no frequency" : `${reported} Hz`} after being tuned ` +
          `to ${wanted} Hz.`,
      );
      return false;
    }
    return true;
  }

  /**
   * Commands the radio to stop transmitting, right now.
   *
   * The FIRST thing an abort does, and under Hamlib keying it is the only thing
   * that reliably works: Pat asserts PTT through rigctld, so killing the modem
   * leaves the transmitter keyed -- there is no serial port being dropped to
   * save us the way there was when ardopcf owned the CAT line itself.
   *
   * Returns whether the command was accepted, so the caller can say plainly
   * when it was not.
   */
  async stopTransmitting(): Promise<boolean> {
    const client = this.opts.getClient();
    if (!client) return false;
    const result = await client.send("\\set_ptt 0");
    if (!result.ok) this.opts.onLog?.(`The radio would not unkey through rig control: ${result.error}`);
    return result.ok;
  }
}

/**
 * Why a mode change did not take, in terms that name the next action.
 *
 * The two causes need different things from the operator: a radio that reports
 * a DIFFERENT mode is usually one whose backend does not support the DATA
 * variant, while one that reports nothing has stopped answering.
 */
/** Two hex digits, for a log line about menu bytes. */
function hex(byte: number): string {
  return byte.toString(16).toUpperCase().padStart(2, "0");
}

/**
 * The radio's CI-V address, taken from the profile's own keying command.
 *
 * WL2GO already records it there: an Icom key command is FE FE <radio> E0 1C
 * 00 01 FD, so the third byte IS the address, and it is the address the
 * operator confirmed when they set keying up. Derived rather than stored a
 * second time -- two copies of one fact is how they end up disagreeing.
 *
 * Returns null when there is no CAT command to read it out of, which is the
 * ordinary case for a profile keying through rig control alone.
 */
export function civAddressFromProfile(profile: RadioProfile): number | null {
  const hexCommand = profile.ptt.keyHex || profile.ptt.unkeyHex;
  if (!hexCommand || hexCommand.length < 8) return null;
  if (!hexCommand.toUpperCase().startsWith("FEFE")) return null;
  const address = Number.parseInt(hexCommand.slice(4, 6), 16);
  return Number.isInteger(address) && address > 0 ? address : null;
}

function describeModeMismatch(
  profile: RadioProfile,
  wanted: HamlibMode,
  reported: string | null,
  error: string | null,
): string {
  if (reported === null) {
    return (
      `The radio did not confirm it switched to ${wanted}` +
      (error ? `: ${error}` : "") +
      `. WL2GO will not transmit without knowing the radio is in a data mode.`
    );
  }
  return (
    `The radio was asked for ${wanted} but reports ${reported}. ` +
    `That usually means the model set for "${profile.name}" does not match the radio. ` +
    `WL2GO will not transmit in a mode where the microphone may be live.`
  );
}
