import { useEffect, useState } from "react";
import type { AppConfigView } from "../../../shared/ipcContract.ts";
import {
  isValidCallsign,
  isValidGridSquare,
  normaliseCallsign,
  normaliseGridSquare,
} from "../../../shared/configSchema.ts";

export interface StationIdentityFormProps {
  config: AppConfigView;
  onSaveStation: (callsign: string, gridSquare: string, shareWithWinlink: boolean) => Promise<boolean>;
  onSavePassword: (password: string) => Promise<boolean>;
}

/**
 * Who the operator is. Saving here rewrites Pat's derived config and restarts
 * the engine, so changes apply without the operator doing anything.
 */
export function StationIdentityForm({ config, onSaveStation, onSavePassword }: StationIdentityFormProps) {
  const [callsign, setCallsign] = useState(config.station.callsign);
  const [gridSquare, setGridSquare] = useState(config.station.gridSquare);
  const [password, setPassword] = useState("");
  const [share, setShare] = useState(config.station.shareWithWinlink);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  // Re-sync when the stored config changes underneath the form -- another view
  // (or a future onboarding flow) can write the same fields.
  useEffect(() => {
    setCallsign(config.station.callsign);
    setGridSquare(config.station.gridSquare);
    setShare(config.station.shareWithWinlink);
  }, [config.station.callsign, config.station.gridSquare, config.station.shareWithWinlink]);

  const trimmedCall = normaliseCallsign(callsign);
  const trimmedGrid = normaliseGridSquare(gridSquare);
  const callsignError = trimmedCall && !isValidCallsign(trimmedCall) ? "That does not look like a callsign." : null;
  const gridError =
    trimmedGrid && !isValidGridSquare(trimmedGrid) ? "Use a Maidenhead locator such as FN31 or FN31pr." : null;

  const identityDirty =
    trimmedCall !== config.station.callsign ||
    trimmedGrid !== config.station.gridSquare ||
    share !== config.station.shareWithWinlink;
  const canSaveIdentity = identityDirty && !callsignError && !gridError;


  async function saveIdentity(event: React.FormEvent) {
    event.preventDefault();
    if (!canSaveIdentity) return;
    if (await onSaveStation(trimmedCall, trimmedGrid, share)) {
      // The protocol engine is restarted automatically to pick this up, so
      // there is nothing for the operator to do.
      setSavedNote("Saved.");
    }
  }

  async function savePassword(event: React.FormEvent) {
    event.preventDefault();
    if (await onSavePassword(password)) {
      setPassword("");
      setSavedNote(password ? "Password saved to your keychain." : "Password cleared.");
    }
  }

  return (
    <section className="settings__section">
      <h2 className="settings__section-title">Station identity</h2>
      <p className="settings__section-detail">
        Your callsign identifies you to Winlink. It is also the name Pat runs under.
      </p>

      <form className="settings__form" onSubmit={saveIdentity}>
        <div className="field">
          <label className="field__label" htmlFor="callsign">
            Callsign
          </label>
          <input
            id="callsign"
            className={`field__input${callsignError ? " field__input--invalid" : ""}`}
            value={callsign}
            onChange={(e) => {
              setCallsign(e.target.value.toUpperCase());
              setSavedNote(null);
            }}
            placeholder="W1AW"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={callsignError ? true : undefined}
            aria-describedby="callsign-help"
          />
          <div className="field__help" id="callsign-help">
            {callsignError ?? "Changing this restarts the protocol engine."}
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="grid">
            Grid square
          </label>
          <input
            id="grid"
            className={`field__input${gridError ? " field__input--invalid" : ""}`}
            value={gridSquare}
            onChange={(e) => {
              setGridSquare(e.target.value);
              setSavedNote(null);
            }}
            placeholder="FN31pr"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={gridError ? true : undefined}
            aria-describedby="grid-help"
          />
          <div className="field__help" id="grid-help">
            {gridError ?? "Optional. Used when reporting your position to Winlink."}
          </div>
        </div>

        <fieldset className="field">
          <legend className="field__label">Sharing with Winlink</legend>
          <label className="radio">
            <input
              type="checkbox"
              checked={share}
              onChange={(e) => {
                setShare(e.target.checked);
                setSavedNote(null);
              }}
            />
            <span>Tell Winlink which client version I use</span>
          </label>
          <div className="field__help">
            When on, WL2GO contacts api.winlink.org on launch: it reports your callsign and the WL2GO
            version, and checks that your account has a password-recovery address set. That second
            check sends your Winlink password over HTTPS to verify it. Turning this off stops both
            calls — WL2GO will then contact nothing until you press Connect, but you will not be
            warned if you have no way to recover a forgotten password.
          </div>
        </fieldset>

        <div className="settings__actions">
          <button type="submit" className="btn btn--primary" disabled={!canSaveIdentity}>
            Save
          </button>
          {savedNote ? <span className="settings__note">{savedNote}</span> : null}
        </div>
      </form>

      <h2 className="settings__section-title">Winlink password</h2>
      <p className="settings__section-detail">
        {config.secureStorageAvailable
          ? "Stored in your system keychain, never in WL2GO's configuration file."
          : "This system has no keychain available, so a password cannot be stored safely."}
      </p>

      <form className="settings__form" onSubmit={savePassword}>
        <div className="field">
          <label className="field__label" htmlFor="winlink-password">
            Password
          </label>
          <input
            id="winlink-password"
            className="field__input"
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setSavedNote(null);
            }}
            placeholder={config.hasWinlinkPassword ? "••••••••  (stored)" : "Not set"}
            autoComplete="off"
            disabled={!config.secureStorageAvailable}
            aria-describedby="password-help"
          />
          <div className="field__help" id="password-help">
            {config.hasWinlinkPassword
              ? "A password is stored. Type a new one to replace it."
              : "No password stored yet."}
          </div>
        </div>

        <div className="settings__actions">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={!config.secureStorageAvailable || password.length === 0}
          >
            Save password
          </button>
          {config.hasWinlinkPassword ? (
            <button type="button" className="btn" onClick={() => void onSavePassword("")}>
              Clear
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
