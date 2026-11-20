// Winlink's hybrid network, as WL2GO presents it.
//
// Radio-Only is what keeps Winlink working when the internet does not: hybrid
// RMS gateways forward mail among themselves over RF, and hold the operator's
// incoming mail at their Message Pickup Stations. Everything here is a display
// or eligibility decision over data that came from the CMS while it was still
// reachable, so none of it may block a call outright except where Pat itself
// would refuse.

import type { HybridStation } from "./ipcContract.ts";

/** Winlink allows this many pickup stations per account (cli/mps.go). */
export const MAX_PICKUP_STATIONS = 3;

/** Winlink's advice; a third is allowed but discouraged. */
export const RECOMMENDED_PICKUP_STATIONS = 2;

const SSID = /-\d{1,2}$/;

/**
 * Why this callsign cannot connect Radio-Only, or null if it can.
 *
 * Pat refuses outright (app/connect.go:134-137): Radio-Only is signalled by
 * logging in as CALL-T, and a callsign already carrying an SSID has nowhere to
 * put the -T. Said before dialling, because Pat only says it in its log.
 */
export function radioOnlyProblem(mycall: string): string | null {
  if (!SSID.test(mycall.trim())) return null;
  return (
    `Radio-Only cannot be used with a callsign that has an SSID (${mycall.trim().toUpperCase()}). ` +
    "Winlink marks a Radio-Only session by adding -T to your callsign, so set your station callsign without one."
  );
}

function baseCall(callsign: string): string {
  return callsign.trim().toUpperCase().replace(SSID, "");
}

/**
 * Is this gateway on the hybrid list?
 *
 * Exact match first, then by base callsign: the RMS list and the hybrid list
 * are separate CMS datasets and do not promise to agree on SSIDs. A false
 * "Hybrid" badge costs one refused call; a missing one hides the station the
 * operator needed, which is why the looser match is the right side to err on.
 */
export function isHybridStation(callsign: string, hybrid: readonly HybridStation[]): boolean {
  const exact = callsign.trim().toUpperCase();
  const base = baseCall(callsign);
  return hybrid.some((station) => {
    const candidate = station.callsign.trim().toUpperCase();
    return candidate === exact || baseCall(candidate) === base;
  });
}

/** A note about how many pickup stations are set, or null when there is nothing to say. */
export function pickupLimitNote(count: number): string | null {
  if (count >= MAX_PICKUP_STATIONS) {
    return `Winlink allows at most ${MAX_PICKUP_STATIONS} pickup stations. Remove one to add another.`;
  }
  if (count === RECOMMENDED_PICKUP_STATIONS) {
    return `Winlink recommends ${RECOMMENDED_PICKUP_STATIONS} pickup stations. A third is allowed, but each one adds forwarding load on the network.`;
  }
  return null;
}
