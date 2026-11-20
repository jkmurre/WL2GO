// The persisted application config: who the operator is, and what radio setups
// they have. Deliberately pure -- no Electron, no filesystem -- so it can be
// unit tested outside Electron and reused by the renderer for form defaults.
//
// Every later module reads from this schema rather than inventing its own
// storage: Module 2 derives Pat's config.json from it, Module 8's wizard writes
// profiles into it, Modules 9-10 read the interface and rig settings out of it.
//
// NOTE: no password field exists anywhere in here. Secrets live in a separate
// store (see src/main/config/secretStore.ts), which means this type structurally
// cannot leak one to the renderer.

export const CONFIG_SCHEMA_VERSION = 6;

/** ardopcf's default TCP command port; the data port is always one higher. */
export const DEFAULT_ARDOP_HOST_PORT = 8515;

/**
 * Hamlib's rigctld default TCP port.
 *
 * Kept only so a schema 2 config that stored it still reads back the number the
 * operator saw. It is no longer a default for anything: a networked Icom is not
 * reached through rigctld -- see the three ports below.
 */
export const DEFAULT_LAN_PORT = 4532;

/**
 * Where WL2GO's own rigctld listens, and what Pat is pointed at.
 *
 * Hamlib's own default. Kept separate from DEFAULT_LAN_PORT above, which only
 * still exists to read back schema 2 values and is not a default for anything.
 */
export const DEFAULT_RIGCTLD_PORT = 4532;

/**
 * An Icom networked radio's three UDP ports, as an IC-7300 MkII ships them.
 *
 * They are not interchangeable: control carries the login handshake and the
 * session keepalive, CI-V carries rig commands (the network equivalent of the
 * CAT cable), and audio carries the codec stream in both directions. All three
 * are per-radio settings rather than constants -- the same model can be
 * reconfigured -- so these are starting values, not assumptions.
 */
export const DEFAULT_ICOM_CONTROL_PORT = 50001;
export const DEFAULT_ICOM_CIV_PORT = 50002;
export const DEFAULT_ICOM_AUDIO_PORT = 50003;

export interface StationIdentity {
  /** Always stored uppercased. Empty until onboarding collects it. */
  callsign: string;
  /** Maidenhead locator, e.g. "FN31pr". Optional. */
  gridSquare: string;
  /**
   * Whether WL2GO may tell api.winlink.org which client version is in use, and
   * check that the account has a password-recovery address.
   *
   * Default true, matching every other Winlink client. The operator can turn it
   * off: the recovery check transmits the Winlink password to verify it.
   */
  shareWithWinlink: boolean;
}

/** VARA and Packet are explicitly out of MVP scope, so ARDOP is the only mode. */
export type RadioProfileMode = "ardop";

/**
 * A saved audio device choice.
 *
 * Stored as ardopcf's own device NAME, not a Chromium mediaDevices ID -- the two
 * are different namespaces and only ardopcf's vocabulary can be handed back to
 * the modem. The name is also the only field that survives a replug: PortAudio
 * renumbers its device list whenever anything is plugged in or removed.
 *
 * The index is recorded anyway, as a tiebreak for the case where two devices
 * share a name (two identical USB dongles is an ordinary two-radio shack).
 * It is a heuristic, not an identifier -- see resolveAudioDevice.
 */
export interface AudioDeviceSelection {
  name: string;
  /** PortAudio index when the device was chosen. -1 when unknown. */
  index: number;
  /** PortAudio host API when chosen, e.g. "Core Audio". "" when unknown. */
  hostApi: string;
}

export interface UsbInterfaceConfig {
  /**
   * Serial device path, as returned by serial:listPorts.
   *
   * On macOS this is the callout node (/dev/cu.*), never the /dev/tty.* form
   * the OS enumerates: opening a tty node blocks until carrier detect asserts,
   * which for a radio's CAT port never happens. This string is handed straight
   * to rigctld and to ardopcf's CAT/PTT options.
   */
  serialPort: string | null;
  audioInput: AudioDeviceSelection | null;
  audioOutput: AudioDeviceSelection | null;
}

export interface LanInterfaceConfig {
  host: string;
  /** Icom's control port: the login handshake and session keepalive. */
  controlPort: number;
  /** Icom's CI-V port: rig commands, the network equivalent of the CAT cable. */
  civPort: number;
  /** Icom's audio port: the codec stream in both directions. */
  audioPort: number;
  username: string;
}

/**
 * A discriminated union rather than the `{ type, usb?, lan? }` shape sketched in
 * the handoff: same data on disk, but a USB profile carrying LAN fields is not
 * representable.
 */
export type RadioInterfaceConfig =
  | { type: "usb"; usb: UsbInterfaceConfig }
  | { type: "lan"; lan: LanInterfaceConfig };

/**
 * How the modem keys the transmitter.
 *
 * This is ardopcf's OWN PTT, not Hamlib rig control -- the two are orthogonal
 * and this one has to exist first, because without it Module 9 dials a station
 * and the radio never transmits unless it happens to be in VOX.
 *
 * The methods are exactly what our vendored ardopcf can do on macOS, no more:
 *
 * - "none"    -- the interface keys itself (VOX, or a hardware VOX box).
 * - "rts"     -- ardopcf asserts RTS on a serial port (`-p`).
 * - "cat"     -- ardopcf sends a hex command over a CAT port (`-c -k -u`).
 * - "rigctld" -- PAT keys the radio through Hamlib. WL2GO runs rigctld on the
 *                radio's CAT port, points Pat at it (`ardop.rig` +
 *                `ardop.ptt_ctrl`), and gives ardopcf NO PTT arguments at all --
 *                so ardopcf reports `PTT TRUE`/`PTT FALSE` to its host and Pat
 *                acts on them. This is the arrangement WSJT-X and Winlink
 *                Express both use: one process owns the CAT port for the whole
 *                session and does frequency, mode and keying through it.
 *
 *                It does NOT mean `-p host:port` any more. That set ardopcf's
 *                PTTMode = PTTHAMLIB, and `RadioPTT()` has no PTTHAMLIB branch
 *                -- in our vendored PaSound.c OR in upstream's ALSASound.c --
 *                so it keyed nothing at all.
 *
 * CM108/HID keying is deliberately absent. ardopcf only recognises a Linux
 * `hidraw` path (PaSound.c:459-476); a VID:PID on macOS falls through to the
 * IP-address branch and then to a serial open that cannot succeed. Offering it
 * would be offering a control that silently does nothing.
 */
export type PttMethod = "none" | "rts" | "cat" | "rigctld";

export interface PttConfig {
  method: PttMethod;
  /**
   * Serial device path for "rts" and "cat"; "host:port" for "rigctld"; null for
   * "none".
   *
   * When it is a serial path it is the callout node (/dev/cu.*) for the same
   * reason UsbInterfaceConfig.serialPort is -- ardopcf hands this straight to
   * its CATPort/PTTPort open, and a tty node blocks on carrier detect forever.
   */
  port: string | null;
  /**
   * Serial baud for "rts" and "cat".
   *
   * ardopcf's built-in default is 19200 (ARDOPC.c:133,138) and there is no flag
   * for it -- but it does read a `:baud` suffix off the port string
   * (PaSound.c:445-448), which is how this reaches it.
   */
  baud: number;
  /**
   * The key and unkey commands for "cat", as hex.
   *
   * Stored already normalised: uppercase, no separators. ardopcf's parser is
   * `val = c - 0x30; if (val > 15) val -= 7` (ARDOPCommon.c:259-270), which
   * understands neither lowercase nor spaces and silently produces garbage
   * bytes for both -- so normalisation is not cosmetic.
   */
  keyHex: string;
  unkeyHex: string;
}

/**
 * The transmit mode WL2GO puts the radio into before a call.
 *
 * "auto" means USB-DATA, which is correct for every HF Winlink ARDOP gateway:
 * the published dial frequency is an upper-sideband one on every band, and the
 * DATA variant is what routes the sound card -- rather than the microphone --
 * into the modulator. The explicit choices exist because this is a transmitter
 * setting and an operator working a band plan or a non-standard gateway has to
 * be able to overrule us.
 */
export type TxMode = "auto" | "usb" | "usb-data" | "lsb" | "lsb-data";

export const TX_MODES: readonly TxMode[] = ["auto", "usb", "usb-data", "lsb", "lsb-data"];

/**
 * Hamlib rig control for one profile, or null for none.
 *
 * `model` is a Hamlib rig-model number as `rigctld -l` prints it (an IC-7300
 * MkII is 3094). `device` is the CAT serial port -- the callout node, for the
 * same reason every other serial path here is. `port` is where WL2GO's own
 * rigctld listens; Pat is pointed at the same address.
 *
 * When this is set, rigctld owns the CAT port for as long as the profile is
 * active. That is why ptt.method must be "rigctld" whenever `device` is the
 * same port PTT would use -- see validateProfile.
 */
export interface HamlibConfig {
  model: number;
  device: string | null;
  baud: number;
  port: number;
}

export interface RadioProfile {
  id: string;
  name: string;
  mode: RadioProfileMode;
  ardop: { hostPort: number };
  /** Hamlib rig control, or null when WL2GO should not touch the VFO or mode. */
  hamlib: HamlibConfig | null;
  /** What to put the radio into before transmitting. See TxMode. */
  txMode: TxMode;
  /** How the modem keys the radio. Never null; "none" is a real choice. */
  ptt: PttConfig;
  /**
   * Transmit drive, 0-100, scaling the audio the modem generates.
   *
   * The control an operator reaches for when they are told they are splattering:
   * ardopcf multiplies every transmitted sample by this (Modulate.c:782), so
   * lowering it is how you keep the radio's ALC from acting on a digital signal
   * and distorting it. Per profile, because two radios need different levels.
   */
  driveLevel: number;
  /**
   * ardopcf's BUSYDET sensitivity, 0-10 (ARDOPC.c's own default is 5).
   *
   * Sent as `BUSYDET <n>` alongside DRIVELEVEL at modem start. Raises the
   * signal:baseline ratio the busy detector requires before it declares the
   * channel occupied -- lower is more sensitive. The scale is steep (the
   * threshold grows with n^4), so treat it as a coarse escape hatch for a
   * specific radio's noise floor, not a fine control.
   */
  busyDetLevel: number;
  interface: RadioInterfaceConfig;
}

/** App-level troubleshooting switches; nothing here affects the air. */
export interface DiagnosticsSettings {
  /**
   * Record what the modem hears and sends to WAV files in the log folder.
   * Off by default: roughly 24 kB per second of receive time, and nothing
   * ever prunes the files. See main/diagnostics/rxRecording.ts for the
   * developer overrides that sit above this.
   */
  recordRxAudio: boolean;
}

export interface AppConfig {
  schemaVersion: number;
  station: StationIdentity;
  profiles: RadioProfile[];
  activeProfileId: string | null;
  diagnostics: DiagnosticsSettings;
}

/** A profile as submitted from the UI; a missing id means "create me". */
export interface RadioProfileInput {
  id?: string;
  name: string;
  mode?: RadioProfileMode;
  ardop?: { hostPort?: number };
  hamlib?: HamlibConfig | null;
  txMode?: TxMode;
  ptt?: PttConfig;
  driveLevel?: number;
  busyDetLevel?: number;
  interface: RadioInterfaceConfig;
}

export function defaultConfig(): AppConfig {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    station: { callsign: "", gridSquare: "", shareWithWinlink: true },
    profiles: [],
    activeProfileId: null,
    diagnostics: defaultDiagnostics(),
  };
}

export function defaultDiagnostics(): DiagnosticsSettings {
  return { recordRxAudio: false };
}

export function defaultUsbInterface(): RadioInterfaceConfig {
  return { type: "usb", usb: { serialPort: null, audioInput: null, audioOutput: null } };
}

export function defaultLanInterface(): RadioInterfaceConfig {
  return {
    type: "lan",
    lan: {
      host: "",
      controlPort: DEFAULT_ICOM_CONTROL_PORT,
      civPort: DEFAULT_ICOM_CIV_PORT,
      audioPort: DEFAULT_ICOM_AUDIO_PORT,
      username: "",
    },
  };
}

/** No keying configured. A real choice -- many interfaces key on audio (VOX). */
export function defaultPtt(): PttConfig {
  return { method: "none", port: null, baud: DEFAULT_PTT_BAUD, keyHex: "", unkeyHex: "" };
}

/** ardopcf's own built-in default, and the only one it uses without a suffix. */
export const DEFAULT_PTT_BAUD = 19200;

/**
 * Full scale -- ardopcf's own default (ARDOPC.c:105), chosen deliberately.
 *
 * Migration must not change what a radio does. Picking a lower number here
 * would quietly halve the transmit level of every existing profile on the first
 * launch after an update, which is a surprise on the air even though it is a
 * safer one. New profiles walk past the tuning step instead.
 */
export const DEFAULT_DRIVE_LEVEL = 100;

export const MIN_DRIVE_LEVEL = 0;
export const MAX_DRIVE_LEVEL = 100;

/** Clamps and rounds a drive level; null for anything that is not a number. */
export function parseDriveLevel(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const rounded = Math.round(raw);
  if (rounded < MIN_DRIVE_LEVEL || rounded > MAX_DRIVE_LEVEL) return null;
  return rounded;
}

/** ardopcf's own built-in BUSYDET default (ARDOPC.c), chosen deliberately -- see RadioProfile.busyDetLevel. */
export const DEFAULT_BUSYDET_LEVEL = 5;

export const MIN_BUSYDET_LEVEL = 0;
export const MAX_BUSYDET_LEVEL = 10;

/** Clamps and rounds a busy-detector level; null for anything that is not a number. */
export function parseBusyDetLevel(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const rounded = Math.round(raw);
  if (rounded < MIN_BUSYDET_LEVEL || rounded > MAX_BUSYDET_LEVEL) return null;
  return rounded;
}

/**
 * An Icom CI-V PTT command pair, ready for ardopcf's -k and -u.
 *
 * Offered as a preset because an operator should not have to look up their
 * radio's CI-V address to make the transmitter key. 0x94 is the IC-7300's
 * default address and 0xB6 the IC-7300 MkII's (Hamlib rigs/icom/icom.c:679-680);
 * 1C 00 is the transceive PTT subcommand, with 01 keying and 00 unkeying.
 */
export function icomPttCommands(civAddress: number): { keyHex: string; unkeyHex: string } {
  const addr = civAddress.toString(16).toUpperCase().padStart(2, "0");
  return { keyHex: `FEFE${addr}E01C0001FD`, unkeyHex: `FEFE${addr}E01C0000FD` };
}

export const IC7300_CIV_ADDRESS = 0x94;
export const IC7300MK2_CIV_ADDRESS = 0xb6;

/**
 * Callsigns are 3-10 characters of letters, digits and slashes, containing at
 * least one digit -- deliberately permissive, because portable and special-event
 * calls vary far more than the common "1-2 letters, digit, 1-3 letters" shape
 * and rejecting a valid call is worse than accepting an odd one.
 */
const CALLSIGN_PATTERN = /^[A-Z0-9/]{3,10}$/;

export function isValidCallsign(value: string): boolean {
  return CALLSIGN_PATTERN.test(value) && /[0-9]/.test(value) && /[A-Z]/.test(value);
}

/** Maidenhead locator: 2 letters, 2 digits, and an optional 2-letter subsquare. */
const GRID_PATTERN = /^[A-R]{2}[0-9]{2}([A-X]{2})?$/i;

export function isValidGridSquare(value: string): boolean {
  return GRID_PATTERN.test(value);
}

export function normaliseCallsign(value: string): string {
  return value.trim().toUpperCase();
}

/** Grid squares are conventionally written with the subsquare in lower case. */
export function normaliseGridSquare(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return trimmed.toUpperCase();
  return trimmed.slice(0, 4).toUpperCase() + trimmed.slice(4).toLowerCase();
}

let idCounter = 0;

/**
 * Profile ids only need to be unique within one config file, so a timestamp plus
 * a counter is enough and stays readable in the JSON. The counter guards against
 * two profiles created inside the same millisecond.
 */
export function newProfileId(): string {
  idCounter += 1;
  return `p${Date.now().toString(36)}${idCounter.toString(36)}`;
}

// --- validation ------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asPort(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return value >= 1 && value <= 65535 ? value : fallback;
}

/** Baud is not a port: 115200 is ordinary and well past 65535. */
function asBaud(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return value >= 300 && value <= 921600 ? value : fallback;
}

/**
 * Normalises a hex command for ardopcf's -k/-u, or null if it is not one.
 *
 * ardopcf parses these as `val = c - 0x30; if (val > 15) val -= 7`
 * (ARDOPCommon.c:259-270). That understands uppercase hex and nothing else: a
 * lowercase digit or an embedded space does not fail, it produces a different
 * byte. So a mistyped keystring would reach the radio as a valid-looking command
 * that means something else -- or nothing -- with no error anywhere. Rejecting
 * here is the only place that can catch it.
 *
 * Common separators are accepted on input because that is how CI-V commands are
 * written down ("FE FE 94 E0 1C 00 01 FD"); they are stripped, never passed on.
 */
export function normaliseHexCommand(raw: string): string | null {
  const stripped = raw.replace(/0[xX]/g, "").replace(/[\s,:_-]/g, "").toUpperCase();
  if (!stripped) return null;
  if (stripped.length % 2 !== 0) return null;
  if (!/^[0-9A-F]+$/.test(stripped)) return null;
  return stripped;
}

/**
 * Reasons a profile cannot be saved. Returns an empty array when it is fine, so
 * callers read as `if (errors.length)`.
 */
export function validateProfile(input: RadioProfileInput): string[] {
  const errors: string[] = [];

  if (!input.name || !input.name.trim()) {
    errors.push("A profile needs a name.");
  }
  if (input.mode && input.mode !== "ardop") {
    errors.push(`Unsupported mode "${input.mode}". Only ARDOP is supported.`);
  }

  const hostPort = input.ardop?.hostPort;
  if (hostPort !== undefined && asPort(hostPort, -1) === -1) {
    errors.push("The ARDOP host port must be between 1 and 65535.");
  }

  if (input.interface.type === "lan") {
    const lan = input.interface.lan;
    if (!lan.host.trim()) errors.push("A LAN profile needs a host address.");
    // Each is named, because "the LAN port is wrong" would not say which of the
    // three to go and fix.
    const ports: ReadonlyArray<readonly [string, number]> = [
      ["control", lan.controlPort],
      ["CI-V", lan.civPort],
      ["audio", lan.audioPort],
    ];
    for (const [label, value] of ports) {
      if (asPort(value, -1) === -1) errors.push(`The LAN ${label} port must be between 1 and 65535.`);
    }
  }
  // A USB profile with nothing selected is allowed on purpose: an operator may
  // build a profile for a radio that is not plugged in yet.

  // PTT rules reject only a SELF-CONTRADICTORY configuration -- "key by CAT
  // command" with no command to send. Missing hardware is never an error here:
  // the profile for an unplugged radio stays saveable, same as above.
  errors.push(...validatePtt(input.ptt));

  // Only a value that is present and out of range is rejected. An absent one is
  // filled in by materialiseProfile, the same as every other optional field.
  if (input.driveLevel !== undefined && parseDriveLevel(input.driveLevel) === null) {
    errors.push(`The transmit drive level must be a whole number between ${MIN_DRIVE_LEVEL} and ${MAX_DRIVE_LEVEL}.`);
  }
  if (input.busyDetLevel !== undefined && parseBusyDetLevel(input.busyDetLevel) === null) {
    errors.push(`The busy detector level must be a whole number between ${MIN_BUSYDET_LEVEL} and ${MAX_BUSYDET_LEVEL}.`);
  }

  errors.push(...validateRigControl(input));

  return errors;
}

/**
 * The rules that stop rig control and keying from contradicting each other.
 *
 * Both failures they prevent are silent ones. A profile keying by "rigctld"
 * with no rig configured keys NOTHING -- Pat has no rig to act on ardopcf's
 * PTT notifications with. A profile keying by "cat" on the same serial port
 * rig control uses cannot open it, because rigctld already holds it, and
 * ardopcf reports that as an ordinary startup failure that reads like broken
 * hardware.
 *
 * The rule is deliberately about the PORT rather than about rig control being
 * present at all: a radio exposing two CAT nodes (the IC-7300 MkII does) may
 * legitimately give one to rigctld and the other to ardopcf.
 */
function validateRigControl(input: RadioProfileInput): string[] {
  const errors: string[] = [];
  const hamlib = parseHamlib(input.hamlib);
  const ptt = input.ptt;

  if (input.hamlib && !hamlib) {
    errors.push("Rig control needs a radio model. Pick one, or turn rig control off.");
  }
  if (hamlib && !hamlib.device) {
    errors.push("Rig control needs the radio's CAT serial port.");
  }
  if (ptt?.method === "rigctld" && !hamlib) {
    errors.push(
      "Keying through rig control needs rig control switched on, with a radio model and a CAT port.",
    );
  }
  if (hamlib?.device && ptt && ptt.method !== "rigctld" && ptt.port === hamlib.device) {
    errors.push(
      `Rig control and keying cannot both use ${hamlib.device}. ` +
        `Set keying to "Through rig control", or give keying a different port.`,
    );
  }

  return errors;
}

function validatePtt(ptt: PttConfig | undefined): string[] {
  if (!ptt || ptt.method === "none") return [];
  const errors: string[] = [];

  if (ptt.method === "rigctld") {
    // Nothing to check HERE any more. This used to demand a host:port, back
    // when it meant "pass -p host:port to ardopcf" -- which keyed nothing,
    // because RadioPTT() has no PTTHAMLIB branch. It now means "Pat keys
    // through the profile's rig", so what it needs is a rig, and
    // validateRigControl is where that lives.
    return errors;
  }

  if (!ptt.port || !ptt.port.trim()) {
    errors.push(
      ptt.method === "cat" ? "PTT by CAT command needs a serial port." : "PTT by serial RTS needs a serial port.",
    );
  }
  if (asBaud(ptt.baud, -1) === -1) {
    errors.push("The PTT serial speed must be between 300 and 921600 baud.");
  }
  if (ptt.method === "cat") {
    if (!normaliseHexCommand(ptt.keyHex)) {
      errors.push("The PTT key command must be an even number of hex digits.");
    }
    if (!normaliseHexCommand(ptt.unkeyHex)) {
      errors.push("The PTT unkey command must be an even number of hex digits.");
    }
  }

  return errors;
}

/** Fills in everything the UI left out, so the stored profile is always complete. */
/**
 * Fills in everything the UI left out, so the stored profile is always complete.
 *
 * `platform` is optional and only affects serial paths: supplied (by the store,
 * on the way to disk) it rewrites them to the callout node; omitted (by the
 * review step's preview, which runs in the renderer where `process` does not
 * exist) it leaves them alone. A preview has nothing to protect.
 */
export function materialiseProfile(input: RadioProfileInput, id: string, platform?: string): RadioProfile {
  return {
    id,
    name: input.name.trim(),
    mode: "ardop",
    ardop: { hostPort: asPort(input.ardop?.hostPort, DEFAULT_ARDOP_HOST_PORT) },
    hamlib: materialiseHamlib(input.hamlib, platform),
    txMode: parseTxMode(input.txMode),
    ptt: materialisePtt(input.ptt, platform),
    driveLevel: parseDriveLevel(input.driveLevel) ?? DEFAULT_DRIVE_LEVEL,
    busyDetLevel: parseBusyDetLevel(input.busyDetLevel) ?? DEFAULT_BUSYDET_LEVEL,
    interface: parseInterface(input.interface, platform),
  };
}

function materialiseHamlib(raw: HamlibConfig | null | undefined, platform?: string): HamlibConfig | null {
  const hamlib = parseHamlib(raw);
  if (!hamlib) return null;
  return {
    ...hamlib,
    // Same rule as ptt.port and usb.serialPort: rigctld gets this string as its
    // -r argument, and a /dev/tty.* node blocks on carrier detect for ever.
    device: hamlib.device && platform ? preferCalloutPath(hamlib.device, platform) : hamlib.device,
  };
}

function materialisePtt(raw: PttConfig | undefined, platform?: string): PttConfig {
  const ptt = parsePtt(raw);
  if (ptt.method === "rts" || ptt.method === "cat") {
    return {
      ...ptt,
      // Same reason as UsbInterfaceConfig.serialPort: this string is handed
      // straight to ardopcf's CATPort/PTTPort open, and a /dev/tty.* node blocks
      // until carrier detect -- which a radio's CAT port never asserts.
      port: ptt.port && platform ? preferCalloutPath(ptt.port, platform) : ptt.port,
    };
  }
  return ptt;
}

function parseInterface(raw: unknown, platform?: string): RadioInterfaceConfig {
  if (!isRecord(raw)) return defaultUsbInterface();

  if (raw["type"] === "lan") {
    const lan = isRecord(raw["lan"]) ? raw["lan"] : {};
    return {
      type: "lan",
      lan: {
        host: asString(lan["host"], "").trim(),
        // `port` is schema 2's single field, which was always the control port.
        // Accepted here as well as in migration, so a hand-edited file or a
        // restored backup that skipped migration keeps the operator's value --
        // the same allowance parseAudioSelection makes for a bare device name.
        controlPort: asPort(lan["controlPort"] ?? lan["port"], DEFAULT_ICOM_CONTROL_PORT),
        civPort: asPort(lan["civPort"], DEFAULT_ICOM_CIV_PORT),
        audioPort: asPort(lan["audioPort"], DEFAULT_ICOM_AUDIO_PORT),
        username: asString(lan["username"], "").trim(),
      },
    };
  }

  const usb = isRecord(raw["usb"]) ? raw["usb"] : {};
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  const serialPort = str(usb["serialPort"]);
  return {
    type: "usb",
    usb: {
      serialPort: serialPort && platform ? preferCalloutPath(serialPort, platform) : serialPort,
      audioInput: parseAudioSelection(usb["audioInput"]),
      audioOutput: parseAudioSelection(usb["audioOutput"]),
    },
  };
}

/**
 * Reads a stored PTT choice, defaulting anything absent.
 *
 * Never returns null: a profile written before schema 3, or hand-edited without
 * the field, means "nothing configured" -- which is defaultPtt(), not an error.
 */
function parsePtt(raw: unknown): PttConfig {
  if (!isRecord(raw)) return defaultPtt();

  const method = raw["method"];
  const valid: readonly PttMethod[] = ["none", "rts", "cat", "rigctld"];
  if (typeof method !== "string" || !valid.includes(method as PttMethod)) return defaultPtt();

  const port = raw["port"];
  return {
    method: method as PttMethod,
    port: typeof port === "string" && port.trim() ? port : null,
    baud: asBaud(raw["baud"], DEFAULT_PTT_BAUD),
    // Normalised on the way in as well as on the way out: a hand-edited
    // "fe fe 94 e0" must not reach ardopcf as the bytes that spells.
    keyHex: normaliseHexCommand(asString(raw["keyHex"], "")) ?? "",
    unkeyHex: normaliseHexCommand(asString(raw["unkeyHex"], "")) ?? "",
  };
}

/**
 * Reads a stored rig-control choice.
 *
 * Returns null -- meaning "WL2GO does not touch this radio" -- for anything
 * absent or unusable, INCLUDING a model of 0. Half-configured rig control is
 * the worst outcome available: Pat refuses to dial at all when `ardop.rig`
 * names a rig that failed to load (app/connect.go:315), so a profile that
 * claims a rig it cannot drive would break sessions that otherwise worked.
 */
function parseHamlib(raw: unknown): HamlibConfig | null {
  if (!isRecord(raw)) return null;

  const model = raw["model"];
  if (typeof model !== "number" || !Number.isInteger(model) || model <= 0) return null;

  const device = raw["device"];
  return {
    model,
    device: typeof device === "string" && device.trim() ? device : null,
    baud: asBaud(raw["baud"], DEFAULT_PTT_BAUD),
    port: asPort(raw["port"], DEFAULT_RIGCTLD_PORT),
  };
}

function parseTxMode(raw: unknown): TxMode {
  return typeof raw === "string" && (TX_MODES as readonly string[]).includes(raw) ? (raw as TxMode) : "auto";
}

/**
 * Reads a stored audio choice. Also accepts the bare string that schema 1 wrote,
 * so a config that skipped migration (a hand-edited file, a restored backup)
 * still loads with the operator's device intact rather than blank.
 */
function parseAudioSelection(raw: unknown): AudioDeviceSelection | null {
  if (typeof raw === "string") {
    return raw.trim() ? { name: raw, index: -1, hostApi: "" } : null;
  }
  if (!isRecord(raw)) return null;
  const name = asString(raw["name"], "");
  if (!name.trim()) return null;
  const index = raw["index"];
  return {
    name,
    index: typeof index === "number" && Number.isInteger(index) ? index : -1,
    hostApi: asString(raw["hostApi"], ""),
  };
}

function parseProfile(raw: unknown, index: number): RadioProfile | null {
  if (!isRecord(raw)) return null;
  const name = asString(raw["name"], "").trim();
  if (!name) return null;

  return {
    id: asString(raw["id"], "") || `p-recovered-${index}`,
    name,
    mode: "ardop",
    ardop: {
      hostPort: asPort(isRecord(raw["ardop"]) ? raw["ardop"]["hostPort"] : undefined, DEFAULT_ARDOP_HOST_PORT),
    },
    hamlib: parseHamlib(raw["hamlib"]),
    txMode: parseTxMode(raw["txMode"]),
    ptt: parsePtt(raw["ptt"]),
    driveLevel: parseDriveLevel(raw["driveLevel"]) ?? DEFAULT_DRIVE_LEVEL,
    busyDetLevel: parseBusyDetLevel(raw["busyDetLevel"]) ?? DEFAULT_BUSYDET_LEVEL,
    interface: parseInterface(raw["interface"]),
  };
}

export interface ParsedConfig {
  config: AppConfig;
  /** Everything that had to be repaired, for the log and the System Check row. */
  warnings: string[];
}

/**
 * Turns whatever was on disk into a usable config.
 *
 * This never throws. A corrupt or hand-edited config.json must not stop the app
 * from launching -- an operator who cannot start the app also cannot fix it from
 * inside the app. Anything unusable is replaced with a default and reported.
 */
export function parseConfig(raw: unknown): ParsedConfig {
  const warnings: string[] = [];
  const config = defaultConfig();

  if (!isRecord(raw)) {
    if (raw !== undefined && raw !== null) {
      warnings.push("The config file did not contain a JSON object; defaults were used.");
    }
    return { config, warnings };
  }

  const version = raw["schemaVersion"];
  if (typeof version === "number" && version > CONFIG_SCHEMA_VERSION) {
    // Refuse to reinterpret a newer file's fields under older rules; the caller
    // backs it up rather than overwriting whatever the newer build wrote.
    warnings.push(
      `The config file was written by a newer version of WL2GO (schema ${version}, this build understands ${CONFIG_SCHEMA_VERSION}).`,
    );
    return { config: { ...config, schemaVersion: version }, warnings };
  }
  if (version !== undefined && typeof version !== "number") {
    warnings.push("The config file had an invalid schemaVersion.");
  }

  const station = isRecord(raw["station"]) ? raw["station"] : {};
  const callsign = normaliseCallsign(asString(station["callsign"], ""));
  if (callsign && !isValidCallsign(callsign)) {
    warnings.push(`The stored callsign "${callsign}" is not a valid callsign; it was cleared.`);
  } else {
    config.station.callsign = callsign;
  }

  // Absent means "not chosen yet", which defaults to on rather than off.
  config.station.shareWithWinlink = station["shareWithWinlink"] !== false;

  const grid = normaliseGridSquare(asString(station["gridSquare"], ""));
  if (grid && !isValidGridSquare(grid)) {
    warnings.push(`The stored grid square "${grid}" is not a valid locator; it was cleared.`);
  } else {
    config.station.gridSquare = grid;
  }

  const rawProfiles = raw["profiles"];
  if (rawProfiles !== undefined && !Array.isArray(rawProfiles)) {
    warnings.push("The config file's profiles were not a list; they were discarded.");
  } else if (Array.isArray(rawProfiles)) {
    const seen = new Set<string>();
    rawProfiles.forEach((entry, index) => {
      const profile = parseProfile(entry, index);
      if (!profile) {
        warnings.push(`Radio profile ${index + 1} was unreadable and has been dropped.`);
        return;
      }
      if (seen.has(profile.id)) {
        warnings.push(`Radio profile "${profile.name}" had a duplicate id and was given a new one.`);
        profile.id = newProfileId();
      }
      seen.add(profile.id);
      config.profiles.push(profile);
    });
  }

  const active = raw["activeProfileId"];
  if (typeof active === "string" && config.profiles.some((p) => p.id === active)) {
    config.activeProfileId = active;
  } else if (typeof active === "string" && active) {
    warnings.push("The active radio profile no longer exists; no profile is active.");
  }

  // Anything but an explicit true means off: recording costs disk for as long
  // as nobody notices it, so a missing or mangled value must fail quiet.
  const diagnostics = isRecord(raw["diagnostics"]) ? raw["diagnostics"] : {};
  config.diagnostics.recordRxAudio = diagnostics["recordRxAudio"] === true;

  return { config, warnings };
}

/**
 * Rewrites a macOS serial path to its callout node.
 *
 * Every /dev/tty.X on macOS has a matching /dev/cu.X for the same driver, and
 * the callout node is the one to use: opening the tty node blocks waiting for
 * carrier detect, which a radio's CAT port never asserts. serialport enumerates
 * the tty form, so the rewrite happens on the way in and on migration.
 *
 * Pure, and platform is a parameter, so the darwin behaviour is testable from
 * any host.
 */
export function preferCalloutPath(path: string, platform: string): string {
  if (platform !== "darwin") return path;
  return path.startsWith("/dev/tty.") ? `/dev/cu.${path.slice("/dev/tty.".length)}` : path;
}

/**
 * Schema migration dispatch.
 *
 * Version 2 changed two things in a USB interface; version 3 adds PTT to every
 * profile and splits a LAN profile's single port into Icom's three. All of it
 * migrates rather than resets: an operator who has a working profile should not
 * have to rebuild it because we improved how it is stored.
 *
 * The cases CHAIN rather than each jumping to the current version -- a schema 1
 * file goes 1 -> 2 -> 3, so migrateV2ToV3 does not have to know anything about
 * what schema 1 looked like.
 */
// platform is required rather than defaulted to process.platform: this module
// is imported by the renderer, where `process` does not exist, and the whole
// point of keeping it pure is that it can be tested outside Electron.
export function migrate(raw: unknown, platform: string): unknown {
  if (!isRecord(raw)) return raw;

  const version = typeof raw["schemaVersion"] === "number" ? raw["schemaVersion"] : 0;
  switch (version) {
    case 0:
      // Pre-versioning files never shipped, but treating a missing version as
      // "current shape" is the right guess: parseConfig repairs the rest.
      return { ...raw, schemaVersion: CONFIG_SCHEMA_VERSION };
    case 1: {
      const v2 = migrateV1ToV2(raw, platform);
      const v3 = isRecord(v2) ? migrateV2ToV3(v2) : v2;
      const v4 = isRecord(v3) ? migrateV3ToV4(v3) : v3;
      const v5 = isRecord(v4) ? migrateV4ToV5(v4) : v4;
      return isRecord(v5) ? migrateV5ToV6(v5) : v5;
    }
    case 2: {
      const v3 = migrateV2ToV3(raw);
      const v4 = isRecord(v3) ? migrateV3ToV4(v3) : v3;
      const v5 = isRecord(v4) ? migrateV4ToV5(v4) : v4;
      return isRecord(v5) ? migrateV5ToV6(v5) : v5;
    }
    case 3: {
      const v4 = migrateV3ToV4(raw);
      const v5 = isRecord(v4) ? migrateV4ToV5(v4) : v4;
      return isRecord(v5) ? migrateV5ToV6(v5) : v5;
    }
    case 4: {
      const v5 = migrateV4ToV5(raw);
      return isRecord(v5) ? migrateV5ToV6(v5) : v5;
    }
    case 5:
      return migrateV5ToV6(raw);
    case CONFIG_SCHEMA_VERSION:
      return raw;
    default:
      // Newer than us. Pass through untouched; parseConfig refuses to reinterpret it.
      return raw;
  }
}

function migrateV1ToV2(raw: Record<string, unknown>, platform: string): unknown {
  const profiles = raw["profiles"];

  // Anything that is not a list is left exactly as found. Replacing it with []
  // here would repair the file silently and rob parseConfig of the chance to
  // tell the operator their profiles were unreadable.
  if (!Array.isArray(profiles)) return { ...raw, schemaVersion: 2 };

  return {
    ...raw,
    schemaVersion: 2,
    profiles: profiles.map((entry) => {
      if (!isRecord(entry)) return entry;
      const iface = entry["interface"];
      if (!isRecord(iface) || iface["type"] === "lan" || !isRecord(iface["usb"])) return entry;

      const usb = iface["usb"];
      const serialPort = usb["serialPort"];

      return {
        ...entry,
        interface: {
          ...iface,
          usb: {
            ...usb,
            // Without this the saved port stops matching anything the list
            // offers, so a plugged-in radio reads as "not connected" -- and
            // Module 10 would be handed the tty path this exists to avoid.
            serialPort: typeof serialPort === "string" ? preferCalloutPath(serialPort, platform) : serialPort,
            // A bare name is all schema 1 stored. There is no index or host API
            // to recover, and -1 says so honestly rather than guessing 0.
            audioInput: liftAudioName(usb["audioInput"]),
            audioOutput: liftAudioName(usb["audioOutput"]),
          },
        },
      };
    }),
  };
}

function liftAudioName(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  return raw.trim() ? { name: raw, index: -1, hostApi: "" } : null;
}

/**
 * Adds PTT to every profile, and splits a LAN profile's single port into three.
 *
 * Takes no platform: nothing here is a serial path. `ptt` is being created, not
 * carried over, so there is no stored /dev/tty.* to rewrite -- materialisePtt
 * and parsePtt cover the paths that can actually contain one.
 */
function migrateV2ToV3(raw: Record<string, unknown>): unknown {
  const profiles = raw["profiles"];

  // Left exactly as found, for the same reason migrateV1ToV2 does it: repairing
  // it here would rob parseConfig of the chance to tell the operator that their
  // profiles were unreadable.
  if (!Array.isArray(profiles)) return { ...raw, schemaVersion: 3 };

  return {
    ...raw,
    schemaVersion: 3,
    profiles: profiles.map((entry) => {
      if (!isRecord(entry)) return entry;

      const migrated: Record<string, unknown> = {
        ...entry,
        // An existing ptt (a file written by a newer build and moved aside, or a
        // hand-edit) wins over the default -- migration must not discard it.
        ptt: entry["ptt"] ?? defaultPtt(),
      };

      const iface = entry["interface"];
      if (!isRecord(iface) || iface["type"] !== "lan") return migrated;

      const lan = isRecord(iface["lan"]) ? iface["lan"] : {};
      const legacyPort = lan["port"];
      // The superseded key is dropped rather than left alongside the three that
      // replace it: a stale `port` in the file is a trap for the next person to
      // hand-edit it, and parseInterface would ignore it anyway.
      const { port: _dropped, ...rest } = lan;
      void _dropped;
      migrated["interface"] = {
        ...iface,
        lan: {
          ...rest,
          // Schema 2's single port was the control port. Keeping what the
          // operator typed matters more than landing on Icom's default: they
          // may have moved it precisely because the default was taken.
          controlPort: typeof legacyPort === "number" ? legacyPort : DEFAULT_ICOM_CONTROL_PORT,
          civPort: DEFAULT_ICOM_CIV_PORT,
          audioPort: DEFAULT_ICOM_AUDIO_PORT,
        },
      };
      return migrated;
    }),
  };
}

/**
 * Adds the transmit drive level.
 *
 * Every existing profile gets 100, which is ardopcf's own default -- so the
 * radio behaves on the first launch after the update exactly as it did before
 * it. A quieter default would be safer on the air but would change what the
 * transmitter does without asking, and a migration that does that is a
 * migration nobody can trust.
 */
function migrateV3ToV4(raw: Record<string, unknown>): unknown {
  const profiles = raw["profiles"];

  // Left exactly as found, as in every migration before this one: repairing it
  // here would rob parseConfig of the chance to say the profiles were
  // unreadable.
  if (!Array.isArray(profiles)) return { ...raw, schemaVersion: 4 };

  return {
    ...raw,
    schemaVersion: 4,
    profiles: profiles.map((entry) => {
      if (!isRecord(entry)) return entry;
      return {
        ...entry,
        // A value already present -- from a newer build, or a hand-edit -- wins.
        driveLevel: parseDriveLevel(entry["driveLevel"]) ?? DEFAULT_DRIVE_LEVEL,
      };
    }),
  };
}

/**
 * Version 5 adds rig control: `hamlib` (which was a hard-coded null) and
 * `txMode`.
 *
 * Both default to "WL2GO does not touch the radio", which is exactly what every
 * pre-v5 profile did. So this migration changes no behaviour for an existing
 * profile -- it only makes the new fields present and typed, so the editor has
 * something to bind to and the operator opts in deliberately.
 */
function migrateV4ToV5(raw: Record<string, unknown>): unknown {
  const profiles = raw["profiles"];

  // Left exactly as found, as in every migration before this one.
  if (!Array.isArray(profiles)) return { ...raw, schemaVersion: 5 };

  return {
    ...raw,
    schemaVersion: 5,
    profiles: profiles.map((entry) => {
      if (!isRecord(entry)) return entry;
      return {
        ...entry,
        // A value already present -- from a newer build, or a hand-edit -- wins.
        hamlib: parseHamlib(entry["hamlib"]),
        txMode: parseTxMode(entry["txMode"]),
      };
    }),
  };
}

/**
 * Adds the app-level diagnostics section, with audio recording OFF.
 *
 * Deliberately off for existing configs too: before schema 6 the recording
 * was always on (an opt-out env var), which was the debugging posture of a
 * project still chasing audio bugs. The operator asked for quiet-by-default
 * once those were resolved, with the switch one click away in Settings.
 */
function migrateV5ToV6(raw: Record<string, unknown>): unknown {
  return {
    ...raw,
    schemaVersion: 6,
    // A value already present -- from a newer build, or a hand-edit -- wins.
    diagnostics: isRecord(raw["diagnostics"]) ? raw["diagnostics"] : defaultDiagnostics(),
  };
}

/**
 * What a LAN profile is still missing before it could hold a session.
 *
 * Separate from validateProfile on purpose, and the distinction is the whole
 * design: a MALFORMED value (a port outside 1-65535) blocks saving, because it
 * cannot mean anything. An INCOMPLETE profile saves perfectly well -- exactly
 * as a USB profile for a radio that has not arrived yet does -- it simply
 * cannot be dialled. Conflating the two would either refuse to save a
 * half-finished profile or attempt a connection on partial information.
 *
 * Returns an empty array when nothing is missing.
 */
export function lanReadinessIssues(lan: LanInterfaceConfig): string[] {
  const missing: string[] = [];
  if (!lan.host.trim()) missing.push("the radio's address");

  const ports: ReadonlyArray<readonly [string, number]> = [
    ["control", lan.controlPort],
    ["CI-V", lan.civPort],
    ["audio", lan.audioPort],
  ];
  for (const [label, value] of ports) {
    if (asPort(value, -1) === -1) missing.push(`the ${label} port`);
  }

  if (!lan.username.trim()) missing.push("the username");
  return missing;
}

/** True when the file on disk was written by a build newer than this one. */
export function isFromFuture(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const version = raw["schemaVersion"];
  return typeof version === "number" && version > CONFIG_SCHEMA_VERSION;
}
