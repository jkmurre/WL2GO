// Asks the radio which serial port it is on, and what address it answers to.
//
// Two facts make this worth doing rather than making the operator guess. An
// IC-7300 MkII presents TWO USB serial nodes whose vendor, product and serial
// number are identical -- only the device path differs, and nothing in the
// metadata says which one carries CI-V. And the radio's address is a menu
// setting, so even knowing the model does not tell you what to send.
//
// The probe is a read: command 0x19 sub 0x00, "read transceiver ID". It cannot
// key a transmitter. See shared/civFrame.ts for the framing and its source.

import { SerialPort } from "serialport";
import {
  CIV_BROADCAST_ADDRESS,
  CIV_CONTROLLER_ADDRESS,
  buildReadIdFrame,
  formatCivAddress,
  parseCivFrames,
  radioAddressFromReply,
} from "../../shared/civFrame.ts";
import { PTT_PRESETS, presetForCivAddress } from "../../shared/pttPresets.ts";
import { listSerialPorts } from "./serialPortService.ts";

/**
 * 19200 first: it is both the IC-7300's factory CI-V rate and the rate ardopcf
 * assumes when no `:baud` suffix is given (ARDOPC.c:133,138), so the common
 * case is also the first one tried.
 */
export const PROBE_BAUD_RATES = [19200, 115200, 9600, 38400, 4800] as const;

/** How long to listen after a probe before calling it silence. */
const BROADCAST_READ_MS = 180;
/** Shorter in the sweep: 127 addresses at 180 ms each would be half a minute. */
const SWEEP_READ_MS = 35;

/**
 * The address sweep runs at the two rates Icom radios are actually found on.
 *
 * It only runs when the broadcast probe drew nothing at any rate, which is the
 * uncommon case -- a radio that ignores address 00. Sweeping all five rates
 * would quadruple a pass that is already the slow one.
 */
const SWEEP_BAUD_RATES = [19200, 9600] as const;

/**
 * The sweep covers 0x01-0xEF, NOT Hamlib's 0x01-0x7f.
 *
 * Hamlib's prober stops at 0x7f (icom.c:9955), which cannot find any radio this
 * project cares about: the IC-7300 is 0x94, the MkII 0xB6, the IC-705 0xA4 --
 * every one of them above its ceiling. 0x00 is the broadcast address and 0xE0
 * is ours, so both are skipped; 0xFE and 0xFD are the frame delimiters and can
 * never be addresses.
 */
const SWEEP_FIRST_ADDRESS = 0x01;
const SWEEP_LAST_ADDRESS = 0xef;

export interface RadioDetection {
  /** Callout path, ready to store in a profile. */
  port: string;
  baud: number;
  civAddress: number;
  /** The matching preset, or null for a radio on a non-default address. */
  presetId: string | null;
  /** One sentence naming what was found, fit to show as-is. */
  summary: string;
}

export interface DetectRadioResult {
  found: RadioDetection | null;
  /** Ports and speeds actually tried, so "nothing found" is actionable. */
  attempts: string[];
  message: string;
}

/** One opened port, narrowed to what the probe needs. Swapped out in tests. */
export interface ProbePort {
  write(data: Uint8Array): Promise<void>;
  /** Everything received within the window. Empty is an ordinary answer. */
  read(windowMs: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface DetectRadioOptions {
  listPorts?: () => Promise<Array<{ path: string; likelyRadioInterface: boolean }>>;
  openPort?: (path: string, baud: number) => Promise<ProbePort>;
  /** Progress for the slow sweep, so a long pass is not a frozen dialog. */
  onProgress?: (message: string) => void;
}

/**
 * Finds the radio, or says exactly what was tried.
 *
 * Two passes, because they cost very differently. The broadcast probe asks
 * address 00 once per port and speed and is over in about a second. Only if
 * that draws nothing does the sweep ask all 127 addresses -- Hamlib's own
 * approach (icom.c:9955-9963), kept as the fallback rather than the default.
 *
 * Never guesses. A radio that does not answer produces `found: null` and a list
 * of what was attempted; it does not produce a plausible-looking default.
 */
export async function detectRadio(options: DetectRadioOptions = {}): Promise<DetectRadioResult> {
  const listPorts = options.listPorts ?? (() => listSerialPorts());
  const openPort = options.openPort ?? openSerialProbePort;
  const attempts: string[] = [];

  const ports = (await listPorts()).map((p) => p.path);
  if (ports.length === 0) {
    return { found: null, attempts, message: "No serial ports were found. Is the radio plugged in and switched on?" };
  }

  for (const path of ports) {
    for (const baud of PROBE_BAUD_RATES) {
      attempts.push(`${path} at ${baud}`);
      options.onProgress?.(`Asking ${path} at ${baud}…`);
      const address = await probeOnce(openPort, path, baud, CIV_BROADCAST_ADDRESS, BROADCAST_READ_MS);
      if (address !== null) return { found: describe(path, baud, address), attempts, message: "" };
    }
  }

  // Known addresses before the exhaustive pass: five probes rather than 239,
  // and they cover every radio in the preset table.
  const known = PTT_PRESETS.map((preset) => preset.civAddress).filter((a): a is number => a !== null);

  for (const path of ports) {
    for (const baud of SWEEP_BAUD_RATES) {
      options.onProgress?.(`No answer to a general call — trying known addresses on ${path} at ${baud}…`);
      const address = await sweep(openPort, path, baud, known);
      if (address !== null) {
        attempts.push(`${path} at ${baud}, known addresses`);
        return { found: describe(path, baud, address), attempts, message: "" };
      }
    }
  }

  const everyAddress: number[] = [];
  for (let a = SWEEP_FIRST_ADDRESS; a <= SWEEP_LAST_ADDRESS; a += 1) {
    if (a !== CIV_CONTROLLER_ADDRESS) everyAddress.push(a);
  }

  for (const path of ports) {
    for (const baud of SWEEP_BAUD_RATES) {
      options.onProgress?.(`Still nothing — trying every address on ${path} at ${baud}…`);
      const address = await sweep(openPort, path, baud, everyAddress);
      if (address !== null) {
        attempts.push(`${path} at ${baud}, every address`);
        return { found: describe(path, baud, address), attempts, message: "" };
      }
    }
  }

  return {
    found: null,
    attempts,
    message:
      `No radio answered on ${ports.length} port${ports.length === 1 ? "" : "s"}. ` +
      `Check that it is switched on, that its CI-V connection is over USB rather than the CI-V jack, ` +
      `and that "CI-V USB Port" is set to "Link to [REMOTE]" if the radio offers that setting.`,
  };
}

/** One query on an already-chosen port, speed and address. */
async function probeOnce(
  openPort: NonNullable<DetectRadioOptions["openPort"]>,
  path: string,
  baud: number,
  address: number,
  windowMs: number,
): Promise<number | null> {
  let port: ProbePort | null = null;
  try {
    port = await openPort(path, baud);
    await port.write(buildReadIdFrame(address));
    const reply = await port.read(windowMs);
    return radioAddressFromReply(parseCivFrames(reply));
  } catch {
    // A port that will not open is an ordinary outcome here, not a failure of
    // the detection: it is usually one ardopcf or another program already
    // holds. Moving on is right; reporting it as an error would stop the search
    // at the first busy port.
    return null;
  } finally {
    await port?.close().catch(() => {});
  }
}

/**
 * Asks a list of addresses down one open port.
 *
 * Opening and closing per address would take longer than the probing does, and
 * on macOS repeatedly reopening a USB CDC node is its own source of flakiness.
 */
async function sweep(
  openPort: NonNullable<DetectRadioOptions["openPort"]>,
  path: string,
  baud: number,
  addresses: readonly number[],
): Promise<number | null> {
  let port: ProbePort | null = null;
  try {
    port = await openPort(path, baud);
    for (const address of addresses) {
      await port.write(buildReadIdFrame(address));
      const found = radioAddressFromReply(parseCivFrames(await port.read(SWEEP_READ_MS)));
      if (found !== null) return found;
    }
    return null;
  } catch {
    return null;
  } finally {
    await port?.close().catch(() => {});
  }
}

function describe(port: string, baud: number, civAddress: number): RadioDetection {
  const preset = presetForCivAddress(civAddress);
  const where = `on ${port} at ${baud} baud, CI-V address ${formatCivAddress(civAddress)}`;
  return {
    port,
    baud,
    civAddress,
    presetId: preset?.id ?? null,
    // A radio on a non-default address is found, not unrecognised: the keying
    // commands are built from the address that was read, so they are right
    // whether or not the model is in our table.
    summary: preset ? `Found an ${preset.label} ${where}.` : `Found an Icom radio ${where}.`,
  };
}

/** The real port. Everything above it is testable without hardware. */
export async function openSerialProbePort(path: string, baud: number): Promise<ProbePort> {
  const port = new SerialPort({ path, baudRate: baud, autoOpen: false });
  const buffered: Buffer[] = [];
  port.on("data", (chunk: Buffer) => buffered.push(chunk));
  // Swallowed rather than thrown: a disconnected radio raises this
  // asynchronously, and an unhandled 'error' on a Node stream is fatal to the
  // whole process. The probe reads it as silence, which is what it is.
  port.on("error", () => {});

  await new Promise<void>((resolve, reject) => {
    port.open((err) => (err ? reject(err) : resolve()));
  });

  return {
    write: (data) =>
      new Promise((resolve, reject) => {
        port.write(Buffer.from(data), (err) => (err ? reject(err) : resolve()));
      }),
    read: (windowMs) =>
      new Promise((resolve) => {
        setTimeout(() => resolve(Uint8Array.from(Buffer.concat(buffered.splice(0)))), windowMs);
      }),
    close: () =>
      new Promise((resolve) => {
        if (!port.isOpen) return resolve();
        port.close(() => resolve());
      }),
  };
}
