import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SecretStore, WINLINK_PASSWORD_KEY, lanPasswordKey, type SecretCrypto } from "./secretStore.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "wl2go-secret-"));
  file = path.join(dir, "secrets.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Stands in for safeStorage. Reversible, and obviously not encryption. */
function fakeCrypto(overrides: Partial<SecretCrypto> = {}): SecretCrypto {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
    decryptString: (blob) => {
      const text = blob.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("not encrypted by this keychain");
      return text.slice(4);
    },
    ...overrides,
  };
}

function store(crypto: SecretCrypto, onWarning?: (m: string) => void): SecretStore {
  return new SecretStore({ filePath: file, crypto, onWarning });
}

describe("SecretStore: normal use", () => {
  it("stores and retrieves a secret across a reload", () => {
    const first = store(fakeCrypto());
    first.load();
    first.set(WINLINK_PASSWORD_KEY, "hunter2");

    const second = store(fakeCrypto());
    second.load();
    assert.equal(second.get(WINLINK_PASSWORD_KEY), "hunter2");
    assert.equal(second.has(WINLINK_PASSWORD_KEY), true);
  });

  it("reports absence without decrypting anything", () => {
    let decryptCalls = 0;
    const s = store(fakeCrypto({ decryptString: () => { decryptCalls += 1; return ""; } }));
    s.load();

    assert.equal(s.has(WINLINK_PASSWORD_KEY), false);
    assert.equal(s.get(WINLINK_PASSWORD_KEY), null);
    assert.equal(decryptCalls, 0);
  });

  it("never writes the plaintext to disk", () => {
    const s = store(fakeCrypto());
    s.load();
    s.set(WINLINK_PASSWORD_KEY, "hunter2");

    assert.equal(readFileSync(file, "utf8").includes("hunter2"), false);
  });

  it("writes the credential file readable only by its owner", () => {
    const s = store(fakeCrypto());
    s.load();
    s.set(WINLINK_PASSWORD_KEY, "hunter2");

    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it("treats an empty value as a clear", () => {
    const s = store(fakeCrypto());
    s.load();
    s.set(WINLINK_PASSWORD_KEY, "hunter2");
    s.set(WINLINK_PASSWORD_KEY, "");

    assert.equal(s.has(WINLINK_PASSWORD_KEY), false);
  });

  it("namespaces LAN credentials per profile and clears them with the profile", () => {
    const s = store(fakeCrypto());
    s.load();
    s.set(lanPasswordKey("p1"), "flexpass");
    s.set(lanPasswordKey("p2"), "other");

    s.deleteProfileSecrets("p1");
    assert.equal(s.has(lanPasswordKey("p1")), false);
    assert.equal(s.get(lanPasswordKey("p2")), "other", "one profile's deletion must not touch another's");
  });

  it("leaves no temp file behind", () => {
    const s = store(fakeCrypto());
    s.load();
    s.set(WINLINK_PASSWORD_KEY, "hunter2");

    assert.deepEqual(readdirSync(dir), ["secrets.json"]);
  });
});

describe("SecretStore: failure paths", () => {
  it("degrades to 'not set' when a blob cannot be decrypted", () => {
    // The real case: the blob is bound to this machine and keychain, so a
    // restored backup or a reset keychain makes decryptString throw.
    writeFileSync(file, JSON.stringify({ [WINLINK_PASSWORD_KEY]: Buffer.from("garbage").toString("base64") }));

    const warnings: string[] = [];
    const s = store(fakeCrypto(), (m) => warnings.push(m));
    s.load();

    assert.equal(s.get(WINLINK_PASSWORD_KEY), null, "must not throw on the startup path");
    assert.match(warnings.join(" "), /could not be decrypted/);
    assert.equal(s.has(WINLINK_PASSWORD_KEY), false, "the dead blob is cleared, not retried forever");

    // The operator has to be told why their password vanished, so the warning
    // must be readable after the fact, not only at the moment it happened.
    assert.match(s.getWarnings().join(" "), /could not be decrypted/);
  });

  it("does not accumulate warnings across reloads", () => {
    writeFileSync(file, "not json");
    const s = store(fakeCrypto());
    s.load();
    const first = s.getWarnings().length;
    s.load();
    assert.equal(s.getWarnings().length, first);
  });

  it("refuses to store anything when secure storage is unavailable", () => {
    // Some Linux desktops have no keyring. Refusing beats silently writing
    // the password in clear text.
    const s = store(fakeCrypto({ isEncryptionAvailable: () => false }));
    s.load();

    assert.equal(s.isAvailable(), false);
    assert.throws(() => s.set(WINLINK_PASSWORD_KEY, "hunter2"), /no secure credential storage/);
    assert.equal(s.has(WINLINK_PASSWORD_KEY), false);
  });

  it("still allows clearing a secret when secure storage is unavailable", () => {
    const s = store(fakeCrypto());
    s.load();
    s.set(WINLINK_PASSWORD_KEY, "hunter2");

    const broken = store(fakeCrypto({ isEncryptionAvailable: () => false }));
    broken.load();
    broken.set(WINLINK_PASSWORD_KEY, "");
    assert.equal(broken.has(WINLINK_PASSWORD_KEY), false);
  });

  it("treats an availability check that throws as unavailable", () => {
    const s = store(
      fakeCrypto({
        isEncryptionAvailable: () => {
          throw new Error("dbus is not running");
        },
      }),
    );
    assert.equal(s.isAvailable(), false);
  });

  it("starts empty, without warning, when no file exists", () => {
    const warnings: string[] = [];
    const s = store(fakeCrypto(), (m) => warnings.push(m));
    s.load();

    assert.deepEqual(warnings, []);
    assert.equal(s.has(WINLINK_PASSWORD_KEY), false);
  });

  it("recovers from a corrupt credential file", () => {
    writeFileSync(file, "not json at all");

    const warnings: string[] = [];
    const s = store(fakeCrypto(), (m) => warnings.push(m));
    s.load();

    assert.match(warnings.join(" "), /Could not read stored credentials/);
    assert.equal(s.has(WINLINK_PASSWORD_KEY), false);
    s.set(WINLINK_PASSWORD_KEY, "hunter2");
    assert.equal(s.get(WINLINK_PASSWORD_KEY), "hunter2");
  });

  it("ignores non-string entries in the credential file", () => {
    writeFileSync(file, JSON.stringify({ [WINLINK_PASSWORD_KEY]: { not: "a blob" } }));
    const s = store(fakeCrypto());
    s.load();
    assert.equal(s.has(WINLINK_PASSWORD_KEY), false);
  });
});
