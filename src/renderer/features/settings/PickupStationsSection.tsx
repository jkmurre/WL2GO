import { useEffect, useState, type FormEvent } from "react";
import type { AppConfigView, HybridStation, PickupStationsView } from "../../../shared/ipcContract.ts";
import { MAX_PICKUP_STATIONS, RECOMMENDED_PICKUP_STATIONS, pickupLimitNote, radioOnlyProblem } from "../../../shared/hybridNetwork.ts";
import { ipcMessage } from "../../hooks/useConfig.ts";

export interface PickupStationsSectionProps {
  config: AppConfigView;
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "an unknown date"
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const CALLSIGN_RE = /^[A-Z0-9]{3,}(-\d{1,2})?$/;

/**
 * Message Pickup Stations: where the operator's mail waits on the hybrid
 * network when the CMS cannot be reached.
 *
 * Every change goes through Winlink over the internet -- there is no way to
 * make one over the air -- so this section says so up front, and keeps showing
 * the last list seen when it is offline rather than going blank. Each change
 * is applied immediately, like the diagnostics switches: the CMS is the only
 * copy that counts, so there is no draft to save.
 */
export function PickupStationsSection({ config }: PickupStationsSectionProps) {
  const [view, setView] = useState<PickupStationsView | null>(null);
  const [hybrid, setHybrid] = useState<HybridStation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  const callsign = config.station.callsign;
  const hasPassword = config.hasWinlinkPassword;

  // Re-read when the identity changes: pickup stations belong to a callsign,
  // and a newly stored password is what makes the list changeable.
  useEffect(() => {
    let live = true;
    void window.wl2go.winlink.pickupStations({}).then(
      (next) => live && setView(next),
      () => {},
    );
    void window.wl2go.winlink.hybridStations({}).then(
      (next) => live && setHybrid(next.stations),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [callsign, hasPassword]);

  async function run(change: () => Promise<PickupStationsView>) {
    setBusy(true);
    setError(null);
    try {
      setView(await change());
      return true;
    } catch (err) {
      setError(ipcMessage(err));
      // Whatever happened, show what Winlink now holds -- or the last copy.
      void window.wl2go.winlink.pickupStations({}).then(setView, () => {});
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    const target = adding.trim().toUpperCase();
    if (!CALLSIGN_RE.test(target)) return;
    if (await run(() => window.wl2go.winlink.addPickupStation({ callsign: target }))) setAdding("");
  }

  const stations = view?.stations ?? [];
  const full = stations.length >= MAX_PICKUP_STATIONS;
  const limitNote = pickupLimitNote(stations.length);
  const ssidProblem = radioOnlyProblem(callsign);
  const locked = !callsign || !hasPassword;
  const candidate = adding.trim().toUpperCase();
  const known = new Set(stations.map((s) => s.callsign));
  const suggestions = hybrid.filter((s) => !known.has(s.callsign));

  return (
    <section className="settings__section">
      <h2 className="settings__section-title">Radio-Only network</h2>
      <p className="settings__section-detail">
        When the internet is down, Winlink&apos;s hybrid stations keep mail moving over the air. Mail
        for you waits at your <strong>message pickup stations</strong> until you connect Radio-Only to
        one of them. Choose hybrid stations you can reach reliably — Winlink recommends{" "}
        {RECOMMENDED_PICKUP_STATIONS}, and allows at most {MAX_PICKUP_STATIONS}.
      </p>
      <div className="settings__notice">
        Changing this list needs the internet. Set it up now, while you are online — it cannot be done
        over the air.
      </div>

      {!callsign ? (
        <div className="settings__empty">Set your callsign above first.</div>
      ) : !hasPassword ? (
        <div className="settings__empty">
          Store your Winlink password above first. Winlink needs it to change your pickup stations.
        </div>
      ) : null}
      {ssidProblem ? <div className="settings__notice">{ssidProblem}</div> : null}
      {error ? <div className="settings__error">{error}</div> : null}
      {view?.error && !error ? <div className="settings__error">{view.error}</div> : null}

      {stations.length ? (
        <ul className="profile-list">
          {stations.map((station) => (
            <li key={station.callsign} className="profile">
              <div className="profile__main">
                <div className="profile__name">{station.callsign}</div>
                {station.addedAt ? <div className="profile__detail">Added {when(station.addedAt)}</div> : null}
              </div>
              <div className="profile__actions">
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={busy || locked}
                  // Said here because it is not obvious: Winlink can only clear
                  // the whole list, so a remove is a clear and a re-add.
                  title="Winlink can only clear the whole list, so the others are added back afterwards."
                  onClick={() => void run(() => window.wl2go.winlink.removePickupStation({ callsign: station.callsign }))}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : view ? (
        <div className="settings__empty">
          {view.fetchedAt
            ? "You have no pickup stations set. Mail sent to you while the internet is down has nowhere to wait."
            : "Your pickup stations have not been checked yet."}
        </div>
      ) : null}

      <form className="settings__form" onSubmit={(e) => void add(e)}>
        <div className="field">
          <label className="field__label" htmlFor="pickup-add">
            Add a pickup station
          </label>
          <input
            id="pickup-add"
            className="field__input"
            value={adding}
            onChange={(e) => setAdding(e.target.value.toUpperCase())}
            list="pickup-hybrid-stations"
            placeholder="Hybrid station callsign"
            autoComplete="off"
            spellCheck={false}
            disabled={busy || locked || full}
            aria-describedby="pickup-add-help"
          />
          <datalist id="pickup-hybrid-stations">
            {suggestions.map((station) => (
              <option key={station.callsign} value={station.callsign} />
            ))}
          </datalist>
          <div className="field__help" id="pickup-add-help">
            {limitNote ??
              (hybrid.length
                ? "Suggestions come from Winlink's list of hybrid stations."
                : "Open the station browser while online and choose Update list to get suggestions.")}
          </div>
        </div>

        <div className="settings__actions">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busy || locked || full || !CALLSIGN_RE.test(candidate)}
          >
            Add
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !callsign}
            onClick={() => void run(() => window.wl2go.winlink.pickupStations({ refresh: true }))}
          >
            Refresh
          </button>
          {stations.length ? (
            <button
              type="button"
              className="btn btn--danger"
              disabled={busy || locked}
              onClick={() => setConfirmClear(true)}
            >
              Clear all
            </button>
          ) : null}
          {busy ? <span className="settings__note">Talking to Winlink…</span> : null}
          {!busy && view?.fetchedAt ? <span className="settings__note">Checked {when(view.fetchedAt)}</span> : null}
        </div>
      </form>

      {confirmClear ? (
        <div className="settings__confirm" role="alertdialog" aria-label="Confirm clearing pickup stations">
          <div>
            Remove all your pickup stations? Until you set new ones, mail sent to you while the internet is
            down has nowhere to wait.
          </div>
          <div className="settings__actions">
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                setConfirmClear(false);
                void run(() => window.wl2go.winlink.clearPickupStations());
              }}
            >
              Clear all
            </button>
            <button type="button" className="btn" onClick={() => setConfirmClear(false)}>
              Keep them
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
