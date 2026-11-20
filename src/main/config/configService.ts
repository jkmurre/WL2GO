// Binds the config store and the secret store together into the single object
// the IPC layer talks to, and is the only place that knows how to build the
// AppConfigView the renderer receives.
//
// Unlike its two collaborators this module does import Electron -- safeStorage
// lives there. That is why the stores themselves stay Electron-free: the parts
// worth unit testing are on the other side of this boundary.

import { safeStorage } from "electron";
import { ConfigStore } from "./configStore.ts";
import { SecretStore, WINLINK_PASSWORD_KEY, lanPasswordKey } from "./secretStore.ts";
import { logger } from "../logging/logger.ts";
import type { AppConfigView } from "../../shared/ipcContract.ts";
import type { DiagnosticsSettings, RadioProfile, RadioProfileInput, StationIdentity } from "../../shared/configSchema.ts";

export interface ConfigServiceOptions {
  configPath: string;
  secretsPath: string;
  /** Called after every mutation so main can push config:changed. */
  onChange?: (view: AppConfigView) => void;
}

export class ConfigService {
  private readonly config: ConfigStore;
  private readonly secrets: SecretStore;
  private readonly onChange: (view: AppConfigView) => void;

  constructor(options: ConfigServiceOptions) {
    this.onChange = options.onChange ?? (() => {});

    this.config = new ConfigStore({
      filePath: options.configPath,
      onWarning: (message) => logger.warn("config", message),
    });
    this.secrets = new SecretStore({
      filePath: options.secretsPath,
      crypto: {
        isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
        encryptString: (plain) => safeStorage.encryptString(plain),
        decryptString: (blob) => safeStorage.decryptString(blob),
      },
      onWarning: (message) => logger.warn("config", message),
    });
  }

  /** Must run after app.whenReady(): safeStorage is not usable before that. */
  load(): void {
    this.config.load();
    this.secrets.load();

    const callsign = this.config.get().station.callsign;
    logger.info("config", callsign ? `Loaded config for ${callsign}` : "Loaded config; no callsign set yet");
    if (!this.secrets.isAvailable()) {
      logger.warn("config", "Secure credential storage is unavailable on this system");
    }
  }

  view(): AppConfigView {
    return {
      ...this.config.get(),
      hasWinlinkPassword: this.secrets.has(WINLINK_PASSWORD_KEY),
      // Which profiles have a stored network password -- never the passwords
      // themselves. The renderer needs to show "set" or "not set" and nothing
      // more, so there is nothing here to widen into a leak later.
      profilesWithLanPassword: this.config
        .get()
        .profiles.map((profile) => profile.id)
        .filter((id) => this.secrets.has(lanPasswordKey(id))),
      secureStorageAvailable: this.secrets.isAvailable(),
      // Both stores' warnings, so a credential that failed to decrypt is
      // explained in the UI instead of only in the log.
      warnings: [...this.config.getWarnings(), ...this.secrets.getWarnings()],
    };
  }

  /**
   * The callsign Pat is spawned with. Falls back to N0CALL so a fresh install
   * still starts a working engine and reports green in the System Check --
   * onboarding (Module 2) is what replaces it with a real one.
   */
  patCallsign(fallback: string): string {
    return this.config.get().station.callsign || fallback;
  }

  activeProfile(): RadioProfile | null {
    return this.config.activeProfile();
  }

  setStation(station: StationIdentity): AppConfigView {
    this.config.setStation(station);
    return this.changed();
  }

  setDiagnostics(diagnostics: DiagnosticsSettings): AppConfigView {
    this.config.setDiagnostics(diagnostics);
    return this.changed();
  }

  setWinlinkPassword(password: string): AppConfigView {
    this.secrets.set(WINLINK_PASSWORD_KEY, password);
    logger.info("config", password ? "Winlink password stored" : "Winlink password cleared");
    return this.changed();
  }

  /** For Module 2, which writes it into Pat's derived config at spawn time. */
  winlinkPassword(): string | null {
    return this.secrets.get(WINLINK_PASSWORD_KEY);
  }

  /**
   * A networked radio's login password.
   *
   * Namespaced per profile, and in the keychain rather than config.json --
   * two radios can want different credentials, and neither belongs on disk in
   * clear text. deleteProfile already removes it with the profile.
   *
   * An empty string clears it, matching setWinlinkPassword.
   */
  setLanPassword(profileId: string, password: string): AppConfigView {
    this.secrets.set(lanPasswordKey(profileId), password);
    logger.info("config", password ? "Network radio password stored" : "Network radio password cleared");
    return this.changed();
  }

  lanPassword(profileId: string): string | null {
    return this.secrets.get(lanPasswordKey(profileId));
  }

  saveProfile(input: RadioProfileInput): AppConfigView {
    this.config.saveProfile(input);
    return this.changed();
  }

  deleteProfile(id: string): AppConfigView {
    this.config.deleteProfile(id);
    // The profile is gone, so its credentials must not outlive it.
    this.secrets.deleteProfileSecrets(id);
    return this.changed();
  }

  setActiveProfile(id: string | null): AppConfigView {
    this.config.setActiveProfile(id);
    return this.changed();
  }

  private changed(): AppConfigView {
    const view = this.view();
    this.onChange(view);
    return view;
  }
}
