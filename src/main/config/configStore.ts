// Persistence for the application config.
//
// Deliberately hand-rolled rather than using electron-store: `npm test` runs
// node --test outside Electron, and electron-store resolves app.getPath() at
// import time, so it cannot be imported by a test. A store parameterised by file
// path is testable against a tmpdir -- which matters here, because schema
// migration and corrupt-file recovery are the parts most worth testing.
//
// This module must stay free of any `electron` import, directly or transitively.

import { readFileSync, renameSync } from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "../util/atomicWrite.ts";
import {
  CONFIG_SCHEMA_VERSION,
  isFromFuture,
  materialiseProfile,
  migrate,
  newProfileId,
  normaliseCallsign,
  normaliseGridSquare,
  parseConfig,
  validateProfile,
  type AppConfig,
  type RadioProfile,
  type RadioProfileInput,
  type DiagnosticsSettings,
  type StationIdentity,
} from "../../shared/configSchema.ts";

export interface ConfigStoreOptions {
  filePath: string;
  /** Called for anything the store had to repair or could not do. */
  onWarning?: (message: string) => void;
}

export class ConfigStore {
  readonly filePath: string;
  private readonly onWarning: (message: string) => void;
  private config: AppConfig;
  private warnings: string[] = [];

  constructor(options: ConfigStoreOptions) {
    this.filePath = options.filePath;
    this.onWarning = options.onWarning ?? (() => {});
    this.config = parseConfig(undefined).config;
  }

  /**
   * Reads the file from disk. Synchronous on purpose: this runs once during
   * startup, before the first window paints, and every caller downstream wants
   * a config that already exists rather than a promise.
   */
  load(): AppConfig {
    this.warnings = [];
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== "ENOENT") {
        // Unreadable or unparseable: keep the file so the operator can recover
        // whatever was in it, and carry on with defaults.
        this.warn(`Could not read ${path.basename(this.filePath)}: ${message(err)}. Defaults are in use.`);
        this.backup("corrupt");
      }
      this.config = parseConfig(undefined).config;
      return this.config;
    }

    // A file written by a newer build is never reinterpreted under older rules;
    // it is moved aside first so nothing that build wrote is lost.
    const fromFuture = isFromFuture(raw);
    if (fromFuture) this.backup("newer");

    const parsed = parseConfig(migrate(raw, process.platform));
    // parseConfig preserves the future version so callers can detect it. Having
    // moved that file aside, this build now owns the path and writes its own
    // version -- otherwise the next save would stamp a version we do not honour.
    this.config = fromFuture ? { ...parsed.config, schemaVersion: CONFIG_SCHEMA_VERSION } : parsed.config;
    // Appended, not assigned: backup() above may already have reported something.
    for (const warning of parsed.warnings) this.warn(warning);
    return this.config;
  }

  /** A snapshot; callers must go through the mutators rather than editing this. */
  get(): AppConfig {
    return structuredClone(this.config);
  }

  /** Repairs reported by the last load, for the System Check row. */
  getWarnings(): readonly string[] {
    return this.warnings;
  }

  setStation(station: StationIdentity): AppConfig {
    const callsign = normaliseCallsign(station.callsign);
    const gridSquare = normaliseGridSquare(station.gridSquare);
    this.config = {
      ...this.config,
      station: { callsign, gridSquare, shareWithWinlink: station.shareWithWinlink },
    };
    this.save();
    return this.get();
  }

  setDiagnostics(diagnostics: DiagnosticsSettings): AppConfig {
    this.config = {
      ...this.config,
      diagnostics: { recordRxAudio: diagnostics.recordRxAudio === true },
    };
    this.save();
    return this.get();
  }

  /**
   * Creates a profile when the input has no id, updates it when it does.
   * The first profile saved becomes the active one -- an operator with exactly
   * one radio should never have to also declare that it is the one in use.
   */
  saveProfile(input: RadioProfileInput): AppConfig {
    const errors = validateProfile(input);
    if (errors.length) throw new Error(errors.join(" "));

    const profiles = [...this.config.profiles];
    const existingIndex = input.id ? profiles.findIndex((p) => p.id === input.id) : -1;

    if (input.id && existingIndex === -1) {
      throw new Error(`No radio profile with id "${input.id}".`);
    }

    const id = input.id ?? newProfileId();
    // Platform is passed HERE and not by the wizard's review preview: this is
    // the write that reaches disk, so this is where a serial path must be
    // rewritten to its callout node. Both the USB interface's port and the PTT
    // port go through it -- ardopcf and rigctld both open these strings, and a
    // /dev/tty.* node blocks until carrier detect, which a CAT port never
    // asserts.
    const profile: RadioProfile = materialiseProfile(input, id, process.platform);

    if (existingIndex === -1) profiles.push(profile);
    else profiles[existingIndex] = profile;

    this.config = {
      ...this.config,
      profiles,
      activeProfileId: this.config.activeProfileId ?? profile.id,
    };
    this.save();
    return this.get();
  }

  deleteProfile(id: string): AppConfig {
    const profiles = this.config.profiles.filter((p) => p.id !== id);
    if (profiles.length === this.config.profiles.length) {
      throw new Error(`No radio profile with id "${id}".`);
    }

    this.config = {
      ...this.config,
      profiles,
      // Falling back to whatever profile remains beats leaving the operator with
      // profiles configured but none of them active.
      activeProfileId:
        this.config.activeProfileId === id ? (profiles[0]?.id ?? null) : this.config.activeProfileId,
    };
    this.save();
    return this.get();
  }

  setActiveProfile(id: string | null): AppConfig {
    if (id !== null && !this.config.profiles.some((p) => p.id === id)) {
      throw new Error(`No radio profile with id "${id}".`);
    }
    this.config = { ...this.config, activeProfileId: id };
    this.save();
    return this.get();
  }

  activeProfile(): RadioProfile | null {
    return this.config.profiles.find((p) => p.id === this.config.activeProfileId) ?? null;
  }

  /** Atomic and durable; see util/atomicWrite.ts for why both matter. */
  private save(): void {
    try {
      writeFileAtomicSync(this.filePath, `${JSON.stringify(this.config, null, 2)}\n`, { mode: 0o600 });
    } catch (err: unknown) {
      throw new Error(`Could not save the configuration: ${message(err)}`);
    }
  }

  /** Copies the current file aside so a bad parse never destroys its contents. */
  private backup(reason: "corrupt" | "newer"): void {
    const target = `${this.filePath}.${reason}.${Date.now()}.bak`;
    try {
      renameSync(this.filePath, target);
      this.warn(`The previous configuration was kept at ${path.basename(target)}.`);
    } catch {
      /* best effort: if it cannot be moved, the load still proceeds on defaults */
    }
  }

  private warn(text: string): void {
    this.warnings.push(text);
    this.onWarning(text);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
