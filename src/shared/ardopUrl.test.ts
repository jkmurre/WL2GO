import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildArdopUrl,
  describeTuningFrequency,
  isArdopBandwidth,
  sanitiseRmsUrl,
  tuningFrequencyKhz,
} from "./ardopUrl.ts";

describe("buildArdopUrl", () => {
  it("builds the form Pat's own rmslist produces", () => {
    assert.equal(buildArdopUrl({ target: "K0RMS" }), "ardop:///K0RMS");
    assert.equal(buildArdopUrl({ target: "K0RMS", bandwidth: "2000MAX" }), "ardop:///K0RMS?bw=2000MAX");
  });

  it("uppercases and trims the callsign", () => {
    assert.equal(buildArdopUrl({ target: "  k0rms  " }), "ardop:///K0RMS");
  });

  it("refuses to build a call to nobody", () => {
    assert.throws(() => buildArdopUrl({ target: "   " }), /needs a station callsign/);
  });

  it("drops an unrecognised bandwidth rather than failing the session with it", () => {
    // Pat's BandwidthFromString rejects anything not in its list and the whole
    // connect fails. The modem's configured default is a better outcome than
    // no session at all.
    assert.equal(buildArdopUrl({ target: "K0RMS", bandwidth: "1500MAX" }), "ardop:///K0RMS");
    assert.equal(buildArdopUrl({ target: "K0RMS", bandwidth: "" }), "ardop:///K0RMS");
    assert.equal(buildArdopUrl({ target: "K0RMS", bandwidth: null }), "ardop:///K0RMS");
  });

  it("carries radio_only only when the operator chose it", () => {
    // Pat reads radio_only from the URL and appends -T to OUR callsign for a
    // Winlink hybrid radio-only session; the flag is set only by the
    // direct-call dialog, never by a downloaded list (see sanitiseRmsUrl).
    assert.equal(buildArdopUrl({ target: "K0RMS", radioOnly: true }), "ardop:///K0RMS?radio_only=true");
    assert.equal(buildArdopUrl({ target: "K0RMS", radioOnly: false }), "ardop:///K0RMS");
    assert.equal(buildArdopUrl({ target: "K0RMS" }), "ardop:///K0RMS");
  });

  it("accepts every bandwidth ardopcf does, and nothing else", () => {
    for (const bw of ["200MAX", "500MAX", "1000MAX", "2000MAX", "2000FORCED"]) {
      assert.equal(isArdopBandwidth(bw), true, bw);
      assert.match(buildArdopUrl({ target: "K0RMS", bandwidth: bw }), new RegExp(`bw=${bw}$`));
    }
    assert.equal(isArdopBandwidth("3000MAX"), false);
    assert.equal(isArdopBandwidth("2000"), false);
  });
});

describe("buildArdopUrl / frequency", () => {
  it("carries the dial frequency when a rig is configured", () => {
    // This is the whole of "the radio tunes itself": Pat's qsy() reads it,
    // sets the VFO and restores it afterwards (app/connect.go:236-247).
    assert.equal(
      buildArdopUrl({ target: "K0RMS", bandwidth: "2000MAX", dialKhz: 3583.5, rigConfigured: true }),
      "ardop:///K0RMS?bw=2000MAX&freq=3583.5",
    );
  });

  it("drops the frequency when there is no rig, because it would fail the session", () => {
    // Not merely useless without a rig: VFOForTransport errors on an empty
    // ardop.rig, Connect returns false BEFORE dialling, and the operator gets
    // "Session failure" naming nothing (app/app.go:153-155).
    assert.equal(
      buildArdopUrl({ target: "K0RMS", bandwidth: "2000MAX", dialKhz: 3583.5, rigConfigured: false }),
      "ardop:///K0RMS?bw=2000MAX",
    );
    assert.equal(buildArdopUrl({ target: "K0RMS", dialKhz: 3583.5 }), "ardop:///K0RMS");
  });

  it("writes kHz the way Pat parses it", () => {
    // SetFreq does ParseFloat then *1e3 (app/freq.go:100-106), so a decimal is
    // fine and precise; whole kilohertz is trimmed to match Pat's own rmslist.
    assert.match(buildArdopUrl({ target: "K0RMS", dialKhz: 3585, rigConfigured: true }), /freq=3585$/);
    assert.match(buildArdopUrl({ target: "K0RMS", dialKhz: 7582.5, rigConfigured: true }), /freq=7582\.5$/);
  });

  it("omits a frequency that is missing or not a frequency", () => {
    for (const bad of [null, undefined, 0, -1, Number.NaN]) {
      assert.equal(
        buildArdopUrl({ target: "K0RMS", dialKhz: bad as number | null, rigConfigured: true }),
        "ardop:///K0RMS",
        String(bad),
      );
    }
  });

  it("still leaves the bandwidth alone", () => {
    assert.equal(
      buildArdopUrl({ target: "K0RMS", bandwidth: "500MAX", rigConfigured: true }),
      "ardop:///K0RMS?bw=500MAX",
    );
  });
});

describe("sanitiseRmsUrl", () => {
  it("STRIPS THE FREQUENCY, which is the whole reason this exists", () => {
    // A freq parameter routes Pat's Connect() through a.qsy(), which fails on
    // an empty config.Ardop.Rig (app/app.go:153-155) and returns false BEFORE
    // dialling -- surfacing as HTTP 500 "Session failure", the same opaque
    // error as everything else. Rig control is not configured yet, so every
    // rmslist URL would fail this way.
    assert.equal(sanitiseRmsUrl("ardop:///K0RMS?bw=2000MAX&freq=3585"), "ardop:///K0RMS?bw=2000MAX");
    assert.equal(sanitiseRmsUrl("ardop:///T3ST?freq=7582.5"), "ardop:///T3ST");
  });

  it("keeps the bandwidth, which is the one parameter worth carrying", () => {
    assert.equal(sanitiseRmsUrl("ardop:///N3TST-10?bw=1000MAX&freq=3586.5"), "ardop:///N3TST-10?bw=1000MAX");
  });

  it("drops parameters a station list has no business setting for us", () => {
    // Pat's transport layer reads radio_only, prehook and prehook-arg. A
    // downloaded list must not be able to run a script or rewrite the callsign.
    const url = sanitiseRmsUrl("ardop:///K0RMS?bw=500MAX&radio_only=true&prehook=evil.sh&prehook-arg=x");
    assert.equal(url, "ardop:///K0RMS?bw=500MAX");
  });

  it("handles the real shapes from Pat's own rmslist tests", () => {
    assert.equal(sanitiseRmsUrl("ardop:///K0RMS?bw=2000MAX&freq=3585"), "ardop:///K0RMS?bw=2000MAX");
    assert.equal(sanitiseRmsUrl("ardop:///F1TST?bw=500MAX&freq=3582.5"), "ardop:///F1TST?bw=500MAX");
  });

  it("returns null for anything that is not an ardop URL", () => {
    // The station list is fetched over the internet. A record whose URL is a
    // different transport, or nonsense, must not be dialled.
    for (const raw of ["", "telnet://cms", "varafm:///K0RMS", "ardop:///", "not a url"]) {
      assert.equal(sanitiseRmsUrl(raw), null, raw);
    }
  });
});

describe("tuningFrequencyKhz", () => {
  const freq = (hz: number) => ({ hz, khz: hz / 1000, desc: "whatever" });

  it("reads Pat's frequency OBJECT rather than treating it as a number", () => {
    // Pat's Frequency has a custom MarshalJSON emitting {hz, khz, desc}
    // (app/freq.go:52-63). Reading it as a number gives NaN and interpolating
    // it renders "[object Object]", neither of which tsc would catch.
    assert.equal(tuningFrequencyKhz({ dial: freq(3583500), freq: freq(3585000) }), 3583.5);
  });

  it("prefers the dial frequency, which is what goes into a radio", () => {
    assert.equal(tuningFrequencyKhz({ dial: freq(7047400), freq: freq(7048900) }), 7047.4);
  });

  it("falls back to the centre frequency when there is no dial", () => {
    assert.equal(tuningFrequencyKhz({ freq: freq(14105000) }), 14105);
  });

  it("treats a missing or malformed frequency as absent, not as zero", () => {
    // A radio tuned to 0 kHz is not a sensible instruction.
    assert.equal(tuningFrequencyKhz({}), null);
    assert.equal(tuningFrequencyKhz({ dial: null, freq: null }), null);
    assert.equal(tuningFrequencyKhz({ dial: 3585 }), null);
    assert.equal(tuningFrequencyKhz({ dial: freq(0) }), null);
  });

  it("formats without ever rendering an object", () => {
    assert.equal(describeTuningFrequency({ dial: freq(3583500) }), "3583.5 kHz");
    assert.equal(describeTuningFrequency({}), null);
    assert.doesNotMatch(String(describeTuningFrequency({ dial: freq(3583500) })), /object Object/);
  });
});
