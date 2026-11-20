// Records what the modem hears, so a failed session leaves audio to inspect.
// `Input peaks` cannot answer this: it is measured before the decoder gate
// (PaSound.c:1372-1422 vs 1452-1454), so it proves audio arrived and nothing
// about whether it decoded. Replay a recording with `npm run decode-rx-wav`.

import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Developer override: WL2GO_RECORD_RX=0/false/"" forces recording off,
 * anything else set (e.g. =1) forces it ON regardless of the Settings toggle.
 */
export const RECORD_RX_ENV_VAR = "WL2GO_RECORD_RX";

/** A file of this name in the log directory turns recording off. */
export const NO_RECORD_RX_MARKER = "no-record-rx";

/**
 * The directory to record into, or undefined for "do not record".
 *
 * The Settings toggle (Diagnostics > record audio, default OFF) decides,
 * under two developer overrides that outrank it in this order:
 *
 *   1. The env var: explicit off wins everything; any other set value forces
 *      recording on, which keeps the pre-toggle debugging workflow alive.
 *   2. The marker file: force-off for an installation whose env cannot be
 *      reached, e.g. an app launched from the dock.
 *
 * Recording ran on by default while the audio path was being debugged;
 * roughly 24 kB per second of receive time, and nothing prunes the files,
 * which is why quiet is now the default.
 */
export function rxRecordingDir(
  logDir: string | null,
  enabledInSettings: boolean,
  env: NodeJS.ProcessEnv = process.env,
  markerExists: (path: string) => boolean = existsSync,
): string | undefined {
  if (!logDir) return undefined;
  const envValue = envOverride(env);
  if (envValue === "off") return undefined;
  if (markerExists(path.join(logDir, NO_RECORD_RX_MARKER))) return undefined;
  if (envValue === "on") return logDir;
  return enabledInSettings ? logDir : undefined;
}

function envOverride(env: NodeJS.ProcessEnv): "on" | "off" | null {
  const raw = env[RECORD_RX_ENV_VAR];
  if (raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  return value === "0" || value === "false" || value === "" ? "off" : "on";
}
