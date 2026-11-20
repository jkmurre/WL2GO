import type { AppConfigView } from "../../../shared/ipcContract.ts";

export interface DiagnosticsSectionProps {
  config: AppConfigView;
  onSetRecordAudio: (enabled: boolean) => void;
}

/**
 * App-level troubleshooting switches. Applied on change rather than behind a
 * Save button: unlike the station identity there is nothing here to get into
 * a half-edited state, and a toggle that needs a second click to take effect
 * reads as broken.
 */
export function DiagnosticsSection({ config, onSetRecordAudio }: DiagnosticsSectionProps) {
  return (
    <section className="settings__section">
      <h2 className="settings__section-title">Diagnostics</h2>
      <p className="settings__section-detail">
        Tools for troubleshooting a session. Nothing here changes what goes on the air.
      </p>

      <fieldset className="field">
        <legend className="field__label">Audio recordings</legend>
        <label className="radio">
          <input
            type="checkbox"
            checked={config.diagnostics.recordRxAudio}
            onChange={(e) => onSetRecordAudio(e.target.checked)}
          />
          <span>Record received and transmitted audio for troubleshooting</span>
        </label>
        <div className="field__help">
          Saves WAV files of every on-air session to the log folder — about 24&nbsp;kB per second of
          receive time, and they are never deleted automatically. Takes effect from the next session.
          Replay one with <code>npm run decode-rx-wav</code>.
        </div>
      </fieldset>
    </section>
  );
}
