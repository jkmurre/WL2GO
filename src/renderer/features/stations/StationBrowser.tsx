import { useState } from "react";
import { useHybridNetwork } from "../../hooks/useHybridNetwork.ts";
import { useStations } from "../../hooks/useStations.ts";
import { isHybridStation, radioOnlyProblem } from "../../../shared/hybridNetwork.ts";
import {
  describeBearing,
  describeDistance,
  describeLinkQuality,
  type StationRow,
  type StationSort,
} from "../../../shared/stationList.ts";

export interface StationBrowserProps {
  /** The chosen ROW -- callsign, bandwidth and dial frequency together. */
  onCall: (station: StationRow) => void;
  onClose: () => void;
  /** Shown as a warning strip: things wrong with the radio that do not block. */
  warnings: string[];
  /**
   * Whether the active profile has rig control, which decides whether the
   * frequency shown is one WL2GO will tune to or one to set by hand.
   */
  tunesRadio: boolean;
  /** The remembered Radio-Only toggle, shared with the direct-call dialog. */
  radioOnly: boolean;
  onRadioOnlyChange: (value: boolean) => void;
  /** The operator's callsign, for the Radio-Only SSID check. */
  myCallsign: string;
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "an unknown date"
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

const SORTS: ReadonlyArray<{ value: StationSort; label: string }> = [
  { value: "quality", label: "Best forecast" },
  { value: "distance", label: "Nearest" },
  { value: "frequency", label: "Frequency" },
  { value: "callsign", label: "Callsign" },
];

/**
 * Picks an RMS gateway to call.
 *
 * Opens instead of dialling blind when the operator chooses the radio from the
 * Connect dropdown: unlike Telnet, an RF session needs a station and a
 * frequency, and neither has a sensible default.
 *
 * Every station Pat returns is listed. Link quality is shown and is the default
 * sort, but nothing is ever hidden for a poor or missing forecast -- it is a
 * propagation model's opinion, absent entirely when offline, and a station
 * filtered out is a station not called on the day it mattered.
 */
export function StationBrowser({
  onCall,
  onClose,
  warnings,
  tunesRadio,
  radioOnly,
  onRadioOnlyChange,
  myCallsign,
}: StationBrowserProps) {
  const stations = useStations(true);
  const network = useHybridNetwork(true);
  const [selected, setSelected] = useState<string | null>(null);
  // Off by default, and only offered in Radio-Only: the browser lists every
  // station Pat returns, and the hybrid list is a copy that may be days old.
  const [hybridOnly, setHybridOnly] = useState(false);

  const hybridList = network.hybrid?.stations ?? [];
  const isHybrid = (callsign: string) => isHybridStation(callsign, hybridList);
  const rows = radioOnly && hybridOnly ? stations.rows.filter((row) => isHybrid(row.callsign)) : stations.rows;

  // Matched on the ROW id, never the callsign. A gateway keeps several
  // frequencies and appears once per frequency; comparing callsigns highlighted
  // all of them and then resolved `chosen` to whichever came first, so picking
  // 7101 could dial 3585 at the wrong bandwidth. See StationRow.id.
  const chosen = rows.find((row) => row.id === selected) ?? null;

  const ssidProblem = radioOnly ? radioOnlyProblem(myCallsign) : null;
  // Advisory, never blocking, except where Pat itself would refuse (the SSID).
  const radioOnlyNotes: string[] = [];
  if (radioOnly) {
    if (chosen && network.hybrid && !isHybrid(chosen.callsign)) {
      radioOnlyNotes.push(
        `${chosen.callsign} is not on the hybrid station list, so it will probably refuse a Radio-Only session.`,
      );
    }
    if (network.pickup && network.pickup.stations.length === 0) {
      radioOnlyNotes.push(
        network.pickup.fetchedAt
          ? "You have no message pickup stations set. Mail sent to you while the internet is down has nowhere to wait. Set them in Settings while you are online."
          : "Your message pickup stations have never been checked. Open Settings while you are online to see or set them.",
      );
    }
    if (network.hybrid?.fetchedAt) {
      radioOnlyNotes.push(
        `Hybrid list from ${shortDate(network.hybrid.fetchedAt)}${network.hybrid.error ? ` — ${network.hybrid.error}` : "."}`,
      );
    } else if (network.hybrid) {
      radioOnlyNotes.push(
        "The hybrid station list has never been downloaded, so no station is marked Hybrid. Choose Update list while you are online.",
      );
    }
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Choose a station to call">
      <div className="modal__card modal__card--wide">
        <div>
          <h2 className="modal__title">Call a station over the air</h2>
          <p className="modal__detail">
            {tunesRadio
              ? "WL2GO will tune the radio to the frequency you pick and set its transmit mode, then put both back when the session ends."
              : "This profile has no rig control, so WL2GO will not tune the radio. Set it to the frequency shown, in a DATA mode, before connecting."}
          </p>
        </div>

        {warnings.length ? (
          <div className="settings__notice">
            {warnings.map((warning) => (
              <div key={warning}>{warning}</div>
            ))}
          </div>
        ) : null}

        <div className="settings__actions">
          <label className="field__label" htmlFor="station-sort">
            Sort by
          </label>
          <select
            id="station-sort"
            className="field__input field__input--narrow"
            value={stations.sort}
            onChange={(e) => stations.setSort(e.target.value as StationSort)}
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => {
              stations.refresh(true);
              network.refresh();
            }}
          >
            Update list
          </button>
          {stations.loading ? <span className="field__help">Loading…</span> : null}
        </div>

        <div className="settings__actions">
          <label className="radio">
            <input type="checkbox" checked={radioOnly} onChange={(e) => onRadioOnlyChange(e.target.checked)} />
            <span>Radio-Only (hybrid network)</span>
          </label>
          {radioOnly ? (
            <label className="radio">
              <input type="checkbox" checked={hybridOnly} onChange={(e) => setHybridOnly(e.target.checked)} />
              <span>Hybrid stations only</span>
            </label>
          ) : null}
        </div>

        {ssidProblem ? <div className="settings__error">{ssidProblem}</div> : null}
        {radioOnlyNotes.length ? (
          <div className="settings__notice">
            {radioOnlyNotes.map((note) => (
              <div key={note}>{note}</div>
            ))}
          </div>
        ) : null}

        {stations.error ? (
          <div className="settings__error">
            <div>The station list could not be loaded: {stations.error}</div>
            {/* Said explicitly, because the honest fallback is the cache and an
                operator in the field needs to know which they are looking at. */}
            <div>A list downloaded earlier stays usable offline; this one could not be refreshed.</div>
          </div>
        ) : null}

        <div className="station-list" role="listbox" aria-label="Stations">
          {rows.length === 0 && !stations.loading ? (
            <div className="empty-state">
              {stations.rows.length ? "No hybrid stations are in this list." : "No ARDOP stations were found."}
            </div>
          ) : null}

          {rows.map((station) => (
            <StationEntry
              key={station.id}
              station={station}
              hybrid={isHybrid(station.callsign)}
              selected={station.id === selected}
              onSelect={() => setSelected(station.id)}
            />
          ))}
        </div>

        <div className="modal__actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!chosen?.dialUrl || ssidProblem !== null}
            title={
              chosen && !chosen.dialUrl
                ? "This station cannot be called with ARDOP."
                : ssidProblem
                  ? "Radio-Only does not work with an SSID callsign."
                  : chosen && tunesRadio && chosen.tuningKhz !== null
                    ? `Tune to ${chosen.tuningKhz.toFixed(1)} kHz and call ${chosen.callsign}`
                    : "Start a session with the selected station"
            }
            onClick={() => chosen && onCall(chosen)}
          >
            Call {chosen ? chosen.callsign : "station"}
            {radioOnly ? " Radio-Only" : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

function StationEntry({
  station,
  hybrid,
  selected,
  onSelect,
}: {
  station: StationRow;
  hybrid: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`station${selected ? " station--selected" : ""}`}
      onClick={onSelect}
    >
      <span className="station__callsign">
        {station.callsign}
        {hybrid ? (
          <span className="station__badge" title="Forwards mail over RF when the internet is down">
            Hybrid
          </span>
        ) : null}
      </span>
      <span className="station__freq">
        {/* Null renders as a dash rather than "0 kHz" -- see describeDistance. */}
        {station.tuningKhz === null ? "—" : `${station.tuningKhz.toFixed(1)} kHz`}
      </span>
      <span className="station__distance">{describeDistance(station.distanceKm)}</span>
      <span className="station__bearing">{describeBearing(station.bearingDeg)}</span>
      <span className="station__modes">{station.modes || "—"}</span>
      <span className="station__quality">{describeLinkQuality(station.linkQuality)}</span>
    </button>
  );
}
