// The hybrid network, as far as the CMS can tell us about it.
//
// Two lists come from Winlink over the internet -- which gateways are hybrid
// stations, and which of them hold this operator's mail -- and both matter most
// exactly when the internet is gone. So every answer is kept on disk, every
// read falls back to the last copy with a reason attached, and every change
// says plainly that it needs the internet.
//
// No Electron import: this runs under `node --test`. moduleBoundary.test.ts
// enforces it.

import { readFileSync } from "node:fs";
import type {
  HybridNetworkView,
  HybridStation,
  PickupStation,
  PickupStationsView,
} from "../../shared/ipcContract.ts";
import { writeFileAtomicSync } from "../util/atomicWrite.ts";
import { PatApiError, type PatApiClient } from "../pat/patApiClient.ts";

/** Older than this, a read tries the CMS first. Both lists change rarely. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type HybridNetworkClient = Pick<
  PatApiClient,
  "getHybridStations" | "getPickupStations" | "addPickupStation" | "clearPickupStations"
>;

export interface HybridNetworkServiceOptions {
  /** Where the last answers are kept. Inside userData. */
  cachePath: string;
  getClient: () => HybridNetworkClient | null;
  getCallsign: () => string;
  hasPassword: () => boolean;
  now?: () => Date;
}

interface CachedList<T> {
  stations: T[];
  fetchedAt: string;
}

interface CacheFile {
  hybrid?: CachedList<HybridStation>;
  /** Keyed by the operator's callsign, so switching identity never shows another's list. */
  pickup?: Record<string, CachedList<PickupStation>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toHybridStations(list: unknown[]): HybridStation[] {
  return list.flatMap((entry): HybridStation[] => {
    if (!isRecord(entry) || typeof entry["callsign"] !== "string" || !entry["callsign"]) return [];
    return [
      {
        callsign: entry["callsign"].toUpperCase(),
        automaticForwarding: entry["automaticForwarding"] === true,
        manualForwarding: entry["manualForwarding"] === true,
      },
    ];
  });
}

function toPickupStations(list: unknown[]): PickupStation[] {
  return list.flatMap((entry): PickupStation[] => {
    if (!isRecord(entry) || typeof entry["callsign"] !== "string" || !entry["callsign"]) return [];
    const addedAt = typeof entry["addedAt"] === "string" ? entry["addedAt"] : "";
    return [{ callsign: entry["callsign"].toUpperCase(), addedAt }];
  });
}

function cachedList<T>(value: unknown, map: (list: unknown[]) => T[]): CachedList<T> | undefined {
  if (!isRecord(value) || !Array.isArray(value["stations"]) || typeof value["fetchedAt"] !== "string") return undefined;
  return { stations: map(value["stations"]), fetchedAt: value["fetchedAt"] };
}

/** Re-validates the file entry by entry: it is ours, but disks and older versions are not. */
function sanitise(parsed: unknown): CacheFile {
  if (!isRecord(parsed)) return {};
  const file: CacheFile = {};
  const hybrid = cachedList(parsed["hybrid"], toHybridStations);
  if (hybrid) file.hybrid = hybrid;
  if (isRecord(parsed["pickup"])) {
    const pickup: Record<string, CachedList<PickupStation>> = {};
    for (const [callsign, value] of Object.entries(parsed["pickup"])) {
      const list = cachedList(value, toPickupStations);
      if (list) pickup[callsign] = list;
    }
    file.pickup = pickup;
  }
  return file;
}

/** What kind of failure this was, from patch 0003's JSON error body. */
function failureKind(err: unknown): { kind: "network" | "cms" | "request" | "missing" | "other"; message: string } {
  if (err instanceof PatApiError) {
    // A Pat binary built before patch 0003 has no such route.
    if (err.status === 404) return { kind: "missing", message: err.body };
    try {
      const parsed: unknown = JSON.parse(err.body);
      if (isRecord(parsed) && typeof parsed["error"] === "string") {
        const kind = parsed["kind"];
        if (kind === "network" || kind === "cms" || kind === "request") return { kind, message: parsed["error"] };
      }
    } catch {
      // Not ours; fall through.
    }
    return { kind: "other", message: err.body || err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  // The client's own deadline: the CMS did not answer in time, which in the
  // field almost always means there is no internet.
  if (/timed out/.test(message)) return { kind: "network", message };
  return { kind: "other", message };
}

/** A sentence fit to show the operator, for a read or for a change. */
function describe(err: unknown, action: "read" | "change"): string {
  const { kind, message } = failureKind(err);
  switch (kind) {
    case "network":
      return action === "change"
        ? "Changing pickup stations needs the internet, and Winlink could not be reached. Set them up before you need them."
        : "Winlink could not be reached, so this is the last list seen.";
    case "missing":
      return "This copy of WL2GO's protocol engine does not support the hybrid network. Reinstall WL2GO.";
    case "request":
      return /password/i.test(message)
        ? "Store your Winlink password in Settings first. Winlink needs it to change your pickup stations."
        : message;
    case "cms":
      return `Winlink refused: ${message}`;
    default:
      return message;
  }
}

export class HybridNetworkService {
  private readonly opts: HybridNetworkServiceOptions;
  private cache: CacheFile | null = null;

  constructor(opts: HybridNetworkServiceOptions) {
    this.opts = opts;
  }

  /** The hybrid gateways. Never throws: the station browser must always render. */
  async hybridStations(options: { refresh?: boolean } = {}): Promise<HybridNetworkView> {
    const cached = this.load().hybrid ?? null;
    if (!options.refresh && cached && !this.isStale(cached)) {
      return { stations: cached.stations, fetchedAt: cached.fetchedAt, error: null };
    }

    const client = this.opts.getClient();
    if (!client) return this.hybridView(cached, "The protocol engine is not running.");
    try {
      const stations = toHybridStations(await client.getHybridStations());
      const fresh = { stations, fetchedAt: this.nowIso() };
      this.save({ ...this.load(), hybrid: fresh });
      return this.hybridView(fresh, null);
    } catch (err) {
      return this.hybridView(cached, describe(err, "read"));
    }
  }

  /** This operator's pickup stations. Never throws, on the same terms. */
  async pickupStations(options: { refresh?: boolean } = {}): Promise<PickupStationsView> {
    const callsign = this.callsign();
    if (!callsign) return this.pickupView(null, "Set your callsign in Settings first.");

    const cached = this.load().pickup?.[callsign] ?? null;
    if (!options.refresh && cached && !this.isStale(cached)) return this.pickupView(cached, null);

    const client = this.opts.getClient();
    if (!client) return this.pickupView(cached, "The protocol engine is not running.");
    try {
      return this.pickupView(this.storePickup(callsign, await client.getPickupStations()), null);
    } catch (err) {
      return this.pickupView(cached, describe(err, "read"));
    }
  }

  /** Adds one. Rejects with a message fit to show. */
  async addPickupStation(target: string): Promise<PickupStationsView> {
    const { client, callsign } = this.forChange();
    try {
      return this.pickupView(this.storePickup(callsign, await client.addPickupStation(target)), null);
    } catch (err) {
      throw new Error(describe(err, "change"));
    }
  }

  async clearPickupStations(): Promise<PickupStationsView> {
    const { client, callsign } = this.forChange();
    try {
      await client.clearPickupStations();
    } catch (err) {
      throw new Error(describe(err, "change"));
    }
    return this.pickupView(this.storePickup(callsign, []), null);
  }

  /**
   * Removes one, by clearing and re-adding the rest.
   *
   * The CMS has no single-entry delete. Read fresh rather than from the cache,
   * because re-adding from a stale copy would resurrect a station removed
   * elsewhere. If a re-add fails part way, the list is read back and the error
   * names what is actually set: an operator who believes they have two pickup
   * stations and has none finds out when their mail does not arrive.
   */
  async removePickupStation(target: string): Promise<PickupStationsView> {
    const { client, callsign } = this.forChange();
    const wanted = target.trim().toUpperCase();

    let current: PickupStation[];
    try {
      current = toPickupStations(await client.getPickupStations());
    } catch (err) {
      throw new Error(describe(err, "change"));
    }
    if (!current.some((station) => station.callsign === wanted)) {
      return this.pickupView(this.storePickup(callsign, current), null);
    }

    const keep = current.filter((station) => station.callsign !== wanted).map((station) => station.callsign);
    try {
      await client.clearPickupStations();
    } catch (err) {
      throw new Error(describe(err, "change"));
    }

    let latest: unknown[] = [];
    for (const station of keep) {
      try {
        latest = await client.addPickupStation(station);
      } catch (err) {
        let now: PickupStation[] | null = null;
        try {
          now = this.storePickup(callsign, await client.getPickupStations()).stations;
        } catch {
          // Could not even read it back; say so rather than guess.
        }
        const state =
          now === null
            ? "Your pickup stations could not be read back, so check them before relying on Radio-Only."
            : now.length
              ? `Your pickup stations are now: ${now.map((s) => s.callsign).join(", ")}.`
              : "You now have no pickup stations set.";
        throw new Error(`${wanted} was removed, but ${station} could not be added back: ${describe(err, "change")} ${state}`);
      }
    }
    return this.pickupView(this.storePickup(callsign, latest), null);
  }

  private forChange(): { client: HybridNetworkClient; callsign: string } {
    const callsign = this.callsign();
    if (!callsign) throw new Error("Set your callsign in Settings first.");
    if (!this.opts.hasPassword()) {
      throw new Error("Store your Winlink password in Settings first. Winlink needs it to change your pickup stations.");
    }
    const client = this.opts.getClient();
    if (!client) throw new Error("The protocol engine is not running.");
    return { client, callsign };
  }

  private storePickup(callsign: string, raw: unknown[]): CachedList<PickupStation> {
    const fresh = { stations: toPickupStations(raw), fetchedAt: this.nowIso() };
    const file = this.load();
    this.save({ ...file, pickup: { ...file.pickup, [callsign]: fresh } });
    return fresh;
  }

  private hybridView(list: CachedList<HybridStation> | null, error: string | null): HybridNetworkView {
    return { stations: list?.stations ?? [], fetchedAt: list?.fetchedAt ?? null, error };
  }

  private pickupView(list: CachedList<PickupStation> | null, error: string | null): PickupStationsView {
    return {
      stations: list?.stations ?? [],
      fetchedAt: list?.fetchedAt ?? null,
      error,
      passwordStored: this.opts.hasPassword(),
    };
  }

  private callsign(): string {
    return this.opts.getCallsign().trim().toUpperCase();
  }

  private isStale(list: CachedList<unknown>): boolean {
    const at = new Date(list.fetchedAt).getTime();
    return !Number.isFinite(at) || this.now().getTime() - at > STALE_AFTER_MS;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  /** A missing or unreadable file is an empty cache: it only ever held copies. */
  private load(): CacheFile {
    if (this.cache) return this.cache;
    try {
      this.cache = sanitise(JSON.parse(readFileSync(this.opts.cachePath, "utf8")));
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private save(file: CacheFile): void {
    this.cache = file;
    writeFileAtomicSync(this.opts.cachePath, JSON.stringify(file, null, 2));
  }
}
