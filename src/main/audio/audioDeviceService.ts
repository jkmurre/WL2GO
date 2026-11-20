import { execFile } from "node:child_process";
import type { AudioDevice } from "../../shared/ipcContract.ts";
import { resolveBinaryPath } from "../pat/patProcessManager.ts";

/**
 * Audio devices come from ardopcf itself rather than from Chromium.
 *
 * The modem is what has to open the device, and since it enumerates through
 * PortAudio its indices are the ones we must hand back to it. Chromium's
 * mediaDevices IDs are a different namespace and cannot be used for selection.
 */

/** The listing format this build understands. See vendor patch 0004 / PaSound.c. */
export const DEVICE_LIST_HEADER = "#ARDOPCF-DEVICE-LIST 2";

export class StaleArdopcfError extends Error {
  constructor() {
    super(
      "The bundled ardopcf is older than this build of WL2GO and cannot report " +
        "audio device details. Rebuild it: npm run build:ardopcf",
    );
    this.name = "StaleArdopcfError";
  }
}

/**
 * Parses `ardopcf --list-devices`. Pure, for testing.
 *
 * Format, one line per device per direction, name LAST because it is the only
 * field that could itself contain a tab:
 *
 *   KIND <TAB> index <TAB> hostApi <TAB> channels <TAB> default|- <TAB> 12k=yes|no <TAB> name
 *
 * A missing header is a hard error rather than a fallback to the old
 * three-column format. Degrading quietly would leave hostApi, isDefault and
 * supports12k blank everywhere and silently disable everything built on them --
 * the opposite of util/binaryInfo.ts, which exists so a stale binary fails in
 * milliseconds with a reason instead of misbehaving later.
 */
export function parseDeviceList(output: string): AudioDevice[] {
  const lines = output.split("\n");
  if (!lines.some((line) => line.trim() === DEVICE_LIST_HEADER)) {
    throw new StaleArdopcfError();
  }

  const devices: AudioDevice[] = [];

  for (const line of lines) {
    // Only trim the end: a device name could legitimately begin with a space,
    // and trimming the start would silently rename it.
    const trimmed = line.replace(/\s+$/, "");
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Split into exactly 7, so a name containing tabs survives intact.
    const parts = splitColumns(trimmed, 7);
    if (parts === null) continue;

    const [kind, index, hostApi, channels, isDefault, rate, name] = parts;
    if (kind !== "CAPTURE" && kind !== "PLAYBACK") continue;

    const parsedIndex = Number.parseInt(index, 10);
    if (!Number.isInteger(parsedIndex)) continue;
    if (!name) continue;

    devices.push({
      direction: kind === "CAPTURE" ? "capture" : "playback",
      index: parsedIndex,
      name,
      hostApi,
      maxChannels: Number.parseInt(channels, 10) || 0,
      isDefault: isDefault === "default",
      supports12k: rate === "12k=yes",
    });
  }

  return devices;
}

/** Splits on tabs into `count` fields, leaving any further tabs in the last one. */
function splitColumns(line: string, count: number): string[] | null {
  const parts: string[] = [];
  let rest = line;

  for (let i = 0; i < count - 1; i++) {
    const at = rest.indexOf("\t");
    if (at === -1) return null;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }

  parts.push(rest);
  return parts;
}

export async function listAudioDevices(resourcesBinDir: string, timeoutMs = 10_000): Promise<AudioDevice[]> {
  const binPath = resolveBinaryPath(resourcesBinDir, "ardopcf");

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(binPath, ["--list-devices"], { timeout: timeoutMs, windowsHide: true }, (err, out) => {
      if (err) {
        reject(new Error(`Could not list audio devices (${binPath}): ${err.message}`));
        return;
      }
      resolve(out);
    });
  });

  return parseDeviceList(stdout);
}
