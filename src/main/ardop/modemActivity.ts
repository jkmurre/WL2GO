// Turns the session modem's console output into the two status-bar lights.
//
// This reads the SAME stream the log file gets, not a new channel: ardopcf
// reports keying and decoding nowhere else that WL2GO can reach during a
// session. The WebGui socket does carry PTT and busy flags, but opening it on
// the session modem means passing -G, and the WebGui can TRANSMIT (its '2'
// message fires a real five-second two-tone test, Webgui.c:784-790) -- a light
// is not worth widening that surface. The host socket is Pat's alone
// (TCPHostInterface.c:670 holds a single connection).
//
// Every pattern here is only present because ardopProcessManager forces
// CONSOLELOG 2 (DEBUG) on every modem it starts: KeyPTT and the correlator log
// at ZF_LOGD. If that command ever goes, these lights go dark with it -- which
// its comment now says.

import type { ModemActivity, RxIndicator } from "../../shared/ipcContract.ts";

/**
 * Where each pattern comes from, so a vendored-source bump can re-verify them:
 *
 *   PTT-TRUE / PTT-FALSE      PaSound.c KeyPTT(): "[Main.KeyPTT]  PTT-%s"
 *   EnvelopeCorrelator        SoundInput.c:1961, logged when the demodulator
 *                             locks a leader and starts on a frame
 *   Frame Type Decode OK      SoundInput.c, the frame header decoded -- for
 *                             control frames (ACK/NAK/BREAK) this IS the frame
 *   poor frame type decode    SoundInput.c:1011, the header did not decode
 *   Decode PASS / FAIL        SoundInput.c:3764/3790, a data frame's payload
 *
 * A data frame therefore reports twice: OK on its header, then PASS or FAIL on
 * its payload seconds later. The light going green-then-red on a payload
 * failure is the point, not a glitch.
 *
 * The SIGN-OFF patterns ride the same stream, and drive the session's closing
 * stages rather than a light. They are reported as SEPARATE events because
 * they mean different things -- the first says a disconnect was requested, the
 * second that the mandatory station ID is actually going out, and conflating
 * them once made the status bar claim an ID that was never transmitted:
 *
 *   Command Trace FROM host: DISCONNECT]   HostInterface.c:266 -- the host
 *                             asked for the ARQ disconnect (the trailing "]"
 *                             is what keeps DISCONNECTED from matching)
 *   SendID                    ARDOPC.c:1608 -- an IDFrame is about to go out,
 *                             on EVERY path: inline with the close, or from
 *                             the 3-second tmrFinalID deferral
 *   Sending CW ID of          Modulate.c:969 -- the CW tail of the same ID;
 *                             fires as a second onIdStart, which the watcher
 *                             and the stage gate both tolerate
 *
 * The stage gates live in PatConnectionManager (beginSignOff/beginSendingId),
 * which only move forward -- so a stray line from an aborted dial, or a
 * mid-session ten-minute IDFrame, advances nothing it should not.
 *
 * onPtt feeds finalIdWatcher.ts: the teardown holds the modem's SIGTERM until
 * the ID's final PTT-FALSE, which is the fix for the deferred-ID race.
 */
export interface ModemActivityEvents {
  onChange: (activity: ModemActivity) => void;
  /** The host asked for the disconnect. Says nothing about the station ID. */
  onSignOff?: () => void;
  /** An IDFrame or its CW tail is starting. May fire twice per sign-off. */
  onIdStart?: () => void;
  /** Every PTT edge, in stream order. */
  onPtt?: (on: boolean) => void;
}

export class ModemActivityTracker {
  private readonly events: ModemActivityEvents;
  private transmitting = false;
  private rx: RxIndicator = "idle";
  /** Tail of the last chunk that did not end in a newline. */
  private pending = "";

  constructor(events: ModemActivityEvents) {
    this.events = events;
  }

  /** Feed raw stdout/stderr data; chunks need not align with line breaks. */
  ingest(chunk: string): void {
    const lines = (this.pending + chunk).split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.applyLine(line);
  }

  /** Back to idle-and-silent. Called when the modem stops; a stale light lies. */
  reset(): void {
    this.pending = "";
    this.update(false, "idle");
  }

  private applyLine(line: string): void {
    if (line.includes("Command Trace FROM host: DISCONNECT]")) {
      this.events.onSignOff?.();
      return;
    }
    // "SendID " with the trailing space: the same function's other lines carry
    // only the "[ARDOPC.SendID]" logger tag, where a "]" follows the name.
    if (line.includes("SendID ") || line.includes("Sending CW ID of ")) {
      this.events.onIdStart?.();
      return;
    }

    let tx = this.transmitting;
    let rx = this.rx;

    if (line.includes("PTT-TRUE")) {
      tx = true;
      this.events.onPtt?.(true);
    } else if (line.includes("PTT-FALSE")) {
      tx = false;
      this.events.onPtt?.(false);
    } else if (line.includes("EnvelopeCorrelator")) rx = "receiving";
    else if (line.includes("Frame Type Decode OK") || line.includes("Decode PASS")) rx = "good";
    else if (line.includes("poor frame type decode") || line.includes("Decode FAIL")) rx = "bad";
    else return;

    this.update(tx, rx);
  }

  private update(transmitting: boolean, rx: RxIndicator): void {
    if (transmitting === this.transmitting && rx === this.rx) return;
    this.transmitting = transmitting;
    this.rx = rx;
    this.events.onChange({ transmitting, rx });
  }
}
