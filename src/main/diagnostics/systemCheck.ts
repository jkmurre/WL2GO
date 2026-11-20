// Runs WL2GO's self-check and reports it in operator-readable terms.
//
// This is the acceptance surface for Module 0, but it is not throwaway scaffolding:
// later modules need exactly this screen to distinguish "modem failed to start"
// from "TNC unreachable" from "RMS did not answer", so checks get appended here
// as each subsystem lands.

import { access, constants } from "node:fs/promises";
import * as path from "node:path";
import type {
  AppConfigView,
  AppPaths,
  ArdopProcessState,
  AudioDevice,
  RigctldProcessState,
  SerialPortInfo,
  CheckStatus,
  DiagnosticCheck,
  DiagnosticsReport,
  PatProcessState,
  PatStatus,
} from "../../shared/ipcContract.ts";

export interface SystemCheckInput {
  paths: AppPaths;
  patState: PatProcessState;
  getPatStatus: () => Promise<PatStatus>;
  ardopState: ArdopProcessState;
  /** Runs the modem with audio disabled to prove it is executable. */
  runModemSelfTest: () => Promise<void>;
  /**
   * Whether the modem is busy with a live session.
   *
   * The self-test starts a modem, and start() refuses when one is already
   * running -- so during an RF session the test throws and a perfectly healthy
   * modem reports FAIL. A health screen that shows red for a normal state
   * teaches operators to ignore it, which is the same reason the microphone row
   * reports not-determined as pending rather than as a warning.
   */
  modemInUse: boolean;
  rigctldState: RigctldProcessState;
  /** Runs rig control against Hamlib's dummy backend, so no radio is needed. */
  runRigctldSelfTest: () => Promise<void>;
  listAudioDevices: () => Promise<AudioDevice[]>;
  listSerialPorts: () => Promise<SerialPortInfo[]>;
  /**
   * macOS microphone consent for the APP, from Electron's
   * systemPreferences.getMediaAccessStatus. Null off darwin, where there is no
   * such gate. It reports for WL2GO, not for the ardopcf process it spawns --
   * which is the point: if this says "granted" and the modem still hears
   * silence, the assumption that TCC attributes a spawned helper to its parent
   * bundle is wrong, and that is worth knowing before Module 9 depends on it.
   */
  microphoneAccess?: "not-determined" | "granted" | "denied" | "restricted" | "unknown" | null;
  configView: AppConfigView;
  /**
   * The callsign in Pat's own config file. Not necessarily the one the running
   * process holds -- see the note at the call site in ipc/handlers.ts.
   */
  patCallsign: string;
  /** Whether Pat's /ws event stream is answering. */
  eventStreamAttached: boolean;
  /**
   * process.resourcesPath when packaged. Every spawned binary must live under
   * it; null in development, where they legitimately come from the repo.
   */
  resourcesRoot?: string | null;
  isPackaged: boolean;
  appVersion: string;
  logFile: string | null;
  shutdownArmed: boolean;
  platform?: string;
  arch?: string;
}

/** Worst status wins; "pending" only survives if nothing worse is present. */
export function overallStatus(checks: DiagnosticCheck[]): CheckStatus {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  if (checks.some((c) => c.status === "pending")) return "pending";
  return "pass";
}

/**
 * Whether a spawned binary lives inside the packaged app.
 *
 * A prefix match on the resources directory, with a separator guard so a
 * sibling directory that merely starts with the same characters cannot pass.
 */
function isInsideBundle(binaryPath: string, resourcesRoot: string | null | undefined): boolean {
  if (!resourcesRoot) return false;
  const root = resourcesRoot.endsWith(path.sep) ? resourcesRoot : resourcesRoot + path.sep;
  return binaryPath.startsWith(root);
}

async function isWritable(target: string): Promise<boolean> {
  try {
    await access(target, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runSystemCheck(input: SystemCheckInput): Promise<DiagnosticsReport> {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const checks: DiagnosticCheck[] = [];

  checks.push({
    id: "electron-shell",
    label: "Electron shell running",
    status: "pass",
    detail: `${platform}/${arch}, Electron ${process.versions.electron ?? "unknown"}`,
  });

  checks.push({
    id: "ipc-bridge",
    label: "IPC bridge (context isolation)",
    status: "pass",
    detail: "Renderer reached the main process through the preload bridge",
  });

  // The headline fact an operator wants: nothing here reaches outside the app.
  // Deliberately reported without printing any path -- a health screen states
  // what was checked and whether it passed.
  const spawnedBinaries = [
    input.patState.binaryPath,
    input.ardopState.binaryPath,
    input.rigctldState.binaryPath,
  ].filter((p) => p !== "");
  const escaped = input.isPackaged
    ? spawnedBinaries.filter((p) => !isInsideBundle(p, input.resourcesRoot))
    : [];
  checks.push({
    id: "components-bundled",
    label: "All components bundled",
    status: escaped.length === 0 ? "pass" : "fail",
    detail: !input.isPackaged
      ? "Development build — components load from the source tree"
      : escaped.length === 0
        ? "Yes — the protocol engine, modem and rig control all ship inside WL2GO"
        : `${escaped.length} component${escaped.length === 1 ? "" : "s"} loaded from outside the app`,
    hint: escaped.length === 0 ? undefined : "This build is not self-contained and must not be distributed.",
  });

  const userDataWritable = await isWritable(input.paths.userData);
  checks.push({
    id: "app-directories",
    label: "Application data directories",
    status: userDataWritable ? "pass" : "fail",
    detail: userDataWritable ? "Writable" : "Not writable",
    hint: userDataWritable ? undefined : "The user data directory is not writable; check disk permissions.",
  });

  const logWritable = input.logFile ? await isWritable(input.logFile) : false;
  checks.push({
    id: "logger",
    label: "Log file",
    status: logWritable ? "pass" : "warn",
    detail: logWritable ? "Writing" : "Not initialised",
    hint: logWritable ? undefined : "Logs are not being written; subprocess output will be lost.",
  });

  // A fresh install has an empty config and that is not a fault -- only a file
  // that had to be repaired is worth the operator's attention.
  const config = input.configView;
  const profileCount = config.profiles.length;
  checks.push({
    id: "config-file",
    label: "Configuration",
    status: config.warnings.length ? "warn" : "pass",
    detail: config.warnings.length
      ? config.warnings.join(" ")
      : `${config.station.callsign || "No callsign set yet"} · ${profileCount} radio profile${profileCount === 1 ? "" : "s"}`,
    hint: config.warnings.length ? "Review your settings; the values below were reset to defaults." : undefined,
  });

  checks.push({
    id: "secure-storage",
    label: "Secure credential storage",
    status: config.secureStorageAvailable ? "pass" : "warn",
    detail: config.secureStorageAvailable
      ? config.hasWinlinkPassword
        ? "Available; a Winlink password is stored"
        : "Available; no Winlink password stored yet"
      : "Unavailable on this system",
    hint: config.secureStorageAvailable
      ? undefined
      : "Passwords cannot be saved because this system has no keyring available.",
  });

  // Onboarding writes the callsign into Pat's derived config and restarts it,
  // so a mismatch here means that did not take -- worth surfacing, since the
  // symptom otherwise appears much later as a rejected connection.
  checks.push({
    id: "station-identity",
    label: "Station identity",
    status: config.station.callsign ? (input.patCallsign === config.station.callsign ? "pass" : "warn") : "warn",
    detail: !config.station.callsign
      ? "No callsign set — complete setup in Settings"
      : input.patCallsign === config.station.callsign
        ? `Winlink engine is configured as ${config.station.callsign}`
        : `Set to ${config.station.callsign}, but the engine has ${input.patCallsign || "no callsign"}`,
    hint:
      config.station.callsign && input.patCallsign !== config.station.callsign
        ? "Re-save your callsign in Settings to restart the engine with it."
        : undefined,
  });

  // Connecting is refused without this, because Pat prompts about the account
  // before parsing the transport and an unattached session hangs for two minutes.
  checks.push({
    id: "pat-events",
    label: "Winlink session events",
    status: input.eventStreamAttached ? "pass" : input.patState.state === "running" ? "warn" : "pending",
    detail: input.eventStreamAttached
      ? "Attached; prompts during a session can be answered"
      : input.patState.state === "running"
        ? "Not attached — connecting is disabled until it is"
        : "Waiting on the protocol engine",
    hint: input.eventStreamAttached || input.patState.state !== "running"
      ? undefined
      : "Without this a Winlink password prompt cannot be answered and the session would time out.",
  });

  const binary = input.patState.binary;
  checks.push({
    id: "pat-binary-present",
    label: "Pat binary vendored",
    status: binary?.exists ? "pass" : "fail",
    detail: "Bundled with WL2GO",
    hint: binary?.exists ? undefined : "Build it from source with: npm run build:pat",
  });

  checks.push({
    id: "pat-binary-arch",
    label: "Pat binary matches this machine",
    status: binary?.exists ? (binary.matchesHost ? "pass" : "fail") : "pending",
    detail: binary?.exists
      ? `${binary.format}/${binary.arch} on host ${platform}/${arch}`
      : "Waiting on the binary",
    hint:
      binary?.exists && !binary.matchesHost
        ? "This binary was built for a different platform. Rebuild it: npm run build:pat"
        : undefined,
  });

  const running = input.patState.state === "running";
  checks.push({
    id: "pat-process",
    label: "Pat subprocess started",
    status: running ? "pass" : input.patState.state === "starting" ? "pending" : "fail",
    detail: running
      ? `Running as pid ${input.patState.pid}`
      : (input.patState.lastError ?? `State: ${input.patState.state}`),
    hint: running ? undefined : "See pat.log in the logs directory for the subprocess output.",
  });

  let patStatus: PatStatus | null = null;
  if (running) {
    try {
      patStatus = await input.getPatStatus();
      checks.push({
        id: "pat-api",
        label: "Pat HTTP API responding",
        status: "pass",
        detail: patStatus.connected ? "Responding; connected to Winlink" : "Responding; not connected",
      });
    } catch (err) {
      checks.push({
        id: "pat-api",
        label: "Pat HTTP API responding",
        status: "fail",
        detail: err instanceof Error ? err.message : String(err),
        hint: "Pat is running but its API is unreachable. Another process may hold the port.",
      });
    }
  } else {
    checks.push({
      id: "pat-api",
      label: "Pat HTTP API responding",
      status: "pending",
      detail: "Waiting on the Pat subprocess",
    });
  }

  const ardopBinary = input.ardopState.binary;
  checks.push({
    id: "ardopcf-binary-present",
    label: "ARDOP modem vendored",
    status: ardopBinary?.exists ? "pass" : "fail",
    detail: "Bundled with WL2GO",
    hint: ardopBinary?.exists ? undefined : "Build it from source with: npm run build:ardopcf",
  });

  checks.push({
    id: "ardopcf-binary-arch",
    label: "ARDOP modem matches this machine",
    status: ardopBinary?.exists ? (ardopBinary.matchesHost ? "pass" : "fail") : "pending",
    detail: ardopBinary?.exists
      ? `${ardopBinary.format}/${ardopBinary.arch} on host ${platform}/${arch}`
      : "Waiting on the binary",
    hint:
      ardopBinary?.exists && !ardopBinary.matchesHost
        ? "This binary was built for a different platform. Rebuild it: npm run build:ardopcf"
        : undefined,
  });

  if (ardopBinary?.exists && ardopBinary.matchesHost && input.modemInUse) {
    // Not run, and not a failure. The modem is doing exactly what it is for.
    checks.push({
      id: "ardopcf-selftest",
      label: "ARDOP modem starts and answers",
      status: "pending",
      detail: "In use by the active session, so it was not started a second time",
    });
  } else if (ardopBinary?.exists && ardopBinary.matchesHost) {
    try {
      await input.runModemSelfTest();
      checks.push({
        id: "ardopcf-selftest",
        label: "ARDOP modem starts and answers",
        status: "pass",
        // The modem is not left running: it would hold the sound card open and,
        // on macOS, prompt for microphone access.
        detail: `Opened its host port on ${input.ardopState.hostPort} with audio disabled, then stopped`,
      });
    } catch (err) {
      checks.push({
        id: "ardopcf-selftest",
        label: "ARDOP modem starts and answers",
        status: "fail",
        detail: err instanceof Error ? err.message : String(err),
        hint: "See ardopcf.log in the logs directory for the modem's own output.",
      });
    }
  } else {
    checks.push({
      id: "ardopcf-selftest",
      label: "ARDOP modem starts and answers",
      status: "pending",
      detail: "Waiting on a usable modem binary",
    });
  }

  const rigBinary = input.rigctldState.binary;
  checks.push({
    id: "rigctld-binary-present",
    label: "Rig control vendored",
    status: rigBinary?.exists ? "pass" : "fail",
    detail: "Bundled with WL2GO",
    hint: rigBinary?.exists ? undefined : "Build it from source with: npm run build:rigctld",
  });

  checks.push({
    id: "rigctld-binary-arch",
    label: "Rig control matches this machine",
    status: rigBinary?.exists ? (rigBinary.matchesHost ? "pass" : "fail") : "pending",
    detail: rigBinary?.exists
      ? `${rigBinary.format}/${rigBinary.arch} on host ${platform}/${arch}`
      : "Waiting on the binary",
    hint:
      rigBinary?.exists && !rigBinary.matchesHost
        ? "This binary was built for a different platform. Rebuild it: npm run build:rigctld"
        : undefined,
  });

  if (rigBinary?.exists && rigBinary.matchesHost) {
    try {
      await input.runRigctldSelfTest();
      checks.push({
        id: "rigctld-selftest",
        label: "Rig control starts and answers",
        status: "pass",
        // Hamlib's dummy backend emulates a radio in software, so this proves
        // the daemon and its bundled library work with nothing plugged in.
        detail: `Answered on port ${input.rigctldState.port} using Hamlib's dummy rig, then stopped`,
      });
    } catch (err) {
      checks.push({
        id: "rigctld-selftest",
        label: "Rig control starts and answers",
        status: "fail",
        detail: err instanceof Error ? err.message : String(err),
        hint: "See rigctld.log in the logs directory for the daemon's own output.",
      });
    }
  } else {
    checks.push({
      id: "rigctld-selftest",
      label: "Rig control starts and answers",
      status: "pending",
      detail: "Waiting on a usable rig control binary",
    });
  }

  try {
    const devices = await input.listAudioDevices();
    const capture = devices.filter((d) => d.direction === "capture");
    const playback = devices.filter((d) => d.direction === "playback");
    const usable = devices.filter((d) => d.supports12k).length;
    const defaults = devices.filter((d) => d.isDefault).map((d) => d.name);
    checks.push({
      id: "audio-devices",
      label: "Audio devices detected",
      status: devices.length > 0 ? "pass" : "warn",
      detail:
        `${capture.length} capture, ${playback.length} playback; ` +
        `${usable} can do the 12000 Hz the modem uses` +
        (defaults.length ? `. Default: ${defaults.join(", ")}` : ""),
      hint: devices.length > 0 ? undefined : "No audio devices found; ARDOP needs a sound card.",
    });
  } catch (err) {
    checks.push({
      id: "audio-devices",
      label: "Audio devices detected",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      hint: "The modem could not enumerate audio devices.",
    });
  }

  try {
    const ports = await input.listSerialPorts();
    const likely = ports.filter((p) => p.likelyRadioInterface);
    checks.push({
      id: "serial-ports",
      label: "Serial ports enumerable",
      status: "pass",
      // Zero ports is normal with no radio connected; what matters here is that
      // enumeration works at all, since the native binding must load. The paths
      // shown are the ones a profile would store -- on macOS the callout nodes.
      detail:
        ports.length === 0
          ? "none connected"
          : `${likely.length} of ${ports.length} look like USB interfaces: ` +
            (likely.length ? likely.map((p) => p.path).join(", ") : ports.map((p) => p.path).join(", ")),
    });
  } catch (err) {
    checks.push({
      id: "serial-ports",
      label: "Serial ports enumerable",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      hint: "The serial port binding failed to load; rig control will not work.",
    });
  }

  // macOS only: the modem cannot hear the radio without this, and a denial is
  // silent -- ardopcf just receives zeroes. Better to say so on this screen than
  // to let it surface mid-session as "the RMS never answered".
  if ((input.platform ?? process.platform) === "darwin") {
    const access = input.microphoneAccess ?? "unknown";
    // "not-determined" is pending, not a warning. It is the normal state of
    // every fresh install until the first connection, and a health screen that
    // shows a permanent warning for a normal state teaches operators to ignore
    // warnings -- which costs more than it saves.
    const status: CheckStatus =
      access === "granted"
        ? "pass"
        : access === "denied" || access === "restricted"
          ? "fail"
          : access === "not-determined"
            ? "pending"
            : "warn";

    checks.push({
      id: "audio-permission",
      label: "Microphone access (macOS)",
      status,
      detail:
        access === "granted"
          ? "Granted"
          : access === "not-determined"
            ? "Not asked yet; macOS will prompt the first time the modem opens the radio's audio"
            : access === "unknown"
              ? "Could not be determined"
              : "Denied",
      hint:
        status === "fail"
          ? "Allow WL2GO under System Settings > Privacy & Security > Microphone. " +
            "Without it the modem receives silence and every connection will fail to decode."
          : undefined,
    });
  }

  checks.push({
    id: "clean-shutdown",
    label: "Clean shutdown handler armed",
    status: input.shutdownArmed ? "pass" : "fail",
    detail: input.shutdownArmed
      ? "Subprocesses are terminated before quit, with a hard timeout"
      : "Not registered",
  });

  checks.push({
    id: "packaging",
    label: "Packaging context",
    status: "pass",
    detail: input.isPackaged ? `Packaged app v${input.appVersion}` : `Development build v${input.appVersion}`,
  });

  return {
    generatedAt: new Date().toISOString(),
    overall: overallStatus(checks),
    checks,
    patStatus,
  };
}
