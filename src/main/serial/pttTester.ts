// Keys the radio once, briefly, so an operator can find out whether their
// keying configuration actually works.
//
// WL2GO drives the serial port itself here rather than asking the modem,
// because ardopcf cannot do it: RADIOPTTON and RADIOPTTOFF sound like commands
// that key and unkey, but they only DEFINE the command strings
// (HostInterface.c:1291-1330, which parse hex into PTTOnCmd and return "CAT PTT
// On Command Defined"). ardopcf has no "key now" at all -- the only way to make
// it transmit is to make it send something.
//
// Doing it here is better anyway. It needs no audio device, so no microphone
// prompt and no fight over the sound card; it exercises exactly the bytes
// stored in the profile; and it works for RTS keying as well as CAT, which a
// modem-driven test could not.

import { SerialPort } from "serialport";
import { normaliseHexCommand, type PttConfig } from "../../shared/configSchema.ts";

/** How long the radio stays keyed. Long enough to see, short enough to be safe. */
export const KEY_DURATION_MS = 800;

/**
 * The unkey happens no later than this after keying, whatever else goes wrong.
 *
 * The independent backstop for the one operation in WL2GO that keys a
 * transmitter with no session around it. Leaving a radio keyed is the failure
 * this project's stated differentiator is about, so the release does not depend
 * on the happy path, on a finally block, or on the caller.
 */
const WATCHDOG_MS = 3_000;

export interface PttTestResult {
  ok: boolean;
  message: string;
}

/** One opened port, narrowed to what keying needs. Swapped out in tests. */
export interface KeyablePort {
  write(data: Uint8Array): Promise<void>;
  setRts(on: boolean): Promise<void>;
  close(): Promise<void>;
}

/**
 * Commands the radio to unkey, independently of whatever else happened.
 *
 * Module 10a's rule, applied early because this is where it first bites: a
 * modem that dies mid-transmission never sends its own unkey. With CAT keying
 * that leaves the radio TRANSMITTING -- killing the process does not undo a
 * command already sent down a serial port. (RTS keying is self-healing, since
 * closing the port drops the line, but it costs nothing to be explicit.)
 *
 * Best effort by construction: never throws, never reports. It runs on paths
 * that are already handling a failure, and an exception here would mask the
 * real one. Callers must run it AFTER the modem has stopped, or the port is
 * still held.
 */
export async function releasePtt(ptt: PttConfig, options: PttTestOptions = {}): Promise<void> {
  if (ptt.method !== "cat" && ptt.method !== "rts") return;
  if (!ptt.port) return;

  const openPort = options.openPort ?? openKeyablePort;
  let port: KeyablePort | null = null;
  try {
    port = await openPort(ptt.port, ptt.baud);
    if (ptt.method === "rts") {
      await port.setRts(false);
      return;
    }
    const hex = normaliseHexCommand(ptt.unkeyHex);
    if (hex) await port.write(hexToBytes(hex));
  } catch {
    // Nothing useful to do. The port may be gone, the radio unplugged, or
    // another process may hold it -- in which case that process owns the PTT
    // line anyway.
  } finally {
    await port?.close().catch(() => {});
  }
}

export interface PttTestOptions {
  openPort?: (path: string, baud: number) => Promise<KeyablePort>;
  /** Injected so the tests do not spend a real second keying a fake radio. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Refuses before it opens anything, when the configuration cannot key.
 *
 * Separate from the test itself so the UI can grey the button and say why,
 * rather than offering an action that always fails.
 */
export function pttTestUnavailableReason(ptt: PttConfig): string | null {
  if (ptt.method === "none") {
    return "This profile uses VOX, so WL2GO has nothing to key — the interface keys the radio itself.";
  }
  if (ptt.method === "rigctld") {
    return "Keying through rig control is not built yet, so there is nothing to test.";
  }
  if (!ptt.port) {
    return "Choose the port the radio is on first.";
  }
  if (ptt.method === "cat" && (!normaliseHexCommand(ptt.keyHex) || !normaliseHexCommand(ptt.unkeyHex))) {
    return "Choose a radio, or enter both commands, before testing.";
  }
  return null;
}

/**
 * Keys the radio for about a second and releases it.
 *
 * The unkey runs on every path -- success, write failure, a port that closes
 * under us -- and again from a timer that does not care whether any of the
 * above ran. Two independent releases for one key is the right ratio here.
 */
export async function testPtt(ptt: PttConfig, options: PttTestOptions = {}): Promise<PttTestResult> {
  const refusal = pttTestUnavailableReason(ptt);
  if (refusal) return { ok: false, message: refusal };

  const openPort = options.openPort ?? openKeyablePort;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const path = ptt.port as string;

  let port: KeyablePort | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;

  const unkey = async (): Promise<void> => {
    if (!port) return;
    if (ptt.method === "rts") {
      await port.setRts(false);
      return;
    }
    const hex = normaliseHexCommand(ptt.unkeyHex);
    if (hex) await port.write(hexToBytes(hex));
  };

  try {
    port = await openPort(path, ptt.baud);
  } catch (err: unknown) {
    return { ok: false, message: describeOpenFailure(path, err) };
  }

  try {
    // Armed BEFORE the first key, so there is no window in which the radio is
    // keyed and nothing is scheduled to release it.
    watchdog = setTimeout(() => {
      void unkey().catch(() => {});
    }, WATCHDOG_MS);

    if (ptt.method === "rts") {
      await port.setRts(true);
    } else {
      await port.write(hexToBytes(normaliseHexCommand(ptt.keyHex) as string));
    }

    await wait(KEY_DURATION_MS);
    await unkey();

    return {
      ok: true,
      message:
        ptt.method === "rts"
          ? `Asserted RTS on ${path} for about a second. If the radio keyed, this profile can transmit.`
          : `Sent the key and unkey commands on ${path} at ${ptt.baud} baud. If the radio keyed, this profile can transmit.`,
    };
  } catch (err: unknown) {
    await unkey().catch(() => {});
    return {
      ok: false,
      message: `The keying test failed on ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (watchdog) clearTimeout(watchdog);
    await port?.close().catch(() => {});
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * The likeliest cause on macOS is the one the operator can act on: a modem or
 * another program already has the port, or it is the wrong one of the two nodes
 * the radio presents.
 */
function describeOpenFailure(path: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return (
    `WL2GO could not open ${path}: ${reason}\n\n` +
    `If a session or the tuning window is running, close it first — the modem holds this port. ` +
    `Otherwise this may be the wrong one of the radio's serial ports; "Detect my radio" will say which.`
  );
}

/** The real port. Everything above it is testable without a transmitter. */
async function openKeyablePort(path: string, baud: number): Promise<KeyablePort> {
  const port = new SerialPort({ path, baudRate: baud, autoOpen: false });
  // Unhandled 'error' on a Node stream takes the process down, and a radio
  // unplugged mid-test raises exactly that.
  port.on("error", () => {});

  await new Promise<void>((resolve, reject) => {
    port.open((err) => (err ? reject(err) : resolve()));
  });

  return {
    write: (data) =>
      new Promise((resolve, reject) => {
        // drain, not write: write only queues it. Returning before the bytes
        // reach the radio would let close() cut the unkey off mid-flight.
        port.write(Buffer.from(data), (err) => {
          if (err) return reject(err);
          port.drain((drainErr) => (drainErr ? reject(drainErr) : resolve()));
        });
      }),
    setRts: (on) =>
      new Promise((resolve, reject) => {
        port.set({ rts: on }, (err) => (err ? reject(err) : resolve()));
      }),
    close: () =>
      new Promise((resolve) => {
        if (!port.isOpen) return resolve();
        port.close(() => resolve());
      }),
  };
}
