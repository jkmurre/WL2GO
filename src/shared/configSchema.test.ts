import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_ARDOP_HOST_PORT,
  DEFAULT_ICOM_AUDIO_PORT,
  DEFAULT_ICOM_CIV_PORT,
  defaultConfig,
  defaultPtt,
  IC7300_CIV_ADDRESS,
  IC7300MK2_CIV_ADDRESS,
  icomPttCommands,
  lanReadinessIssues,
  normaliseHexCommand,
  isFromFuture,
  isValidCallsign,
  isValidGridSquare,
  materialiseProfile,
  migrate,
  newProfileId,
  normaliseCallsign,
  normaliseGridSquare,
  parseConfig,
  validateProfile,
  type LanInterfaceConfig,
  type RadioProfileInput,
} from "./configSchema.ts";

const USB_PROFILE: RadioProfileInput = {
  name: "IC-7300 USB",
  interface: {
    type: "usb",
    usb: {
      serialPort: "/dev/cu.usbserial-1",
      audioInput: { name: "USB Audio CODEC", index: 1, hostApi: "Core Audio" },
      audioOutput: { name: "USB Audio CODEC", index: 1, hostApi: "Core Audio" },
    },
  },
};

describe("callsign and grid validation", () => {
  it("accepts ordinary and portable callsigns", () => {
    for (const call of ["W1AW", "K0ABC", "VE3XYZ", "W1AW/4", "2E0ABC", "VK2ABC/P"]) {
      assert.ok(isValidCallsign(call), `${call} should be valid`);
    }
  });

  it("rejects strings that cannot be callsigns", () => {
    // No digit, no letter, too short, too long, and illegal punctuation.
    for (const call of ["ABCD", "12345", "W1", "WAYTOOLONGCALL", "W1AW!"]) {
      assert.equal(isValidCallsign(call), false, `${call} should be rejected`);
    }
  });

  it("uppercases callsigns on the way in", () => {
    assert.equal(normaliseCallsign("  w1aw/4 "), "W1AW/4");
  });

  it("accepts 4- and 6-character locators", () => {
    assert.ok(isValidGridSquare("FN31"));
    assert.ok(isValidGridSquare("FN31pr"));
    assert.equal(isValidGridSquare("ZZ99"), false);
    assert.equal(isValidGridSquare("FN3"), false);
  });

  it("writes locators with an upper-case field and lower-case subsquare", () => {
    assert.equal(normaliseGridSquare("fn31PR"), "FN31pr");
    assert.equal(normaliseGridSquare("fn31"), "FN31");
  });
});

describe("newProfileId", () => {
  it("does not collide within the same millisecond", () => {
    const ids = new Set([newProfileId(), newProfileId(), newProfileId()]);
    assert.equal(ids.size, 3);
  });
});

describe("validateProfile", () => {
  it("accepts a complete USB profile", () => {
    assert.deepEqual(validateProfile(USB_PROFILE), []);
  });

  it("accepts a USB profile with nothing selected yet", () => {
    // An operator may build a profile before plugging the radio in.
    const errors = validateProfile({
      name: "Unplugged rig",
      interface: { type: "usb", usb: { serialPort: null, audioInput: null, audioOutput: null } },
    });
    assert.deepEqual(errors, []);
  });

  it("requires a name", () => {
    const errors = validateProfile({ ...USB_PROFILE, name: "   " });
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /needs a name/);
  });

  it("requires a host for a LAN profile", () => {
    const errors = validateProfile({
      name: "Flex",
      interface: { type: "lan", lan: { host: "", controlPort: 50001, civPort: 50002, audioPort: 50003, username: "" } },
    });
    assert.match(errors.join(" "), /needs a host/);
  });

  it("rejects out-of-range ports", () => {
    assert.match(
      validateProfile({ ...USB_PROFILE, ardop: { hostPort: 70000 } }).join(" "),
      /between 1 and 65535/,
    );
    assert.match(
      validateProfile({
        name: "Flex",
        interface: { type: "lan", lan: { host: "10.0.0.2", controlPort: 0, civPort: 50002, audioPort: 50003, username: "" } },
      }).join(" "),
      /between 1 and 65535/,
    );
  });
});

describe("parseConfig / PTT", () => {
  it("reads a PTT setting back off disk", () => {
    const { config } = parseConfig({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      profiles: [
        {
          id: "p1",
          name: "IC-7300",
          ptt: { method: "cat", port: "/dev/cu.x", baud: 19200, keyHex: "FEFE94E01C0001FD", unkeyHex: "FEFE94E01C0000FD" },
          interface: { type: "usb", usb: {} },
        },
      ],
    });
    assert.equal(config.profiles[0]!.ptt.method, "cat");
    assert.equal(config.profiles[0]!.ptt.keyHex, "FEFE94E01C0001FD");
  });

  it("normalises a hand-edited hex command rather than passing it on", () => {
    // A config edited by hand is the realistic source of lowercase or spaced
    // hex, and ardopcf would turn either into different bytes without
    // complaining. Normalising on the way in means the file can be untidy and
    // the modem still gets the only form it understands.
    const { config } = parseConfig({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      profiles: [
        {
          id: "p1",
          name: "R",
          ptt: { method: "cat", port: "/dev/cu.x", baud: 19200, keyHex: "fe fe b6 e0 1c 00 01 fd", unkeyHex: "" },
          interface: { type: "usb", usb: {} },
        },
      ],
    });
    assert.equal(config.profiles[0]!.ptt.keyHex, "FEFEB6E01C0001FD");
  });

  it("treats an absent PTT setting as nothing configured, not as an error", () => {
    // A schema 2 file that skipped migration -- a restored backup, a hand-edit.
    // It must load with the operator's radio intact, same allowance the audio
    // selections get for a bare device name.
    const { config, warnings } = parseConfig({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      profiles: [{ id: "p1", name: "R", interface: { type: "usb", usb: {} } }],
    });
    assert.deepEqual(config.profiles[0]!.ptt, defaultPtt());
    assert.deepEqual(warnings, []);
  });

  it("accepts a LAN profile that still has schema 2's single port", () => {
    const { config } = parseConfig({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      profiles: [
        { id: "p1", name: "Net", interface: { type: "lan", lan: { host: "10.0.0.9", port: 50123 } } },
      ],
    });
    const iface = config.profiles[0]!.interface;
    assert.equal(iface.type, "lan");
    assert.equal(iface.type === "lan" ? iface.lan.controlPort : null, 50123);
  });

  it("rewrites a PTT serial path to the callout node on the way to disk", () => {
    // materialiseProfile, not parseConfig: the rewrite belongs on the write
    // path, where the platform is known.
    const profile = materialiseProfile(
      {
        ...USB_PROFILE,
        ptt: { method: "rts", port: "/dev/tty.usbserial-1420", baud: 19200, keyHex: "", unkeyHex: "" },
      },
      "p1",
      "darwin",
    );
    assert.equal(profile.ptt.port, "/dev/cu.usbserial-1420");
  });

  it("leaves the path alone when no platform is supplied", () => {
    // The wizard's review preview runs in the renderer, where `process` does
    // not exist. A preview has nothing to protect.
    const profile = materialiseProfile(
      {
        ...USB_PROFILE,
        ptt: { method: "rts", port: "/dev/tty.usbserial-1420", baud: 19200, keyHex: "", unkeyHex: "" },
      },
      "p1",
    );
    assert.equal(profile.ptt.port, "/dev/tty.usbserial-1420");
  });
});

describe("lanReadinessIssues", () => {
  const lan = (over: Partial<LanInterfaceConfig> = {}): LanInterfaceConfig => ({
    host: "10.0.0.9",
    controlPort: 50001,
    civPort: 50002,
    audioPort: 50003,
    username: "operator",
    ...over,
  });

  it("is satisfied by a complete profile", () => {
    assert.deepEqual(lanReadinessIssues(lan()), []);
  });

  it("names each missing field, so the operator knows which one to fill in", () => {
    assert.deepEqual(lanReadinessIssues(lan({ host: "" })), ["the radio's address"]);
    assert.deepEqual(lanReadinessIssues(lan({ username: "  " })), ["the username"]);
    assert.deepEqual(lanReadinessIssues(lan({ civPort: 0 })), ["the CI-V port"]);
  });

  it("distinguishes the three ports rather than saying 'the port'", () => {
    const issues = lanReadinessIssues(lan({ controlPort: 0, civPort: 0, audioPort: 99999 }));
    assert.deepEqual(issues, ["the control port", "the CI-V port", "the audio port"]);
  });

  it("does NOT block saving an incomplete profile", () => {
    // The distinction this function exists for. Completeness gates CONNECTING;
    // validateProfile gates SAVING, and only rejects a value that cannot mean
    // anything. A half-filled profile must survive a save, exactly as a USB
    // profile for a radio that has not arrived yet does.
    const incomplete = validateProfile({
      name: "7300 over LAN",
      interface: { type: "lan", lan: lan({ username: "" }) },
    });
    assert.deepEqual(incomplete, []);
    assert.ok(lanReadinessIssues(lan({ username: "" })).length > 0);
  });

  it("still refuses to SAVE a malformed port, which is a different thing", () => {
    const malformed = validateProfile({
      name: "Bad",
      interface: { type: "lan", lan: lan({ audioPort: 99999 }) },
    });
    assert.match(malformed.join(" "), /LAN audio port must be between/);
  });
});

describe("normaliseHexCommand", () => {
  // ardopcf parses these as `val = c - 0x30; if (val > 15) val -= 7`
  // (ARDOPCommon.c:259-270). Lowercase and separators do not FAIL there, they
  // produce different bytes -- so a mistyped keystring would reach the radio as
  // a command meaning something else, with no error anywhere. This is the only
  // place that can catch it.
  it("accepts the way CI-V commands are actually written down", () => {
    assert.equal(normaliseHexCommand("FE FE 94 E0 1C 00 01 FD"), "FEFE94E01C0001FD");
    assert.equal(normaliseHexCommand("fefe94e01c0001fd"), "FEFE94E01C0001FD");
    assert.equal(normaliseHexCommand("FE-FE-94-E0"), "FEFE94E0");
    assert.equal(normaliseHexCommand("0xFE 0xFE"), "FEFE");
  });

  it("refuses anything ardopcf would turn into the wrong bytes", () => {
    assert.equal(normaliseHexCommand(""), null);
    assert.equal(normaliseHexCommand("   "), null);
    // Odd length: the last nibble has no partner and would be dropped silently.
    assert.equal(normaliseHexCommand("FEFE9"), null);
    assert.equal(normaliseHexCommand("FEFEZZ"), null);
    assert.equal(normaliseHexCommand("not hex at all"), null);
  });
});

describe("icomPttCommands", () => {
  it("builds the documented pair for each radio's default CI-V address", () => {
    // 0x94 is the IC-7300's default address and 0xB6 the MkII's
    // (Hamlib rigs/icom/icom.c:679-680). 1C 00 is the PTT subcommand.
    assert.deepEqual(icomPttCommands(IC7300_CIV_ADDRESS), {
      keyHex: "FEFE94E01C0001FD",
      unkeyHex: "FEFE94E01C0000FD",
    });
    assert.deepEqual(icomPttCommands(IC7300MK2_CIV_ADDRESS), {
      keyHex: "FEFEB6E01C0001FD",
      unkeyHex: "FEFEB6E01C0000FD",
    });
  });

  it("produces commands the parser accepts", () => {
    // The preset must survive the same check a hand-typed command faces --
    // otherwise the button fills the field with something Save then rejects.
    const { keyHex, unkeyHex } = icomPttCommands(IC7300MK2_CIV_ADDRESS);
    assert.equal(normaliseHexCommand(keyHex), keyHex);
    assert.equal(normaliseHexCommand(unkeyHex), unkeyHex);
  });
});

describe("validateProfile / rig control", () => {
  const RIG = { model: 3094, device: "/dev/cu.usbmodem21101", baud: 19200, port: 4532 };
  const CAT_PTT = {
    method: "cat" as const,
    port: "/dev/cu.usbmodem21101",
    baud: 19200,
    keyHex: "FEFEB6E01C0001FD",
    unkeyHex: "FEFEB6E01C0000FD",
  };

  it("accepts a profile with no rig control at all", () => {
    assert.deepEqual(validateProfile({ ...USB_PROFILE, hamlib: null }), []);
  });

  it("refuses rig control with no model, rather than storing a rig it cannot drive", () => {
    const issues = validateProfile({ ...USB_PROFILE, hamlib: { ...RIG, model: 0 } });
    assert.match(issues.join(" "), /needs a radio model/);
  });

  it("refuses rig control with no CAT port", () => {
    const issues = validateProfile({ ...USB_PROFILE, hamlib: { ...RIG, device: null } });
    assert.match(issues.join(" "), /needs the radio's CAT serial port/);
  });

  it("refuses keying through rig control when there is no rig", () => {
    // Otherwise nothing keys at all: ardopcf hands PTT to its host and Pat has
    // no rig to act on it with, so the radio never transmits and nothing says so.
    const issues = validateProfile({
      ...USB_PROFILE,
      hamlib: null,
      ptt: { ...CAT_PTT, method: "rigctld" },
    });
    assert.match(issues.join(" "), /needs rig control switched on/);
  });

  it("refuses rig control and CAT keying fighting over one serial port", () => {
    // rigctld holds the port for as long as the profile is active, so ardopcf's
    // CAT open fails -- and it reports that as an ordinary startup failure that
    // reads exactly like broken hardware.
    const issues = validateProfile({ ...USB_PROFILE, hamlib: RIG, ptt: CAT_PTT });
    assert.match(issues.join(" "), /cannot both use \/dev\/cu\.usbmodem21101/);
  });

  it("allows CAT keying on a DIFFERENT port from rig control", () => {
    // The IC-7300 MkII exposes two CAT nodes with identical USB metadata, so
    // one rig, two ports is a real configuration -- the rule is about the port,
    // not about rig control being present.
    assert.deepEqual(
      validateProfile({
        ...USB_PROFILE,
        hamlib: RIG,
        ptt: { ...CAT_PTT, port: "/dev/cu.usbmodem21103" },
      }),
      [],
    );
  });

  it("accepts rig control with keying through it", () => {
    assert.deepEqual(
      validateProfile({ ...USB_PROFILE, hamlib: RIG, ptt: { ...CAT_PTT, method: "rigctld" } }),
      [],
    );
  });
});

describe("validateProfile / PTT", () => {
  const withPtt = (ptt: RadioProfileInput["ptt"]): string[] =>
    validateProfile({ ...USB_PROFILE, ptt });

  it("asks nothing of a profile that keys by VOX", () => {
    assert.deepEqual(withPtt(defaultPtt()), []);
  });

  it("refuses a keying method with nothing to key through", () => {
    assert.match(withPtt({ ...defaultPtt(), method: "rts" }).join(" "), /needs a serial port/);
    assert.match(withPtt({ ...defaultPtt(), method: "cat" }).join(" "), /needs a serial port/);
    // "rigctld" needs a RIG, not an address -- it no longer means "-p host:port
    // to ardopcf". See validateProfile / rig control below.
    assert.match(
      withPtt({ ...defaultPtt(), method: "rigctld" }).join(" "),
      /needs rig control switched on/,
    );
  });

  it("refuses a CAT method with no command to send", () => {
    const issues = withPtt({
      method: "cat",
      port: "/dev/cu.usbmodem21101",
      baud: 19200,
      keyHex: "",
      unkeyHex: "FEFEB6E01C0000FD",
    });
    assert.match(issues.join(" "), /key command must be an even number of hex digits/);
    assert.doesNotMatch(issues.join(" "), /unkey command/);
  });

  it("accepts a complete CAT setup", () => {
    const { keyHex, unkeyHex } = icomPttCommands(IC7300MK2_CIV_ADDRESS);
    assert.deepEqual(
      withPtt({ method: "cat", port: "/dev/cu.usbmodem21101", baud: 19200, keyHex, unkeyHex }),
      [],
    );
  });

  it("allows a baud rate past 65535, because 115200 is ordinary", () => {
    // Baud is not a port. An asPort-style range check here would reject a
    // perfectly normal setting.
    assert.deepEqual(withPtt({ ...defaultPtt(), method: "rts", port: "/dev/cu.x", baud: 115200 }), []);
    assert.match(
      withPtt({ ...defaultPtt(), method: "rts", port: "/dev/cu.x", baud: 12 }).join(" "),
      /between 300 and 921600/,
    );
  });

  it("never blocks on hardware simply being absent", () => {
    // The rule the whole schema follows: an operator may build a profile for a
    // radio that is not plugged in yet. Only a self-contradictory setting fails.
    assert.deepEqual(
      validateProfile({
        name: "Not here yet",
        interface: { type: "usb", usb: { serialPort: null, audioInput: null, audioOutput: null } },
        ptt: defaultPtt(),
      }),
      [],
    );
  });
});

describe("materialiseProfile", () => {
  it("fills in the defaults the UI does not supply", () => {
    const profile = materialiseProfile(USB_PROFILE, "p1");
    assert.equal(profile.id, "p1");
    assert.equal(profile.mode, "ardop");
    assert.equal(profile.hamlib, null);
    assert.equal(profile.ardop.hostPort, DEFAULT_ARDOP_HOST_PORT);
  });

  it("trims the name and keeps the chosen interface", () => {
    const profile = materialiseProfile({ ...USB_PROFILE, name: "  Shack rig  " }, "p2");
    assert.equal(profile.name, "Shack rig");
    assert.equal(profile.interface.type, "usb");
  });
});

describe("parseConfig", () => {
  it("returns defaults, with no warnings, for a missing file", () => {
    const { config, warnings } = parseConfig(undefined);
    assert.deepEqual(config, defaultConfig());
    assert.deepEqual(warnings, []);
  });

  it("round-trips a config it produced itself", () => {
    const original = defaultConfig();
    original.station = { callsign: "W1AW", gridSquare: "FN31pr", shareWithWinlink: true };
    original.profiles.push(materialiseProfile(USB_PROFILE, "p1"));
    original.activeProfileId = "p1";

    const { config, warnings } = parseConfig(JSON.parse(JSON.stringify(original)));
    assert.deepEqual(config, original);
    assert.deepEqual(warnings, []);
  });

  it("never throws on junk, and says what it repaired", () => {
    // The failure an operator actually hits: a hand-edited or truncated file.
    const { config, warnings } = parseConfig("not an object");
    assert.deepEqual(config, defaultConfig());
    assert.equal(warnings.length, 1);
  });

  it("clears an invalid callsign rather than storing it", () => {
    const { config, warnings } = parseConfig({ station: { callsign: "NOTACALL" } });
    assert.equal(config.station.callsign, "");
    assert.match(warnings.join(" "), /not a valid callsign/);
  });

  it("drops unreadable profiles but keeps the good ones", () => {
    const { config, warnings } = parseConfig({
      profiles: [{ id: "p1", name: "Good", interface: { type: "usb", usb: {} } }, null, { name: "" }],
    });
    assert.equal(config.profiles.length, 1);
    assert.equal(config.profiles[0]!.name, "Good");
    assert.equal(warnings.filter((w) => /unreadable/.test(w)).length, 2);
  });

  it("re-ids duplicate profiles instead of losing one", () => {
    const { config, warnings } = parseConfig({
      profiles: [
        { id: "same", name: "A", interface: { type: "usb", usb: {} } },
        { id: "same", name: "B", interface: { type: "usb", usb: {} } },
      ],
    });
    assert.equal(config.profiles.length, 2);
    assert.notEqual(config.profiles[0]!.id, config.profiles[1]!.id);
    assert.match(warnings.join(" "), /duplicate id/);
  });

  it("forgets an active profile that no longer exists", () => {
    const { config, warnings } = parseConfig({ profiles: [], activeProfileId: "gone" });
    assert.equal(config.activeProfileId, null);
    assert.match(warnings.join(" "), /no longer exists/);
  });

  it("refuses to reinterpret a file from a newer build", () => {
    const future = { schemaVersion: CONFIG_SCHEMA_VERSION + 1, station: { callsign: "W1AW" }, somethingNew: true };
    const { config, warnings } = parseConfig(future);

    // The version is preserved so the caller can back the file up rather than
    // silently overwriting whatever the newer build wrote.
    assert.equal(config.schemaVersion, CONFIG_SCHEMA_VERSION + 1);
    assert.equal(config.station.callsign, "", "must not adopt fields it does not understand");
    assert.match(warnings.join(" "), /newer version/);
    assert.ok(isFromFuture(future));
  });

  it("normalises a lowercase callsign from a hand-edited file", () => {
    const { config, warnings } = parseConfig({ station: { callsign: "w1aw", gridSquare: "fn31PR" } });
    assert.equal(config.station.callsign, "W1AW");
    assert.equal(config.station.gridSquare, "FN31pr");
    assert.deepEqual(warnings, []);
  });
});

describe("parseConfig device selections", () => {
  it("reads a bare device name even without migration", () => {
    // A hand-edited file or a restored backup can reach parseConfig without
    // passing through migrate. Blanking the operator's device because of the
    // route it took would be a data loss they did not cause.
    const { config } = parseConfig({
      schemaVersion: 2,
      profiles: [
        {
          id: "p1",
          name: "IC-7300",
          interface: { type: "usb", usb: { serialPort: "/dev/cu.usb-1", audioInput: "USB Audio CODEC" } },
        },
      ],
    });
    const iface = config.profiles[0].interface;
    assert.equal(iface.type, "usb");
    assert.ok(iface.type === "usb");
    assert.deepEqual(iface.usb.audioInput, { name: "USB Audio CODEC", index: -1, hostApi: "" });
    assert.equal(iface.usb.audioOutput, null);
  });

  it("keeps a full selection and repairs a nonsense index", () => {
    const { config } = parseConfig({
      schemaVersion: 2,
      profiles: [
        {
          id: "p1",
          name: "IC-7300",
          interface: {
            type: "usb",
            usb: {
              audioInput: { name: "USB Audio CODEC", index: 3, hostApi: "Core Audio" },
              audioOutput: { name: "USB Audio CODEC", index: "not a number" },
            },
          },
        },
      ],
    });
    const iface = config.profiles[0].interface;
    assert.ok(iface.type === "usb");
    assert.deepEqual(iface.usb.audioInput, { name: "USB Audio CODEC", index: 3, hostApi: "Core Audio" });
    // An unusable index degrades to "no tiebreak recorded", not to a real index.
    assert.deepEqual(iface.usb.audioOutput, { name: "USB Audio CODEC", index: -1, hostApi: "" });
  });
});

describe("migrate to schema 5", () => {
  /** A complete schema 4 file: the operator's real profile, before rig control. */
  function v4(over: Record<string, unknown> = {}) {
    return {
      schemaVersion: 4,
      station: { callsign: "N1CALL", gridSquare: "DM41tq", shareWithWinlink: true },
      profiles: [
        {
          id: "p1",
          name: "7300Mk2",
          mode: "ardop",
          ardop: { hostPort: 8515 },
          hamlib: null,
          ptt: { method: "cat", port: "/dev/cu.usbmodem21101", baud: 19200, keyHex: "FEFEB6E01C0001FD", unkeyHex: "FEFEB6E01C0000FD" },
          driveLevel: 100,
          interface: {
            type: "usb",
            usb: {
              serialPort: "/dev/cu.usbmodem21101",
              audioInput: { name: "USB Audio Device", index: 1, hostApi: "Core Audio" },
              audioOutput: { name: "USB Audio Device", index: 1, hostApi: "Core Audio" },
            },
          },
        },
      ],
      activeProfileId: "p1",
      ...over,
    };
  }

  function profilesOf(raw: unknown): Array<Record<string, unknown>> {
    return ((raw as Record<string, unknown>)["profiles"] as Array<Record<string, unknown>>) ?? [];
  }

  it("adds rig control switched OFF, so nothing about an existing profile changes", () => {
    // The migration must not opt anyone into rig control. Until the operator
    // picks a model, WL2GO keeps its hands off the VFO exactly as before -- a
    // migration that started tuning radios by itself is not one anybody could
    // trust.
    const migrated = migrate(v4(), "darwin");
    assert.equal((migrated as Record<string, unknown>)["schemaVersion"], CONFIG_SCHEMA_VERSION);
    assert.equal(profilesOf(migrated)[0]["hamlib"], null);
    assert.equal(profilesOf(migrated)[0]["txMode"], "auto");
  });

  it("leaves everything else in the profile exactly as it was", () => {
    const before = v4();
    const after = profilesOf(migrate(before, "darwin"))[0];
    const { txMode: _tx, ...rest } = after;
    void _tx;
    assert.deepEqual(rest, before.profiles[0]);
  });

  it("keeps rig control that is already there", () => {
    const hamlib = { model: 3094, device: "/dev/cu.usbmodem21101", baud: 19200, port: 4532 };
    const migrated = migrate(
      v4({ profiles: [{ ...v4().profiles[0], hamlib, txMode: "lsb-data" }] }),
      "darwin",
    );
    assert.deepEqual(profilesOf(migrated)[0]["hamlib"], hamlib);
    assert.equal(profilesOf(migrated)[0]["txMode"], "lsb-data");
  });

  it("discards rig control with no usable model rather than half-configuring it", () => {
    // Pat refuses to dial at all when ardop.rig names a rig that failed to load
    // (app/connect.go:315), so a profile claiming a rig it cannot drive would
    // break sessions that worked before.
    for (const bad of [{ model: 0 }, { model: "IC-7300" }, {}, "yes"]) {
      const migrated = migrate(v4({ profiles: [{ ...v4().profiles[0], hamlib: bad }] }), "darwin");
      assert.equal(profilesOf(migrated)[0]["hamlib"], null, JSON.stringify(bad));
    }
  });

  it("replaces an unrecognised transmit mode with auto", () => {
    const migrated = migrate(v4({ profiles: [{ ...v4().profiles[0], txMode: "fm" }] }), "darwin");
    assert.equal(profilesOf(migrated)[0]["txMode"], "auto");
  });

  it("leaves an unreadable profiles list alone so parseConfig can report it", () => {
    const migrated = migrate({ schemaVersion: 4, profiles: "not a list" }, "darwin") as Record<string, unknown>;
    assert.equal(migrated["schemaVersion"], CONFIG_SCHEMA_VERSION);
    assert.equal(migrated["profiles"], "not a list");
  });
});

describe("migrate to schema 6", () => {
  it("adds diagnostics with recording OFF, including for a file that always recorded", () => {
    // Before schema 6 recording was always on (opt-out env var) -- the
    // debugging posture of a project still chasing audio bugs. Quiet is now
    // the deliberate default; the switch lives in Settings > Diagnostics.
    const migrated = migrate({ schemaVersion: 5, station: { callsign: "N1CALL" } }, "darwin") as Record<
      string,
      unknown
    >;
    assert.equal(migrated["schemaVersion"], 6);
    assert.deepEqual(migrated["diagnostics"], { recordRxAudio: false });
  });

  it("keeps a diagnostics section that is already there", () => {
    // A file written by a newer build and moved aside, or a hand-edit, wins.
    const migrated = migrate(
      { schemaVersion: 5, diagnostics: { recordRxAudio: true } },
      "darwin",
    ) as Record<string, unknown>;
    assert.deepEqual(migrated["diagnostics"], { recordRxAudio: true });
  });
});

describe("parseConfig diagnostics", () => {
  it("defaults to not recording, and only an explicit true turns it on", () => {
    assert.equal(parseConfig({ schemaVersion: 6 }).config.diagnostics.recordRxAudio, false);
    assert.equal(
      parseConfig({ schemaVersion: 6, diagnostics: { recordRxAudio: true } }).config.diagnostics.recordRxAudio,
      true,
    );
  });

  it("heals a mangled diagnostics value to off rather than warning about it", () => {
    // Recording costs disk for as long as nobody notices it; anything
    // unreadable must fail quiet.
    for (const bad of ["yes", 1, { recordRxAudio: "true" }, null, []]) {
      const { config } = parseConfig({ schemaVersion: 6, diagnostics: bad });
      assert.equal(config.diagnostics.recordRxAudio, false, JSON.stringify(bad));
    }
  });
});

describe("migrate to schema 4", () => {
  /** The shape a schema 3 file has: ptt present, no drive level. */
  function v3(over: Record<string, unknown> = {}) {
    return {
      schemaVersion: 3,
      station: { callsign: "M0ABC", gridSquare: "IO91", shareWithWinlink: true },
      profiles: [
        {
          id: "p1",
          name: "IC-7300 MkII",
          mode: "ardop",
          ardop: { hostPort: 8515 },
          hamlib: null,
          ptt: { method: "cat", port: "/dev/cu.usbmodem21101", baud: 19200, keyHex: "FEFEB6E01C0001FD", unkeyHex: "FEFEB6E01C0000FD" },
          interface: {
            type: "usb",
            usb: {
              serialPort: "/dev/cu.usbmodem21101",
              audioInput: { name: "USB Audio CODEC", index: 1, hostApi: "Core Audio" },
              audioOutput: { name: "USB Audio CODEC", index: 2, hostApi: "Core Audio" },
            },
          },
        },
      ],
      activeProfileId: "p1",
      ...over,
    };
  }

  function profilesOf(raw: unknown): Array<Record<string, unknown>> {
    return ((raw as Record<string, unknown>)["profiles"] as Array<Record<string, unknown>>) ?? [];
  }

  it("gives every profile ardopcf's own default rather than a quieter guess", () => {
    // 100 is what ardopcf uses when nothing sets DRIVELEVEL (ARDOPC.c:105).
    // A lower default here would be safer on the air but would change what the
    // transmitter does on the first launch after an update without asking, and
    // a migration nobody can predict is a migration nobody can trust.
    const migrated = migrate(v3(), "darwin");
    // A v3 file now chains 3 -> 4 -> 5, so it lands on the current version.
    assert.equal((migrated as Record<string, unknown>)["schemaVersion"], CONFIG_SCHEMA_VERSION);
    assert.equal(profilesOf(migrated)[0]["driveLevel"], 100);
  });

  it("leaves everything else in the profile exactly as it was", () => {
    // The operator's real profile goes through this. Audio selections and
    // keying moving even slightly would be far worse than the feature being
    // absent.
    const before = v3();
    const after = profilesOf(migrate(before, "darwin"))[0];
    // hamlib and txMode are v5's additions; hamlib was already present as null.
    const { driveLevel: _drive, txMode: _tx, ...rest } = after;
    void _drive;
    void _tx;
    assert.deepEqual(rest, before.profiles[0]);
  });

  it("keeps a drive level that is already there", () => {
    const migrated = migrate(v3({ profiles: [{ ...v3().profiles[0], driveLevel: 55 }] }), "darwin");
    assert.equal(profilesOf(migrated)[0]["driveLevel"], 55);
  });

  it("replaces a drive level that is out of range or the wrong type", () => {
    for (const bad of [250, -5, "loud", null]) {
      const migrated = migrate(v3({ profiles: [{ ...v3().profiles[0], driveLevel: bad }] }), "darwin");
      assert.equal(profilesOf(migrated)[0]["driveLevel"], 100, `driveLevel ${String(bad)}`);
    }
  });

  it("carries a schema 1 file all the way through", () => {
    // The cases chain: 1 -> 2 -> 3 -> 4 -> 5, so an old file lands complete rather
    // than one migration short.
    const migrated = migrate(
      {
        schemaVersion: 1,
        profiles: [
          {
            id: "p1",
            name: "IC-7300",
            interface: { type: "usb", usb: { serialPort: "/dev/tty.usbserial-1420", audioInput: "USB Audio CODEC", audioOutput: "" } },
          },
        ],
      },
      "darwin",
    );
    const profile = profilesOf(migrated)[0];
    assert.equal((migrated as Record<string, unknown>)["schemaVersion"], CONFIG_SCHEMA_VERSION);
    assert.ok(profile["ptt"], "schema 2->3 must still have run");
    assert.equal(profile["driveLevel"], 100);
    assert.equal(profile["txMode"], "auto", "schema 4->5 must still have run");
  });

  it("leaves an unreadable profiles list alone so parseConfig can report it", () => {
    // Same rule as every migration before this: repairing it here would rob the
    // operator of being told their profiles were unreadable.
    const migrated = migrate({ schemaVersion: 3, profiles: "not a list" }, "darwin") as Record<string, unknown>;
    assert.equal(migrated["schemaVersion"], CONFIG_SCHEMA_VERSION);
    assert.equal(migrated["profiles"], "not a list");
  });

  it("loads a hand-edited schema 4 file that omits the drive level", () => {
    const parsed = parseConfig(v3({ schemaVersion: 4 }));
    assert.equal(parsed.config.profiles[0].driveLevel, 100);
  });

  it("loads a file that omits the busy detector level", () => {
    // busyDetLevel is a new field, added after schema 4 -- an existing file,
    // hand-edited or from before this field existed, has none. It must
    // default to ardopcf's own BusyDet (5), the same way driveLevel defaults.
    const parsed = parseConfig(v3({ schemaVersion: 4 }));
    assert.equal(parsed.config.profiles[0].busyDetLevel, 5);
  });

  it("rejects an out-of-range busy detector level, same as drive level", () => {
    const parsed = parseConfig(
      v3({ schemaVersion: 4, profiles: [{ ...v3().profiles[0], busyDetLevel: 11 }] }),
    );
    assert.equal(parsed.config.profiles[0].busyDetLevel, 5);
  });
});

describe("migrate", () => {
  it("stamps the current version onto an unversioned file", () => {
    const migrated = migrate({ station: { callsign: "W1AW" } }, "darwin") as Record<string, unknown>;
    assert.equal(migrated["schemaVersion"], CONFIG_SCHEMA_VERSION);
  });

  it("lifts schema 1's bare device names into a selection", () => {
    // A schema 1 profile stored only a name. There is no index or host API to
    // recover, and -1 records that honestly instead of guessing 0 -- which
    // would be a real index, and probably the wrong one.
    const migrated = migrate(
      {
        schemaVersion: 1,
        profiles: [
          {
            id: "p1",
            name: "IC-7300",
            interface: {
              type: "usb",
              usb: { serialPort: "/dev/tty.usbserial-1420", audioInput: "USB Audio CODEC", audioOutput: "" },
            },
          },
        ],
      },
      "darwin",
    ) as Record<string, unknown>;

    // 3, not 2: the cases chain, so a schema 1 file lands on the current version.
    assert.equal(migrated["schemaVersion"], CONFIG_SCHEMA_VERSION);
    const usb = (migrated["profiles"] as Record<string, never>[])[0]["interface"]["usb"];
    assert.deepEqual(usb["audioInput"], { name: "USB Audio CODEC", index: -1, hostApi: "" });
    // An empty name was "nothing selected", not a device called "".
    assert.equal(usb["audioOutput"], null);
  });

  it("rewrites a schema 1 serial path to the callout node on macOS", () => {
    // Without this the saved port stops matching anything the list offers, so a
    // plugged-in radio reads as "not connected" -- and Module 10 gets handed the
    // tty path the rewrite exists to avoid.
    const migrated = migrate(
      {
        schemaVersion: 1,
        profiles: [
          {
            id: "p1",
            name: "IC-7300",
            interface: { type: "usb", usb: { serialPort: "/dev/tty.usbserial-1420" } },
          },
        ],
      },
      "darwin",
    ) as Record<string, unknown>;

    const usb = (migrated["profiles"] as Record<string, never>[])[0]["interface"]["usb"];
    assert.equal(usb["serialPort"], "/dev/cu.usbserial-1420");
  });

  it("does not invent a callout path off macOS", () => {
    const migrated = migrate(
      {
        schemaVersion: 1,
        profiles: [
          { id: "p1", name: "R", interface: { type: "usb", usb: { serialPort: "/dev/ttyUSB0" } } },
        ],
      },
      "linux",
    ) as Record<string, unknown>;

    const usb = (migrated["profiles"] as Record<string, never>[])[0]["interface"]["usb"];
    assert.equal(usb["serialPort"], "/dev/ttyUSB0");
  });

  it("maps a LAN profile's single port onto the control port, keeping the value", () => {
    // 4532 was a rigctld port, not an Icom one -- but it is what the operator
    // typed, and resetting it to a default would silently undo a deliberate
    // choice. The two new ports get defaults because there is nothing to carry.
    const lan = { type: "lan", lan: { host: "192.168.1.50", port: 4532, username: "op" } };
    const migrated = migrate(
      { schemaVersion: 1, profiles: [{ id: "p1", name: "Flex", interface: lan }] },
      "darwin",
    ) as Record<string, unknown>;

    assert.deepEqual((migrated["profiles"] as Record<string, never>[])[0]["interface"], {
      type: "lan",
      lan: {
        host: "192.168.1.50",
        controlPort: 4532,
        civPort: DEFAULT_ICOM_CIV_PORT,
        audioPort: DEFAULT_ICOM_AUDIO_PORT,
        username: "op",
      },
    });
  });

  it("gives every migrated profile a PTT setting rather than leaving it absent", () => {
    const migrated = migrate(
      { schemaVersion: 2, profiles: [{ id: "p1", name: "IC-7300", interface: { type: "usb", usb: {} } }] },
      "darwin",
    ) as Record<string, unknown>;

    assert.equal(migrated["schemaVersion"], CONFIG_SCHEMA_VERSION);
    assert.deepEqual((migrated["profiles"] as Record<string, never>[])[0]["ptt"], defaultPtt());
  });

  it("does not overwrite a PTT setting that is already there", () => {
    // A file written by a newer build and moved aside, or a hand-edit. Migration
    // fills gaps; it does not get to discard what it does not expect.
    const ptt = { method: "rts", port: "/dev/cu.usbmodem21101", baud: 19200, keyHex: "", unkeyHex: "" };
    const migrated = migrate(
      { schemaVersion: 2, profiles: [{ id: "p1", name: "R", ptt, interface: { type: "usb", usb: {} } }] },
      "darwin",
    ) as Record<string, unknown>;

    assert.deepEqual((migrated["profiles"] as Record<string, never>[])[0]["ptt"], ptt);
  });

  it("survives a schema 1 file with no profiles at all", () => {
    const migrated = migrate({ schemaVersion: 1, station: { callsign: "W1AW" } }, "darwin") as Record<string, unknown>;
    assert.equal(migrated["schemaVersion"], CONFIG_SCHEMA_VERSION);
    assert.deepEqual(migrated["station"], { callsign: "W1AW" });
  });

  it("leaves a malformed profiles value for parseConfig to report", () => {
    // Quietly replacing it with an empty list would repair the file and lose
    // the warning the operator needs to understand what happened to their
    // profiles.
    const migrated = migrate({ schemaVersion: 1, profiles: "nonsense" }, "darwin") as Record<string, unknown>;
    assert.equal(migrated["schemaVersion"], CONFIG_SCHEMA_VERSION);
    assert.equal(migrated["profiles"], "nonsense");
  });

  it("leaves a current-version file untouched", () => {
    const input = { schemaVersion: CONFIG_SCHEMA_VERSION, profiles: [] };
    assert.equal(migrate(input, "darwin"), input);
  });

  it("passes a future-version file through without downgrading it", () => {
    const input = { schemaVersion: CONFIG_SCHEMA_VERSION + 5, profiles: [] };
    assert.equal(migrate(input, "darwin"), input);
    assert.equal(isFromFuture(input), true);
  });
});
