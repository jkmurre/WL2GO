import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ConfigStore } from "./configStore.ts";
import { CONFIG_SCHEMA_VERSION, type RadioProfileInput } from "../../shared/configSchema.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "wl2go-config-"));
  file = path.join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const USB_PROFILE: RadioProfileInput = {
  name: "IC-7300",
  interface: {
    type: "usb",
    usb: {
      serialPort: "/dev/cu.usbserial-1",
      audioInput: { name: "USB Audio CODEC", index: 1, hostApi: "Core Audio" },
      audioOutput: { name: "USB Audio CODEC", index: 1, hostApi: "Core Audio" },
    },
  },
};

function store(onWarning?: (m: string) => void): ConfigStore {
  return new ConfigStore({ filePath: file, onWarning });
}

describe("ConfigStore: first run", () => {
  it("starts on defaults when no file exists, and writes nothing", () => {
    const s = store();
    const config = s.load();

    assert.equal(config.station.callsign, "");
    assert.deepEqual(config.profiles, []);
    assert.deepEqual(s.getWarnings(), [], "a missing file is not a fault");
    assert.equal(readdirSync(dir).length, 0, "load() must not create a file");
  });

  it("creates the file, and its parent directory, on the first save", () => {
    const nested = new ConfigStore({ filePath: path.join(dir, "deep", "nested", "config.json") });
    nested.load();
    nested.setStation({ callsign: "W1AW", gridSquare: "", shareWithWinlink: true });

    assert.equal(JSON.parse(readFileSync(nested.filePath, "utf8")).station.callsign, "W1AW");
  });
});

describe("ConfigStore: persistence", () => {
  it("round-trips station identity across a reload", () => {
    const first = store();
    first.load();
    first.setStation({ callsign: "w1aw", gridSquare: "fn31PR", shareWithWinlink: true });

    const second = store();
    const config = second.load();
    assert.equal(config.station.callsign, "W1AW", "stored normalised, not as typed");
    assert.equal(config.station.gridSquare, "FN31pr");
  });

  it("round-trips a profile across a reload", () => {
    const first = store();
    first.load();
    first.saveProfile(USB_PROFILE);

    const config = store().load();
    assert.equal(config.profiles.length, 1);
    assert.equal(config.profiles[0]!.name, "IC-7300");
    assert.equal(config.profiles[0]!.interface.type, "usb");
  });

  it("leaves no temp file behind", () => {
    const s = store();
    s.load();
    s.setStation({ callsign: "W1AW", gridSquare: "", shareWithWinlink: true });

    assert.deepEqual(readdirSync(dir), ["config.json"]);
  });

  it("writes the config readable only by its owner", () => {
    const s = store();
    s.load();
    s.setStation({ callsign: "W1AW", gridSquare: "", shareWithWinlink: true });

    // Not secret in itself, but it sits beside the credential file and there is
    // no reason for anything else on the machine to read the operator's setup.
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});

describe("ConfigStore: profile CRUD", () => {
  it("makes the first profile active without being asked", () => {
    const s = store();
    s.load();
    const config = s.saveProfile(USB_PROFILE);

    assert.equal(config.activeProfileId, config.profiles[0]!.id);
  });

  it("does not steal the active profile when a second one is added", () => {
    const s = store();
    s.load();
    const first = s.saveProfile(USB_PROFILE).profiles[0]!.id;
    const config = s.saveProfile({ ...USB_PROFILE, name: "FT-891" });

    assert.equal(config.activeProfileId, first);
    assert.equal(config.profiles.length, 2);
  });

  it("updates in place when an id is supplied", () => {
    const s = store();
    s.load();
    const id = s.saveProfile(USB_PROFILE).profiles[0]!.id;

    const config = s.saveProfile({ ...USB_PROFILE, id, name: "Renamed" });
    assert.equal(config.profiles.length, 1);
    assert.equal(config.profiles[0]!.name, "Renamed");
    assert.equal(config.profiles[0]!.id, id);
  });

  it("rejects a save against an id that does not exist", () => {
    const s = store();
    s.load();
    assert.throws(() => s.saveProfile({ ...USB_PROFILE, id: "nope" }), /No radio profile/);
  });

  it("rejects an invalid profile with the validation message", () => {
    const s = store();
    s.load();
    assert.throws(() => s.saveProfile({ ...USB_PROFILE, name: "" }), /needs a name/);
  });

  it("promotes a remaining profile when the active one is deleted", () => {
    const s = store();
    s.load();
    const first = s.saveProfile(USB_PROFILE).profiles[0]!.id;
    s.saveProfile({ ...USB_PROFILE, name: "FT-891" });

    const config = s.deleteProfile(first);
    assert.equal(config.profiles.length, 1);
    assert.equal(config.activeProfileId, config.profiles[0]!.id, "must not leave nothing active");
  });

  it("clears the active profile when the last one is deleted", () => {
    const s = store();
    s.load();
    const id = s.saveProfile(USB_PROFILE).profiles[0]!.id;

    assert.equal(s.deleteProfile(id).activeProfileId, null);
  });

  it("refuses to activate a profile that does not exist", () => {
    const s = store();
    s.load();
    assert.throws(() => s.setActiveProfile("nope"), /No radio profile/);
  });

  it("exposes the active profile object", () => {
    const s = store();
    s.load();
    s.saveProfile(USB_PROFILE);
    assert.equal(s.activeProfile()?.name, "IC-7300");
  });

  it("hands out snapshots that cannot mutate the store", () => {
    const s = store();
    s.load();
    s.saveProfile(USB_PROFILE);

    const snapshot = s.get();
    snapshot.profiles[0]!.name = "tampered";
    assert.equal(s.get().profiles[0]!.name, "IC-7300");
  });
});

describe("ConfigStore: recovery", () => {
  it("survives a corrupt file, keeps a backup, and still saves afterwards", () => {
    writeFileSync(file, "{ this is not json");

    const warnings: string[] = [];
    const s = store((m) => warnings.push(m));
    const config = s.load();

    assert.equal(config.station.callsign, "", "falls back to defaults rather than throwing");
    assert.match(warnings.join(" "), /Could not read/);
    assert.ok(
      readdirSync(dir).some((f) => f.includes(".corrupt.")),
      "the unreadable file must be kept, not destroyed",
    );

    // The whole point of not throwing: the operator can fix it from inside the app.
    s.setStation({ callsign: "W1AW", gridSquare: "", shareWithWinlink: true });
    assert.equal(store().load().station.callsign, "W1AW");
  });

  it("repairs a hand-edited file and reports what it changed", () => {
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, station: { callsign: "lower1" }, profiles: "nope" }));

    const warnings: string[] = [];
    const config = store((m) => warnings.push(m)).load();

    assert.equal(config.station.callsign, "LOWER1");
    assert.deepEqual(config.profiles, []);
    assert.match(warnings.join(" "), /not a list/);
  });

  it("moves aside a file from a newer build instead of overwriting it", () => {
    const future = { schemaVersion: CONFIG_SCHEMA_VERSION + 1, station: { callsign: "W1AW" }, futureField: 42 };
    writeFileSync(file, JSON.stringify(future));

    const warnings: string[] = [];
    const s = store((m) => warnings.push(m));
    const config = s.load();

    assert.match(warnings.join(" "), /newer version/);
    const backup = readdirSync(dir).find((f) => f.includes(".newer."));
    assert.ok(backup, "the newer file must be preserved");
    assert.equal(JSON.parse(readFileSync(path.join(dir, backup), "utf8")).futureField, 42);

    // Having moved it aside, this build owns the path and writes its own version.
    assert.equal(config.schemaVersion, CONFIG_SCHEMA_VERSION);
    s.setStation({ callsign: "K1ABC", gridSquare: "", shareWithWinlink: true });
    assert.equal(JSON.parse(readFileSync(file, "utf8")).schemaVersion, CONFIG_SCHEMA_VERSION);
  });

  it("does not accumulate warnings across reloads", () => {
    writeFileSync(file, JSON.stringify({ station: { callsign: "BAD" } }));
    const s = store();
    s.load();
    const first = s.getWarnings().length;
    s.load();
    assert.equal(s.getWarnings().length, first);
  });
});
