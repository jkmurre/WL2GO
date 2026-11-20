import { useState } from "react";
import { ARDOP_BANDWIDTHS, type ArdopBandwidth, isArdopBandwidth } from "../../../shared/ardopUrl.ts";
import { radioOnlyProblem } from "../../../shared/hybridNetwork.ts";

/**
 * Call a station by callsign and frequency, without the RMS list.
 *
 * The peer-to-peer path: Pat dials whatever callsign it is given and proposes
 * any outbox mail addressed to it, so "P2P" needs no session machinery of its
 * own -- only a way to punch in a station the downloaded list does not know.
 * The same dialog carries Winlink hybrid Radio-Only mode (grid-down: the far
 * station keeps mail on the RF network, no internet), which Pat implements by
 * appending -T to OUR callsign -- hence the SSID warning below.
 */
export interface DirectCallDialogProps {
  /** Whether the active profile has rig control; decides if a frequency tunes. */
  tunesRadio: boolean;
  /** The operator's callsign, so the radio-only SSID conflict is shown early. */
  myCallsign: string;
  /** The remembered Radio-Only toggle, shared with the station browser. */
  radioOnly: boolean;
  onRadioOnlyChange: (value: boolean) => void;
  onClose: () => void;
  onCall: (call: {
    target: string;
    bandwidth: ArdopBandwidth;
    dialKhz: number | null;
    radioOnly: boolean;
  }) => void;
}

/** Callsign shape: liberal on purpose; the air decides what answers. */
const CALLSIGN_RE = /^[A-Z0-9]{3,}(-\d{1,2})?$/;

const LAST_CALL_KEY = "wl2go.directCall";

interface Remembered {
  target?: string;
  bandwidth?: string;
  dialKhz?: string;
}

function remembered(): Remembered {
  try {
    return JSON.parse(localStorage.getItem(LAST_CALL_KEY) ?? "{}") as Remembered;
  } catch {
    return {};
  }
}

export function DirectCallDialog({
  tunesRadio,
  myCallsign,
  radioOnly,
  onRadioOnlyChange,
  onClose,
  onCall,
}: DirectCallDialogProps) {
  const last = remembered();
  const [target, setTarget] = useState(last.target ?? "");
  const [dialKhz, setDialKhz] = useState(last.dialKhz ?? "");
  const [bandwidth, setBandwidth] = useState<ArdopBandwidth>(
    last.bandwidth && isArdopBandwidth(last.bandwidth) ? last.bandwidth : "500MAX",
  );

  const callsign = target.trim().toUpperCase();
  const callsignOk = CALLSIGN_RE.test(callsign);
  // An empty frequency is allowed either way: with rig control it means "call
  // on the current frequency"; without it the operator tunes by hand anyway.
  const khz = dialKhz.trim() === "" ? null : Number(dialKhz);
  const khzOk = khz === null || (Number.isFinite(khz) && khz > 0);
  const ssidProblem = radioOnlyProblem(myCallsign);
  const radioOnlyBlocked = radioOnly && ssidProblem !== null;
  const ready = callsignOk && khzOk && !radioOnlyBlocked;

  const submit = () => {
    if (!ready) return;
    try {
      localStorage.setItem(
        LAST_CALL_KEY,
        JSON.stringify({ target: callsign, bandwidth, dialKhz: dialKhz.trim() }),
      );
    } catch {
      // A convenience only; a blocked localStorage must not block the call.
    }
    onCall({ target: callsign, bandwidth, dialKhz: khz, radioOnly });
  };

  return (
    <div className="modal" role="dialog" aria-label="Call a station directly">
      <div className="modal__card">
        <h2 className="modal__title">Call a station directly</h2>
        <p className="modal__detail">
          Dial any station by callsign — another operator for a peer-to-peer exchange, or a station
          the list does not carry. Messages addressed to that callsign go out during the session.
        </p>

        <div className="field">
          <label className="field__label" htmlFor="direct-call-target">
            Station callsign
          </label>
          <input
            id="direct-call-target"
            className="field__input"
            value={target}
            onChange={(e) => setTarget(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="N0CALL"
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="direct-call-freq">
            Dial frequency (kHz)
          </label>
          <input
            id="direct-call-freq"
            className="field__input"
            inputMode="decimal"
            value={dialKhz}
            onChange={(e) => setDialKhz(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="7101.5"
            autoComplete="off"
            spellCheck={false}
          />
          <div className="field__help">
            {tunesRadio
              ? "The radio is tuned here before the channel check; leave it empty to call on the current frequency."
              : "This profile has no rig control, so set the radio's frequency and mode by hand before calling."}
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="direct-call-bw">
            Bandwidth
          </label>
          <select
            id="direct-call-bw"
            className="field__input"
            value={bandwidth}
            onChange={(e) => {
              if (isArdopBandwidth(e.target.value)) setBandwidth(e.target.value);
            }}
          >
            {ARDOP_BANDWIDTHS.map((bw) => (
              <option key={bw} value={bw}>
                {bw}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="field">
          <legend className="field__label">Winlink network</legend>
          <label className="radio">
            <input type="checkbox" checked={radioOnly} onChange={(e) => onRadioOnlyChange(e.target.checked)} />
            <span>Radio-only session (hybrid network — no internet at the far station)</span>
          </label>
          <div className="field__help">
            {radioOnlyBlocked
              ? ssidProblem
              : "For grid-down use with hybrid stations and your message pickup stations. It stays on for every " +
                "call until you turn it off, so turn it off for an ordinary peer-to-peer call to another operator."}
          </div>
        </fieldset>

        <div className="modal__actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!ready}
            title={
              !callsignOk
                ? "Enter the callsign of the station to call."
                : radioOnlyBlocked
                  ? "Radio-only does not work with an SSID callsign."
                  : "Listen for a clear channel, then call this station"
            }
            onClick={submit}
          >
            Call
          </button>
        </div>
      </div>
    </div>
  );
}
