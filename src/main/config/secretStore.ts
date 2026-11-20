// Encrypted storage for the things that must never sit in config.json: the
// Winlink password, and any LAN interface credentials.
//
// Backed by Electron's safeStorage, which on macOS means the login Keychain.
// The crypto primitives are injected rather than imported so this module can be
// tested outside Electron -- and, more importantly, so the *failure* branches can
// be tested, because they are the ones an operator actually meets.

import { readFileSync } from "node:fs";
import { writeFileAtomicSync } from "../util/atomicWrite.ts";

/** Where the Winlink account password is kept. */
export const WINLINK_PASSWORD_KEY = "winlinkPassword";

/** Per-profile LAN credentials are namespaced by profile id. */
export function lanPasswordKey(profileId: string): string {
  return `profile:${profileId}:lanPassword`;
}

export interface SecretCrypto {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(blob: Buffer): string;
}

export interface SecretStoreOptions {
  filePath: string;
  crypto: SecretCrypto;
  onWarning?: (message: string) => void;
}

/**
 * Secure storage can genuinely be unavailable -- some Linux desktops have no
 * keyring at all. The answer there is to refuse and say so, never to quietly
 * write the password in clear text.
 */
export class SecretStore {
  readonly filePath: string;
  private readonly crypto: SecretCrypto;
  private readonly onWarning: (message: string) => void;
  private blobs: Record<string, string> = {};
  private warnings: string[] = [];

  constructor(options: SecretStoreOptions) {
    this.filePath = options.filePath;
    this.crypto = options.crypto;
    this.onWarning = options.onWarning ?? (() => {});
  }

  load(): void {
    this.warnings = [];
    try {
      const raw: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      this.blobs = {};
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof value === "string") this.blobs[key] = value;
        }
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== "ENOENT") {
        this.warn(`Could not read stored credentials: ${message(err)}.`);
      }
      this.blobs = {};
    }
  }

  isAvailable(): boolean {
    try {
      return this.crypto.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /**
   * Anything that had to be repaired, for the System Check row and the Settings
   * page. A decrypt failure happens long after load(), so this is read live
   * rather than captured once.
   */
  getWarnings(): readonly string[] {
    return this.warnings;
  }

  private warn(text: string): void {
    this.warnings.push(text);
    this.onWarning(text);
  }

  /** Whether a secret is stored, without decrypting it. */
  has(key: string): boolean {
    return typeof this.blobs[key] === "string";
  }

  /**
   * Returns null when the secret is absent *or* undecryptable.
   *
   * Undecryptable is not an edge case: the blob is bound to this machine and
   * this user's keychain, so a restored backup, a migrated machine or a reset
   * keychain all make decryptString throw. That must degrade to "not set, please
   * re-enter it" -- never an exception on the startup path.
   */
  get(key: string): string | null {
    const blob = this.blobs[key];
    if (typeof blob !== "string") return null;

    try {
      return this.crypto.decryptString(Buffer.from(blob, "base64"));
    } catch (err: unknown) {
      this.warn(
        `A stored credential could not be decrypted (${message(err)}). It was cleared; please enter it again.`,
      );
      this.delete(key);
      return null;
    }
  }

  /** An empty value clears the secret. Throws when secure storage is unavailable. */
  set(key: string, value: string): void {
    if (!value) {
      this.delete(key);
      return;
    }
    if (!this.isAvailable()) {
      throw new Error(
        "This system has no secure credential storage available, so the password cannot be saved safely.",
      );
    }
    this.blobs[key] = this.crypto.encryptString(value).toString("base64");
    this.save();
  }

  delete(key: string): void {
    if (!(key in this.blobs)) return;
    delete this.blobs[key];
    this.save();
  }

  /** Drops every secret belonging to a profile that is being deleted. */
  deleteProfileSecrets(profileId: string): void {
    this.delete(lanPasswordKey(profileId));
  }

  /** Same durable write as ConfigStore, and 0600 because of the contents. */
  private save(): void {
    try {
      writeFileAtomicSync(this.filePath, `${JSON.stringify(this.blobs, null, 2)}\n`, { mode: 0o600 });
    } catch (err: unknown) {
      throw new Error(`Could not save credentials: ${message(err)}`);
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
