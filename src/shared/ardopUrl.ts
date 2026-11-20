// Builds the ardop:// URL handed to Pat's /api/connect.
//
// Pure, and separate from the connection manager, because one rule in it is
// load-bearing and completely invisible at the call site: whether the FREQUENCY
// is carried depends on whether the active profile has rig control.
//
// WHY, in Pat's own source. A `freq` parameter sends Connect() through a.qsy()
// (app/connect.go:147-154), which calls VFOForTransport -- and that reads
// config.Ardop.Rig and returns an error when it is empty (app/app.go:153-155).
// Connect then returns false BEFORE it dials, and ConnectHandler turns that
// into HTTP 500 "Session failure" (api/api.go:363-365), the same opaque error
// every other failure produces. So a frequency on a URL with no rig behind it
// does not fail gracefully; it fails the whole session naming nothing.
//
// With a rig configured, the opposite is true and this is the ONLY way the
// radio gets tuned: WL2GO points Pat at its own rigctld, and Pat's qsy() sets
// the dial frequency, waits three seconds for it to settle, and restores the
// previous frequency on a deferred call when the session ends
// (app/connect.go:236-247). The frequency is therefore Pat's to set and Pat's
// to put back -- WL2GO sets only the MODE. See main/rigctl/rigSession.ts.
//
// Pat's /api/rmslist hands back URLs that already carry one (app/rmslist.go:50-60,
// e.g. "ardop:///K0RMS?bw=2000MAX&freq=3585"), but they are never passed through:
// parseRmsUrl keeps only the callsign and the bandwidth, and the frequency is
// re-attached here from the row the operator actually chose.

/** The ARQ bandwidths ardopcf accepts, from wl2k-go transport/ardop/ardop.go:52-61. */
export const ARDOP_BANDWIDTHS = [
  "200MAX",
  "500MAX",
  "1000MAX",
  "2000MAX",
  "200FORCED",
  "500FORCED",
  "1000FORCED",
  "2000FORCED",
] as const;

export type ArdopBandwidth = (typeof ARDOP_BANDWIDTHS)[number];

export function isArdopBandwidth(value: string): value is ArdopBandwidth {
  return (ARDOP_BANDWIDTHS as readonly string[]).includes(value);
}

export interface ArdopUrlOptions {
  /** The RMS gateway callsign to call. */
  target: string;
  /** Omitted when absent, which lets the modem's own configured default stand. */
  bandwidth?: string | null;
  /**
   * The dial frequency in kHz, or null to leave the radio where it is.
   *
   * Ignored unless `rigConfigured` is also true -- see the file header. kHz as
   * a decimal string is exactly what Pat wants: SetFreq parses it with
   * ParseFloat and multiplies by 1e3 (app/freq.go:100-106), so "3583.5" is
   * both accepted and precise.
   */
  dialKhz?: number | null;
  /**
   * Whether the active profile has a Hamlib rig, i.e. whether Pat has a VFO to
   * tune. Passed in rather than inferred, because this module is pure.
   */
  rigConfigured?: boolean;
  /**
   * Winlink hybrid Radio-Only mode: the far station keeps the mail on the RF
   * network instead of forwarding it over the internet. Pat implements it by
   * appending "-T" to OUR callsign (app/connect.go:129-144) -- which is also
   * why it refuses a callsign with an SSID; the caller validates that before
   * anything transmits, because Pat's own refusal is a silent session failure.
   */
  radioOnly?: boolean;
}

/**
 * The URL for one ARDOP call.
 *
 * Shaped as `ardop:///TARGET?bw=...`: the empty host is deliberate and is the
 * form Pat's own rmslist produces. Pat fills the user in from mycall when the
 * URL carries none, so the callsign is its business rather than ours.
 */
export function buildArdopUrl(options: ArdopUrlOptions): string {
  const target = options.target.trim().toUpperCase();
  if (!target) throw new Error("An ARDOP call needs a station callsign.");

  const params = new URLSearchParams();

  const bandwidth = options.bandwidth?.trim();
  // An unrecognised bandwidth is dropped rather than passed on: Pat's
  // BandwidthFromString rejects it and fails the session, and the modem's
  // configured default is a better outcome than no session at all.
  if (bandwidth && isArdopBandwidth(bandwidth)) params.set("bw", bandwidth);

  // Dropped without a rig, deliberately and silently. See the file header: with
  // an empty ardop.rig this parameter does not merely fail to tune, it fails
  // the session before Pat dials, with an error that names nothing.
  if (options.rigConfigured && isDialFrequency(options.dialKhz)) {
    params.set("freq", formatDialKhz(options.dialKhz));
  }

  // Only ever set by the operator's own choice in the direct-call dialog.
  // parseRmsUrl still DROPS radio_only from downloaded lists, deliberately: a
  // list fetched over the internet has no business changing how our callsign
  // goes on the air.
  if (options.radioOnly) params.set("radio_only", "true");

  const query = params.toString();
  return query ? `ardop:///${encodeURIComponent(target)}?${query}` : `ardop:///${encodeURIComponent(target)}`;
}

function isDialFrequency(khz: number | null | undefined): khz is number {
  return typeof khz === "number" && Number.isFinite(khz) && khz > 0;
}

/**
 * kHz as Pat's SetFreq wants to read it.
 *
 * Trailing zeros are trimmed so a whole-kilohertz dial renders "3585" rather
 * than "3585.0" -- matching what Pat's own rmslist emits, which keeps the URL
 * in the log identical to the one an operator would expect to see. Both parse
 * identically (ParseFloat), so this is legibility, not correctness.
 */
function formatDialKhz(khz: number): string {
  return String(Number(khz.toFixed(3)));
}

/** The parts of an rmslist URL that are safe to act on. */
export interface ParsedRmsUrl {
  target: string;
  /** Null when the station advertised none, or one ardopcf would reject. */
  bandwidth: ArdopBandwidth | null;
}

/**
 * Reads Pat's rmslist URL into the two fields worth keeping.
 *
 * Returns the parts rather than only a string, because the BANDWIDTH has to
 * survive as data: the station browser needs to hand it to the dial, and a
 * caller that only ever saw the assembled URL would have to re-parse it -- or,
 * as happened once here, quietly drop it and dial every station at Pat's
 * configured default. A station advertising 2000MAX called at 500 negotiates
 * badly in a way that looks like poor propagation.
 *
 * Everything else is dropped, INCLUDING `freq`. The frequency is not taken
 * from the URL even now that WL2GO can tune: the station browser hands the
 * dial frequency of the row the operator actually chose, and re-reading it out
 * of the string here would mean a gateway listed on several frequencies could
 * be tuned to one and called on another. The rest goes because Pat's transport
 * layer reads several parameters (`radio_only`, `prehook`, `prehook-arg`) that
 * a list downloaded over the internet has no business setting on our behalf.
 */
export function parseRmsUrl(raw: string): ParsedRmsUrl | null {
  const match = /^ardop:\/\/\/?([^/?#]+)(\?.*)?$/i.exec(raw.trim());
  if (!match) return null;

  const target = decodeURIComponent(match[1] ?? "").trim().toUpperCase();
  if (!target) return null;

  const advertised = match[2] ? new URLSearchParams(match[2]).get("bw") : null;
  return {
    target,
    bandwidth: advertised && isArdopBandwidth(advertised) ? advertised : null,
  };
}

/** The same URL, rebuilt from only the parts above. */
export function sanitiseRmsUrl(raw: string): string | null {
  const parsed = parseRmsUrl(raw);
  return parsed ? buildArdopUrl(parsed) : null;
}

/**
 * A frequency as Pat serialises one.
 *
 * NOT a number. Pat's Frequency type has a custom MarshalJSON emitting an
 * object with hz, khz and a preformatted desc (app/freq.go:52-63), so reading
 * `record.dial` as a number yields NaN and interpolating it renders
 * "[object Object]" -- with no complaint from tsc, which is the failure mode
 * this project has already shipped once.
 */
export interface PatFrequency {
  hz: number;
  khz: number;
  /** Pat's own formatting, e.g. "3.585.00 MHz". */
  desc: string;
}

export function isPatFrequency(value: unknown): value is PatFrequency {
  return typeof value === "object" && value !== null && typeof (value as PatFrequency).hz === "number";
}

/**
 * What to tell the operator to tune the radio to, in kHz.
 *
 * Pat gives both `freq` (the centre) and `dial` (what the radio should read).
 * The dial frequency is the one that goes into a radio, so it wins; freq is the
 * fallback for a record that carries no dial.
 */
export function tuningFrequencyKhz(record: { freq?: unknown; dial?: unknown }): number | null {
  for (const candidate of [record.dial, record.freq]) {
    if (isPatFrequency(candidate) && candidate.hz > 0) return candidate.khz;
  }
  return null;
}

/** The tuning frequency as a short string, or null when the record has none. */
export function describeTuningFrequency(record: { freq?: unknown; dial?: unknown }): string | null {
  const khz = tuningFrequencyKhz(record);
  return khz === null ? null : `${khz.toFixed(1)} kHz`;
}
