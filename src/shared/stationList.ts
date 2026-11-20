// The RMS gateway list, as the station browser needs it.
//
// Pure, and in shared/, because every hard part of this is a display decision
// over data whose shape is easy to misread: Pat's frequencies are objects, its
// distances are null rather than absent when we have no grid square, and its
// prediction is nullable. All three render as "[object Object]", "NaN" or
// "null" if handled casually, and tsc catches none of them.

import type { RmsStation } from "./ipcContract.ts";
import { parseRmsUrl, tuningFrequencyKhz, type ArdopBandwidth } from "./ardopUrl.ts";

/** One station as the list renders it: every field already a string or a number. */
export interface StationRow {
  /**
   * Identity of this ROW, not of the station.
   *
   * A gateway commonly appears several times in one listing, once per frequency
   * it keeps, and those entries differ in the two fields that actually get
   * dialled. Selection used to be tracked by callsign alone, which highlighted
   * every one of a station's frequencies at once and then dialled whichever
   * happened to be first -- so choosing 7101 could call on 3585. Anything that
   * identifies a row must use this.
   */
  id: string;
  callsign: string;
  gridsquare: string;
  /** Kilometres, or null when our own grid square is not set. */
  distanceKm: number | null;
  /** Degrees true, or null for the same reason. */
  bearingDeg: number | null;
  modes: string;
  /** What to tune the radio to, in kHz. */
  tuningKhz: number | null;
  /** Advisory. Null is an ordinary state, not an error. */
  linkQuality: number | null;
  /** The URL to dial, already stripped of freq. Null when it cannot be dialled. */
  dialUrl: string | null;
  /**
   * The ARQ bandwidth this station advertises, kept as DATA rather than only
   * inside dialUrl -- the caller has to pass it to the dial, and reading it back
   * out of the string is how it gets dropped.
   */
  bandwidth: ArdopBandwidth | null;
}

export type StationSort = "quality" | "distance" | "callsign" | "frequency";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  // JSONFloat64 marshals NaN and Inf as null (app/rmslist.go:34-39), which is
  // what we get when the operator has no grid square set. Absent and null both
  // mean "unknown", and neither is zero.
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Turns one of Pat's records into a row, or null if it cannot be used.
 *
 * Defensive because this data comes off the internet through Pat: a record
 * missing its callsign or its URL is not something to render half of.
 */
export function toStationRow(raw: unknown): StationRow | null {
  if (!isRecord(raw)) return null;

  const callsign = typeof raw["callsign"] === "string" ? raw["callsign"].trim() : "";
  if (!callsign) return null;

  const prediction = raw["prediction"];
  const linkQuality = isRecord(prediction) ? asFiniteNumber(prediction["link_quality"]) : null;

  const parsed = typeof raw["url"] === "string" ? parseRmsUrl(raw["url"]) : null;
  const tuningKhz = tuningFrequencyKhz(raw as Partial<RmsStation>);
  const bandwidth = parsed?.bandwidth ?? null;

  return {
    // Built from exactly the fields that make two rows behave differently when
    // called, so two rows that ARE the same call collapse to one id and no
    // pair that would dial differently can ever share one.
    id: `${callsign}|${tuningKhz ?? "?"}|${bandwidth ?? "-"}`,
    callsign,
    gridsquare: typeof raw["gridsquare"] === "string" ? raw["gridsquare"] : "",
    distanceKm: asFiniteNumber(raw["distance"]),
    bearingDeg: asFiniteNumber(raw["azimuth"]),
    modes: typeof raw["modes"] === "string" ? raw["modes"] : "",
    tuningKhz,
    linkQuality,
    // Stripped of freq here, once, so no caller can dial an unsanitised URL.
    dialUrl: parsed ? `ardop:///${parsed.target}${parsed.bandwidth ? `?bw=${parsed.bandwidth}` : ""}` : null,
    bandwidth,
  };
}

/** Every usable row from a listing, in Pat's own order. */
export function toStationRows(raw: unknown[]): StationRow[] {
  return raw.map(toStationRow).filter((row): row is StationRow => row !== null);
}

/**
 * Orders the list.
 *
 * Sorting is NOT filtering, and the difference matters here: a station with no
 * prediction sorts last, but it is still shown and still dialable. Link quality
 * is a model's opinion about the ionosphere, unavailable whenever the operator
 * is offline, and a station hidden because a forecast was pessimistic is a
 * station not called on the day it mattered. Same rule as 12k= and
 * addressWarnings(): shown, never used to refuse.
 */
export function sortStations(rows: readonly StationRow[], by: StationSort): StationRow[] {
  const sorted = [...rows];

  // A missing value always sorts last, whichever direction the key runs.
  const nullsLast = (a: number | null, b: number | null, compare: (x: number, y: number) => number): number => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return compare(a, b);
  };

  sorted.sort((a, b) => {
    switch (by) {
      case "quality": {
        // Higher is better, and Pat's own ByLinkQuality breaks ties on
        // distance -- worth matching, so two equally-forecast stations come out
        // nearest-first rather than in whatever order the server sent.
        const byQuality = nullsLast(a.linkQuality, b.linkQuality, (x, y) => y - x);
        if (byQuality !== 0) return byQuality;
        return nullsLast(a.distanceKm, b.distanceKm, (x, y) => x - y);
      }
      case "distance":
        return nullsLast(a.distanceKm, b.distanceKm, (x, y) => x - y);
      case "frequency":
        return nullsLast(a.tuningKhz, b.tuningKhz, (x, y) => x - y);
      case "callsign":
        return a.callsign.localeCompare(b.callsign);
    }
  });

  return sorted;
}

/** A compass point for a bearing, which is easier to act on than a number. */
export function compassPoint(bearingDeg: number | null): string | null {
  if (bearingDeg === null) return null;
  const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const index = Math.round(((bearingDeg % 360) + 360) % 360 / 22.5) % 16;
  return points[index] ?? null;
}

/** Distance for display. Null renders as a dash, never as "0 km". */
export function describeDistance(distanceKm: number | null): string {
  if (distanceKm === null) return "—";
  return distanceKm < 10 ? `${distanceKm.toFixed(1)} km` : `${Math.round(distanceKm)} km`;
}

/** Bearing for display, degrees plus a compass point. */
export function describeBearing(bearingDeg: number | null): string {
  const point = compassPoint(bearingDeg);
  if (bearingDeg === null || point === null) return "—";
  return `${Math.round(bearingDeg)}° ${point}`;
}

/**
 * Link quality in words.
 *
 * Deliberately coarse. The underlying number is a propagation model's estimate,
 * and rendering it as a precise figure would imply a confidence it does not
 * have. "No forecast" is an ordinary answer, not a warning.
 */
export function describeLinkQuality(linkQuality: number | null): string {
  if (linkQuality === null) return "No forecast";
  if (linkQuality >= 80) return "Very good";
  if (linkQuality >= 60) return "Good";
  if (linkQuality >= 40) return "Fair";
  if (linkQuality >= 20) return "Poor";
  return "Very poor";
}
