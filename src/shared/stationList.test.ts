import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compassPoint,
  describeBearing,
  describeDistance,
  describeLinkQuality,
  sortStations,
  toStationRow,
  toStationRows,
  type StationRow,
} from "./stationList.ts";

const freq = (hz: number) => ({ hz, khz: hz / 1000, desc: `${hz} Hz` });

function patRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    callsign: "K0RMS",
    gridsquare: "EM48",
    distance: 412.5,
    azimuth: 271.2,
    modes: "ARDOP 2000",
    freq: freq(3585000),
    dial: freq(3583500),
    url: "ardop:///K0RMS?bw=2000MAX&freq=3585",
    prediction: { link_quality: 72 },
    ...over,
  };
}

function row(over: Partial<StationRow> = {}): StationRow {
  return {
    id: "K0RMS|3583.5|-",
    callsign: "K0RMS",
    gridsquare: "EM48",
    distanceKm: 400,
    bearingDeg: 270,
    modes: "ARDOP 2000",
    tuningKhz: 3583.5,
    linkQuality: 50,
    dialUrl: "ardop:///K0RMS",
    bandwidth: null,
    ...over,
  };
}

describe("toStationRow", () => {
  it("gives each frequency of one station its own row id", () => {
    // Regression. Selection was tracked by callsign, so clicking one of a
    // gateway's frequencies highlighted all of them AND resolved the call to
    // whichever row came first -- picking 7101 could dial 3585 at the wrong
    // bandwidth. The id has to separate rows that dial differently.
    const a = toStationRow(patRecord());
    const b = toStationRow(
      patRecord({ dial: freq(7101000), freq: freq(7102500), url: "ardop:///K0RMS?bw=500MAX" }),
    );
    assert.notEqual(a?.id, b?.id);
    assert.equal(a?.callsign, b?.callsign);
  });

  it("gives two records that would dial identically the same id", () => {
    // The other half of the rule: an id that varied on something the dial does
    // not use would make one station look like two.
    assert.equal(toStationRow(patRecord())?.id, toStationRow(patRecord({ distance: 999 }))?.id);
  });

  it("reads Pat's frequency objects rather than treating them as numbers", () => {
    // freq and dial are {hz, khz, desc}, not numbers (app/freq.go:52-63).
    assert.equal(toStationRow(patRecord())?.tuningKhz, 3583.5);
  });

  it("keeps the advertised bandwidth as DATA, not only inside the URL", () => {
    // The caller has to hand this to the dial. When it lived only in the URL
    // string it was parsed, tested, and then silently dropped at the call site
    // -- so every station was called at Pat's configured default, and a station
    // advertising 2000MAX negotiated at 500 in a way that looks like poor
    // propagation rather than a bug.
    assert.equal(toStationRow(patRecord())?.bandwidth, "2000MAX");
    assert.equal(toStationRow(patRecord({ url: "ardop:///K0RMS" }))?.bandwidth, null);
  });

  it("drops a bandwidth ardopcf would reject rather than passing it on", () => {
    // Pat's BandwidthFromString refuses anything not in its list and fails the
    // whole session; the modem's own default is the better outcome.
    const parsed = toStationRow(patRecord({ url: "ardop:///K0RMS?bw=1500MAX" }));
    assert.equal(parsed?.bandwidth, null);
    assert.equal(parsed?.dialUrl, "ardop:///K0RMS");
  });

  it("strips the frequency from the dial URL", () => {
    // The rule from ardopUrl.ts, enforced here so no caller can dial a raw
    // rmslist URL: a freq parameter fails the whole session before dialling.
    const dialUrl = toStationRow(patRecord())?.dialUrl;
    assert.equal(dialUrl, "ardop:///K0RMS?bw=2000MAX");
    assert.doesNotMatch(String(dialUrl), /freq/);
  });

  it("treats a null distance as unknown, not as zero", () => {
    // JSONFloat64 marshals NaN as null, which is what Pat sends when the
    // operator has set no grid square. A station rendered as "0 km away" would
    // be a lie, and would sort to the top.
    const parsed = toStationRow(patRecord({ distance: null, azimuth: null }));
    assert.equal(parsed?.distanceKm, null);
    assert.equal(parsed?.bearingDeg, null);
  });

  it("treats a missing prediction as an ordinary state", () => {
    // prediction is nullable in Pat's own struct. Offline is the normal way to
    // get here, and it must not read as an error.
    assert.equal(toStationRow(patRecord({ prediction: null }))?.linkQuality, null);
    assert.equal(toStationRow(patRecord({ prediction: undefined }))?.linkQuality, null);
  });

  it("drops a record with no callsign rather than rendering half of it", () => {
    assert.equal(toStationRow(patRecord({ callsign: "" })), null);
    assert.equal(toStationRow(patRecord({ callsign: undefined })), null);
    assert.equal(toStationRow("nonsense"), null);
    assert.equal(toStationRow(null), null);
  });

  it("keeps a station whose URL cannot be dialled, but marks it so", () => {
    // Worth showing: the operator may still want to see that the station is
    // there and on what frequency. It just cannot be clicked.
    const parsed = toStationRow(patRecord({ url: "varafm:///K0RMS" }));
    assert.equal(parsed?.callsign, "K0RMS");
    assert.equal(parsed?.dialUrl, null);
  });

  it("skips unusable records in a listing without discarding the rest", () => {
    const rows = toStationRows([patRecord(), "junk", patRecord({ callsign: "W1AW" }), null]);
    assert.deepEqual(rows.map((r) => r.callsign), ["K0RMS", "W1AW"]);
  });
});

describe("sortStations", () => {
  it("puts the best forecast first, breaking ties on distance like Pat does", () => {
    const rows = [
      row({ callsign: "A", linkQuality: 50, distanceKm: 900 }),
      row({ callsign: "B", linkQuality: 90, distanceKm: 500 }),
      row({ callsign: "C", linkQuality: 50, distanceKm: 100 }),
    ];
    assert.deepEqual(sortStations(rows, "quality").map((r) => r.callsign), ["B", "C", "A"]);
  });

  it("SHOWS a station with no forecast, sorted last but never removed", () => {
    // The rule that matters most here. A station hidden because a propagation
    // model was pessimistic -- or absent, which is every offline session -- is a
    // station not called on the day it mattered.
    const rows = [row({ callsign: "A", linkQuality: null }), row({ callsign: "B", linkQuality: 10 })];
    const sorted = sortStations(rows, "quality");
    assert.equal(sorted.length, 2);
    assert.deepEqual(sorted.map((r) => r.callsign), ["B", "A"]);
  });

  it("sorts unknown distances last too, rather than treating them as nearest", () => {
    const rows = [row({ callsign: "A", distanceKm: null }), row({ callsign: "B", distanceKm: 700 })];
    assert.deepEqual(sortStations(rows, "distance").map((r) => r.callsign), ["B", "A"]);
  });

  it("never drops or duplicates a station, whatever the sort", () => {
    const rows = [
      row({ callsign: "A", linkQuality: null, distanceKm: null, tuningKhz: null }),
      row({ callsign: "B" }),
      row({ callsign: "C", linkQuality: 99 }),
    ];
    for (const by of ["quality", "distance", "callsign", "frequency"] as const) {
      const sorted = sortStations(rows, by);
      assert.equal(sorted.length, rows.length, by);
      assert.deepEqual([...sorted.map((r) => r.callsign)].sort(), ["A", "B", "C"], by);
    }
  });

  it("does not mutate the list it was given", () => {
    const rows = [row({ callsign: "B" }), row({ callsign: "A" })];
    sortStations(rows, "callsign");
    assert.deepEqual(rows.map((r) => r.callsign), ["B", "A"]);
  });
});

describe("display helpers", () => {
  it("turns a bearing into a compass point an operator can point an antenna at", () => {
    assert.equal(compassPoint(0), "N");
    assert.equal(compassPoint(90), "E");
    assert.equal(compassPoint(180), "S");
    assert.equal(compassPoint(270), "W");
    assert.equal(compassPoint(359), "N");
    assert.equal(compassPoint(null), null);
  });

  it("renders an unknown distance or bearing as a dash, never as a number", () => {
    assert.equal(describeDistance(null), "—");
    assert.equal(describeBearing(null), "—");
    assert.doesNotMatch(describeDistance(null), /0|NaN|null/);
  });

  it("keeps a short distance readable", () => {
    assert.equal(describeDistance(4.25), "4.3 km");
    assert.equal(describeDistance(412.5), "413 km");
  });

  it("describes link quality coarsely, because it is an estimate", () => {
    assert.equal(describeLinkQuality(95), "Very good");
    assert.equal(describeLinkQuality(50), "Fair");
    assert.equal(describeLinkQuality(0), "Very poor");
  });

  it("says 'No forecast' rather than treating a missing one as bad", () => {
    // A station with no prediction is not a poor station; it is an unknown one.
    assert.equal(describeLinkQuality(null), "No forecast");
  });
});
