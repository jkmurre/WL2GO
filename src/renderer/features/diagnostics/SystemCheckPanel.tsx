import { useCallback, useEffect, useState } from "react";
import type { AppInfo, CheckStatus, DiagnosticsReport } from "../../../shared/ipcContract.ts";

const STATUS_GLYPH: Record<CheckStatus, string> = {
  pass: "✓",
  warn: "!",
  fail: "✕",
  pending: "◌",
};

const BANNER: Record<CheckStatus, { glyph: string; title: string; detail: string }> = {
  pass: {
    glyph: "✓",
    title: "All checks passed",
    detail: "The application shell, logging, clean shutdown and the Pat protocol engine are all working.",
  },
  warn: {
    glyph: "!",
    title: "Running with warnings",
    detail: "WL2GO started, but something below is not in its expected state.",
  },
  fail: {
    glyph: "✕",
    title: "Checks failed",
    detail: "Something below needs attention before WL2GO can talk to a Winlink station.",
  },
  pending: {
    glyph: "◌",
    title: "Starting up…",
    detail: "Waiting for the Pat protocol engine to become ready.",
  },
};

export interface SystemCheckPanelProps {
  appInfo: AppInfo | null;
  onReport: (report: DiagnosticsReport) => void;
}

export function SystemCheckPanel({ appInfo, onReport }: SystemCheckPanelProps) {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    try {
      const next = await window.wl2go.diagnostics.run();
      setReport(next);
      onReport(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [onReport]);

  useEffect(() => {
    void run();
  }, [run]);

  // Pat needs a moment to come up, so keep re-checking while anything is still
  // pending. A failed check resolves to "fail", which stops the polling.
  useEffect(() => {
    if (report?.overall !== "pending") return;
    const timer = setTimeout(() => void run(), 1000);
    return () => clearTimeout(timer);
  }, [report, run]);

  const banner = BANNER[report?.overall ?? "pending"];

  return (
    <section className="pane" aria-label="System check">
      <header className="pane__header">
        <div>
          <span className="pane__title">System Check</span>
          <span className="pane__subtitle"> — verifies that WL2GO's components are installed and working</span>
        </div>
        <div className="pane__actions">
          <button type="button" className="btn" onClick={() => void window.wl2go.app.openLogs()}>
            Open logs folder
          </button>
          <button type="button" className="btn" onClick={() => void run()} disabled={running}>
            {running ? "Checking…" : "Re-run"}
          </button>
        </div>
      </header>

      <div className="pane__scroll check">
        <div className="check__inner">
        <div className={`check__banner check__banner--${report?.overall ?? "pending"}`}>
          <span className="check__banner-glyph" aria-hidden="true">
            {banner.glyph}
          </span>
          <div>
            <div className="check__banner-title">{banner.title}</div>
            <div className="check__banner-detail">{error ?? banner.detail}</div>
          </div>
        </div>

        <div className="check__list">
          {(report?.checks ?? []).map((check) => (
            <div className="check__row" key={check.id}>
              <span className={`check__icon check__icon--${check.status}`} aria-hidden="true">
                {STATUS_GLYPH[check.status]}
              </span>
              <div>
                <div className="check__label">{check.label}</div>
                <div className="check__detail">{check.detail}</div>
                {check.hint ? <div className="check__hint">{check.hint}</div> : null}
              </div>
            </div>
          ))}
        </div>

        {appInfo ? (
          <>
            <h2 className="check__section-title">Environment</h2>
            <dl className="check__meta">
              <dt>WL2GO</dt>
              <dd>
                v{appInfo.appVersion} ({appInfo.isPackaged ? "packaged" : "development"})
              </dd>
              <dt>Pat</dt>
              <dd>{appInfo.patVersion ?? "not vendored"}</dd>
              <dt>ARDOP modem</dt>
              <dd>{appInfo.ardopcfVersion ?? "not vendored"}</dd>
              <dt>Rig control</dt>
              <dd>{appInfo.rigctldVersion ? `Hamlib ${appInfo.rigctldVersion}` : "not vendored"}</dd>
              <dt>Platform</dt>
              <dd>
                {appInfo.platform}/{appInfo.arch}
              </dd>
              <dt>Electron</dt>
              <dd>
                {appInfo.electron} (Chromium {appInfo.chrome}, Node {appInfo.node})
              </dd>
            </dl>
          </>
        ) : null}
        </div>
      </div>
    </section>
  );
}
