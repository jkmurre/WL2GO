import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { PatApiError } from "../pat/patApiClient.ts";
import { HybridNetworkService, type HybridNetworkClient } from "./hybridNetworkService.ts";

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function cachePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wl2go-hybrid-"));
  dirs.push(dir);
  return path.join(dir, "winlink-network.json");
}

const offline = () => new PatApiError("/api/wl2go/mps", 503, '{"error":"dial tcp: no route to host","kind":"network"}');

/** An in-memory CMS, with hooks to make any call fail. */
function fakeCms(initial: string[] = []) {
  const state = {
    table: [...initial],
    hybrid: [{ callsign: "W1AW-10", automaticForwarding: true, manualForwarding: false }] as unknown[],
    calls: [] as string[],
    failGet: null as (() => Error) | null,
    failAdd: null as ((callsign: string) => Error | null) | null,
  };
  const list = () => state.table.map((callsign) => ({ callsign, addedAt: "2026-10-01T00:00:00Z" }));
  const client: HybridNetworkClient = {
    async getHybridStations() {
      state.calls.push("hybrid");
      if (state.failGet) throw state.failGet();
      return state.hybrid;
    },
    async getPickupStations() {
      state.calls.push("get");
      if (state.failGet) throw state.failGet();
      return list();
    },
    async addPickupStation(callsign: string) {
      state.calls.push(`add ${callsign}`);
      const failure = state.failAdd?.(callsign);
      if (failure) throw failure;
      state.table.push(callsign);
      return list();
    },
    async clearPickupStations() {
      state.calls.push("clear");
      state.table = [];
    },
  };
  return { state, client };
}

function service(
  client: HybridNetworkClient | null,
  overrides: { file?: string; callsign?: string; password?: boolean; now?: () => Date } = {},
) {
  return new HybridNetworkService({
    cachePath: overrides.file ?? cachePath(),
    getClient: () => client,
    getCallsign: () => overrides.callsign ?? "n1call",
    hasPassword: () => overrides.password ?? true,
    now: overrides.now ?? (() => new Date("2026-10-28T12:00:00Z")),
  });
}

describe("HybridNetworkService reads", () => {
  it("fetches the hybrid list, keeps it on disk and serves it from there while fresh", async () => {
    const file = cachePath();
    const { state, client } = fakeCms();

    const first = await service(client, { file }).hybridStations();
    assert.deepEqual(first.stations.map((s) => s.callsign), ["W1AW-10"]);
    assert.equal(first.fetchedAt, "2026-10-28T12:00:00.000Z");
    assert.equal(first.error, null);

    // A fresh service on the same file: no second fetch inside a day.
    const second = await service(client, { file, now: () => new Date("2026-10-29T06:00:00Z") }).hybridStations();
    assert.deepEqual(second.stations, first.stations);
    assert.deepEqual(state.calls, ["hybrid"]);
  });

  it("refetches once a day has passed, or when asked to", async () => {
    const file = cachePath();
    const { state, client } = fakeCms();
    await service(client, { file }).hybridStations();
    await service(client, { file, now: () => new Date("2026-10-29T13:00:00Z") }).hybridStations();
    await service(client, { file }).hybridStations({ refresh: true });
    assert.deepEqual(state.calls, ["hybrid", "hybrid", "hybrid"]);
  });

  it("serves the last copy with a reason when Winlink cannot be reached", async () => {
    const file = cachePath();
    const { state, client } = fakeCms(["W1AW-10"]);
    await service(client, { file }).pickupStations();

    state.failGet = offline;
    const view = await service(client, { file }).pickupStations({ refresh: true });
    assert.deepEqual(view.stations.map((s) => s.callsign), ["W1AW-10"]);
    assert.equal(view.fetchedAt, "2026-10-28T12:00:00.000Z");
    assert.match(view.error ?? "", /could not be reached.*last list/);
  });

  it("says when there has never been a list, rather than claiming there are no stations", async () => {
    const { state, client } = fakeCms();
    state.failGet = offline;
    const view = await service(client).hybridStations();
    assert.deepEqual(view.stations, []);
    assert.equal(view.fetchedAt, null);
    assert.ok(view.error);
  });

  it("keeps pickup stations apart per callsign", async () => {
    const file = cachePath();
    const { client } = fakeCms(["W1AW-10"]);
    await service(client, { file, callsign: "N1CALL" }).pickupStations();

    const other = await service(null, { file, callsign: "N0CALL" }).pickupStations();
    assert.deepEqual(other.stations, []);
    assert.equal(other.fetchedAt, null);
  });

  it("survives a corrupt cache file", async () => {
    const file = cachePath();
    writeFileSync(file, '{"hybrid":{"stations":"nope"},"pickup":[]');
    const view = await service(null, { file }).hybridStations();
    assert.deepEqual(view.stations, []);
    assert.match(view.error ?? "", /not running/);
  });

  it("names a Pat that predates the hybrid routes", async () => {
    const { state, client } = fakeCms();
    state.failGet = () => new PatApiError("/api/wl2go/hybrid_stations", 404, "404 page not found");
    const view = await service(client).hybridStations();
    assert.match(view.error ?? "", /does not support the hybrid network/);
  });
});

describe("HybridNetworkService changes", () => {
  it("adds and stores the list Pat answers with", async () => {
    const file = cachePath();
    const { client } = fakeCms();
    const view = await service(client, { file }).addPickupStation("W1AW-10");
    assert.deepEqual(view.stations.map((s) => s.callsign), ["W1AW-10"]);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { pickup: Record<string, unknown> };
    assert.ok(onDisk.pickup["N1CALL"]);
  });

  it("refuses to try without a password, and says where to set one", async () => {
    const { state, client } = fakeCms();
    await assert.rejects(service(client, { password: false }).addPickupStation("W1AW-10"), /Winlink password/);
    assert.deepEqual(state.calls, []);
  });

  it("says a change needs the internet when offline", async () => {
    const { state, client } = fakeCms();
    state.failAdd = offline;
    await assert.rejects(service(client).addPickupStation("W1AW-10"), /needs the internet/);
  });

  it("passes Winlink's own refusal through", async () => {
    const { state, client } = fakeCms();
    state.failAdd = () => new PatApiError("/api/wl2go/mps", 502, '{"error":"Invalid password","kind":"cms"}');
    await assert.rejects(service(client).addPickupStation("W1AW-10"), /Winlink refused: Invalid password/);
  });

  it("removes one by clearing and re-adding the others", async () => {
    const { state, client } = fakeCms(["AAA1", "BBB2", "CCC3"]);
    const view = await service(client).removePickupStation("bbb2");
    assert.deepEqual(view.stations.map((s) => s.callsign), ["AAA1", "CCC3"]);
    assert.deepEqual(state.calls, ["get", "clear", "add AAA1", "add CCC3"]);
  });

  it("does nothing when asked to remove a station that is not set", async () => {
    const { state, client } = fakeCms(["AAA1"]);
    await service(client).removePickupStation("ZZZ9");
    assert.deepEqual(state.calls, ["get"]);
  });

  it("names what is really set when a re-add fails part way", async () => {
    const { state, client } = fakeCms(["AAA1", "BBB2", "CCC3"]);
    state.failAdd = (callsign) => (callsign === "CCC3" ? offline() : null);
    await assert.rejects(
      service(client).removePickupStation("BBB2"),
      /BBB2 was removed, but CCC3 could not be added back.*now: AAA1\./s,
    );
  });

  it("clears", async () => {
    const { state, client } = fakeCms(["AAA1"]);
    const view = await service(client).clearPickupStations();
    assert.deepEqual(view.stations, []);
    assert.deepEqual(state.table, []);
  });
});
