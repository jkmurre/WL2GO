import { useState } from "react";
import { useTuning } from "../../hooks/useTuning.ts";
import type { TuningOpenRequest } from "../../../shared/ipcContract.ts";

export interface TuningModalProps {
  /**
   * The devices and keying to tune, from the draft being edited.
   *
   * Not the active profile: this opens from the editor, where the operator may
   * be editing a different radio, and from the wizard, where the profile does
   * not exist yet.
   */
  target: TuningOpenRequest;
  /** Applied to the draft when the window closes, so the level is saved. */
  onDone: (driveLevel: number) => void;
  onCancel: () => void;
}

/**
 * Transmit drive, and a receive meter to set the other half by.
 *
 * The control an operator is looking for when they are told they are
 * splattering: ardopcf scales every transmitted sample by this
 * (Modulate.c:782), so lowering it is how you keep the radio's ALC from acting
 * on a digital signal and distorting it.
 *
 * The meter here is RECEIVE level, and the copy says so. WL2GO cannot read the
 * radio's ALC: that needs a CAT read while transmitting, and during the
 * two-tone test ardopcf owns the CAT port exclusively. The ALC reading is on
 * the radio's front panel until rig control arrives.
 */
export function TuningModal({ target, onDone, onCancel }: TuningModalProps) {
  const { state, setDriveLevel, transmit } = useTuning(target);
  const [armed, setArmed] = useState<"twoTone" | "id" | null>(null);

  const ready = state?.phase === "ready";
  const level = state?.driveLevel ?? target.driveLevel;
  const meterPercent = state
    ? Math.min(100, Math.round((state.receiveLevel / state.receiveLevelFullScale) * 100))
    : 0;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Set the transmit drive level">
      <div className="modal__card">
        <h2 className="modal__title">Transmit drive</h2>
        <p className="modal__detail">
          Send a test signal, watch the <strong>ALC meter on the radio</strong>, and pull this down until
          the ALC is barely moving. ALC acting on a digital signal is what distorts it and makes it hard
          for the other station to decode.
        </p>

        {state?.phase === "starting" ? <div className="field__help">Starting the modem…</div> : null}
        {state?.error ? <div className="settings__error">{state.error}</div> : null}

        <div className="field">
          <label className="field__label" htmlFor="drive-level">
            Drive level — {level}
          </label>
          <input
            id="drive-level"
            type="range"
            min={0}
            max={100}
            step={1}
            value={level}
            disabled={!ready}
            onChange={(e) => setDriveLevel(Number(e.target.value))}
          />
          <div className="field__help">
            0 is silence, 100 is full scale. The modem confirms each change, so this shows what it is
            actually set to rather than what was asked for.
          </div>
        </div>

        <div className="field">
          <span className="field__label">Receive level</span>
          <div
            className="meter"
            role="meter"
            aria-valuenow={meterPercent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Receive audio level"
          >
            <div className="meter__fill" style={{ width: `${meterPercent}%` }} />
          </div>
          {/* Named for what it is. An operator who reads this as ALC would tune
              against the wrong number entirely. */}
          <div className="field__help">
            {state?.meterUnavailable
              ? state.meterUnavailable
              : "Audio coming FROM the radio, not ALC. Set it in macOS System Settings › Sound › Input, " +
                "aiming for peaks around two thirds on a busy band."}
          </div>
        </div>

        <div className="field">
          <span className="field__label">Send a test signal</span>
          {armed ? (
            <>
              <div className="settings__notice">
                {armed === "twoTone"
                  ? `This transmits for ${5} seconds at the drive level above. Use a dummy load or a clear frequency.`
                  : "This transmits one short frame carrying your callsign. Use a dummy load or a clear frequency."}
              </div>
              <div className="settings__actions">
                <button
                  type="button"
                  className="btn btn--small btn--danger"
                  onClick={() => {
                    transmit(armed);
                    setArmed(null);
                  }}
                >
                  Transmit now
                </button>
                <button type="button" className="btn btn--small" onClick={() => setArmed(null)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <div className="settings__actions">
              <button
                type="button"
                className="btn btn--small"
                disabled={!ready || state?.transmitting}
                onClick={() => setArmed("twoTone")}
              >
                {state?.transmitting ? "Transmitting…" : "Two-tone, 5 seconds"}
              </button>
              <button
                type="button"
                className="btn btn--small"
                disabled={!ready || state?.transmitting}
                onClick={() => setArmed("id")}
              >
                Send my callsign
              </button>
            </div>
          )}
        </div>

        <div className="modal__actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={() => onDone(level)}>
            Use this level
          </button>
        </div>
      </div>
    </div>
  );
}
