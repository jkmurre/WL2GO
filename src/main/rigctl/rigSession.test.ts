import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RigSession } from "./rigSession.ts";
import type { RigctlClient, RigctlResult } from "./rigctlClient.ts";
import type { RadioProfile, TxMode } from "../../shared/configSchema.ts";
import { hamlibMode } from "../../shared/rigModes.ts";

function profile(over: Partial<RadioProfile> = {}): RadioProfile {
  return {
    id: "p1",
    name: "7300Mk2",
    mode: "ardop",
    ardop: { hostPort: 8515 },
    hamlib: { model: 3094, device: "/dev/cu.usbmodem21101", baud: 19200, port: 4532 },
    txMode: "auto",
    ptt: { method: "rigctld", port: null, baud: 19200, keyHex: "", unkeyHex: "" },
    driveLevel: 100,
    busyDetLevel: 5,
    interface: { type: "usb", usb: { serialPort: null, audioInput: null, audioOutput: null } },
    ...over,
  };
}

const ok = (lines: string[] = []): RigctlResult => ({ ok: true, lines, error: null });
const bad = (error: string): RigctlResult => ({ ok: false, lines: [], error });

/** Records what was sent and replays scripted answers, in order per command. */
function fakeClient(script: Record<string, RigctlResult[]>) {
  const sent: string[] = [];
  const client = {
    send: async (command: string): Promise<RigctlResult> => {
      sent.push(command);
      const queue = script[command];
      if (!queue || queue.length === 0) return bad(`unscripted: ${command}`);
      return queue.length === 1 ? queue[0]! : queue.shift()!;
    },
  } as unknown as RigctlClient;
  return { client, sent };
}

describe("RigSession.prepareForCall", () => {
  it("does nothing at all for a profile without rig control", async () => {
    // The pre-rig-control behaviour, and it has to stay reachable: an operator
    // with a radio Hamlib does not know must still be able to run a session.
    const { client, sent } = fakeClient({});
    const session = new RigSession({ getClient: () => client });
    const result = await session.prepareForCall(profile({ hamlib: null }));
    assert.deepEqual(result, { ok: true, snapshot: null, error: null });
    assert.deepEqual(sent, []);
  });

  it("refuses when rig control is configured but not running", async () => {
    const session = new RigSession({ getClient: () => null });
    const result = await session.prepareForCall(profile());
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /rig control is not running/);
  });

  it("snapshots the mode BEFORE changing it", async () => {
    // A snapshot taken afterwards records our own change, and the restore then
    // leaves the radio in the data mode rather than where the operator had it.
    const { client, sent } = fakeClient({
      "\\get_mode": [ok(["Mode: USB", "Passband: 2400"]), ok(["Mode: PKTUSB", "Passband: 0"])],
      "\\set_mode PKTUSB 0": [ok()],
    });
    const session = new RigSession({ getClient: () => client });
    const result = await session.prepareForCall(profile());
    assert.equal(result.ok, true);
    assert.deepEqual(result.snapshot, { mode: "USB", passband: "2400", dataMod: null });
    assert.equal(sent[0], "\\get_mode");
    assert.equal(sent[1], "\\set_mode PKTUSB 0");
  });

  it("reads the mode back and refuses to transmit if it did not take", async () => {
    // Hamlib answers RPRT 0 for a mode a backend accepted but the radio did not
    // act on -- the dummy backend does exactly that for "\set_mode NOSUCH 0".
    // USB and PKTUSB differ by whether the microphone is live, so an unverified
    // mode change is how someone's voice reaches the transmitter.
    const { client } = fakeClient({
      "\\get_mode": [ok(["Mode: USB", "Passband: 2400"]), ok(["Mode: USB", "Passband: 2400"])],
      "\\set_mode PKTUSB 0": [ok()],
    });
    const session = new RigSession({ getClient: () => client });
    const result = await session.prepareForCall(profile());
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /asked for PKTUSB but reports USB/);
    assert.match(result.error ?? "", /microphone may be live/);
  });

  it("still returns the snapshot when the mode change fails, so it can be put back", async () => {
    const { client } = fakeClient({
      "\\get_mode": [ok(["Mode: USB", "Passband: 2400"])],
      "\\set_mode PKTUSB 0": [bad("the radio rejected the command as invalid")],
    });
    const session = new RigSession({ getClient: () => client });
    const result = await session.prepareForCall(profile());
    assert.equal(result.ok, false);
    assert.deepEqual(result.snapshot, { mode: "USB", passband: "2400", dataMod: null });
  });

  it("reports a radio that stopped answering differently from a wrong mode", async () => {
    const { client } = fakeClient({
      "\\get_mode": [ok(["Mode: USB", "Passband: 2400"]), bad("the radio is not responding on the CAT port")],
      "\\set_mode PKTUSB 0": [ok()],
    });
    const session = new RigSession({ getClient: () => client });
    const result = await session.prepareForCall(profile());
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /did not confirm/);
    assert.match(result.error ?? "", /not responding on the CAT port/);
  });

  it("sends the Hamlib name for every transmit mode the operator can pick", async () => {
    const cases: Array<[TxMode, string]> = [
      ["auto", "PKTUSB"],
      ["usb-data", "PKTUSB"],
      ["lsb-data", "PKTLSB"],
      ["usb", "USB"],
      ["lsb", "LSB"],
    ];
    for (const [txMode, expected] of cases) {
      assert.equal(hamlibMode(txMode), expected, txMode);
      const { client, sent } = fakeClient({
        "\\get_mode": [ok(["Mode: FM", "Passband: 15000"]), ok([`Mode: ${expected}`, "Passband: 0"])],
        [`\\set_mode ${expected} 0`]: [ok()],
      });
      const session = new RigSession({ getClient: () => client });
      const result = await session.prepareForCall(profile({ txMode }));
      assert.equal(result.ok, true, `${txMode}: ${result.error}`);
      assert.ok(sent.includes(`\\set_mode ${expected} 0`), txMode);
    }
  });

  it("never touches the frequency, which is Pat's to set and to put back", async () => {
    // Two owners writing the VFO with no ordering between them would leave the
    // operator on whichever landed last. Pat's qsy() already defers a restore.
    const { client, sent } = fakeClient({
      "\\get_mode": [ok(["Mode: USB", "Passband: 2400"]), ok(["Mode: PKTUSB", "Passband: 0"])],
      "\\set_mode PKTUSB 0": [ok()],
    });
    const session = new RigSession({ getClient: () => client });
    await session.prepareForCall(profile());
    assert.ok(!sent.some((c) => c.includes("freq")), sent.join(", "));
  });
});

describe("RigSession.restore", () => {
  it("puts the mode and passband back", async () => {
    const { client, sent } = fakeClient({ "\\set_mode USB 2400": [ok()] });
    const session = new RigSession({ getClient: () => client });
    await session.restore({ mode: "USB", passband: "2400", dataMod: null });
    assert.deepEqual(sent, ["\\set_mode USB 2400"]);
  });

  it("does nothing when there was nothing to change", async () => {
    const { client, sent } = fakeClient({});
    const session = new RigSession({ getClient: () => client });
    await session.restore(null);
    await session.restore({ mode: "", passband: "0", dataMod: null });
    assert.deepEqual(sent, []);
  });

  it("does not throw when the radio is gone", async () => {
    // Runs in a teardown, after the session's outcome is already decided.
    const { client } = fakeClient({ "\\set_mode USB 2400": [bad("not responding")] });
    const session = new RigSession({ getClient: () => client });
    await session.restore({ mode: "USB", passband: "2400", dataMod: null });
  });
});

describe("RigSession.stopTransmitting", () => {
  it("commands the unkey and says whether it landed", async () => {
    const { client, sent } = fakeClient({ "\\set_ptt 0": [ok()] });
    const session = new RigSession({ getClient: () => client });
    assert.equal(await session.stopTransmitting(), true);
    assert.deepEqual(sent, ["\\set_ptt 0"]);
  });

  it("reports failure rather than pretending the radio stopped", async () => {
    // Under Hamlib keying this is the only thing that stops the carrier, so a
    // caller has to be able to tell that it did not work.
    const { client } = fakeClient({ "\\set_ptt 0": [bad("not responding")] });
    assert.equal(await new RigSession({ getClient: () => client }).stopTransmitting(), false);
    assert.equal(await new RigSession({ getClient: () => null }).stopTransmitting(), false);
  });
});

describe("RigSession.setFrequencyHz", () => {
  it("reads the frequency back and only reports success when it took", async () => {
    // RPRT 0 only says a backend accepted the command. A dial that silently
    // did not move puts the clear-channel listen -- and the call -- on the
    // wrong frequency, which is the exact bug the pre-tune exists to prevent.
    const { client, sent } = fakeClient({
      "\\set_freq 7101500": [ok()],
      "\\get_freq": [ok(["Frequency: 7101500"])],
    });
    const session = new RigSession({ getClient: () => client });
    assert.equal(await session.setFrequencyHz(7_101_500), true);
    assert.deepEqual(sent, ["\\set_freq 7101500", "\\get_freq"]);
  });

  it("reports failure when the radio ended up somewhere else", async () => {
    const logs: string[] = [];
    const { client } = fakeClient({
      "\\set_freq 7101500": [ok()],
      "\\get_freq": [ok(["Frequency: 7000000"])],
    });
    const session = new RigSession({ getClient: () => client, onLog: (m) => logs.push(m) });
    assert.equal(await session.setFrequencyHz(7_101_500), false);
    assert.ok(logs.some((l) => /7000000/.test(l)), logs.join(" | "));
  });

  it("reports failure when the read-back itself fails", async () => {
    const { client } = fakeClient({
      "\\set_freq 7101500": [ok()],
      "\\get_freq": [bad("timeout")],
    });
    const session = new RigSession({ getClient: () => client });
    assert.equal(await session.setFrequencyHz(7_101_500), false);
  });
});

describe("RigSession DATA MOD probe cache", () => {
  // A radio whose menu read fails once is never probed again this run: on
  // such radios the failing \send_cmd_rx is what makes rigctld drop the
  // client connection, so re-probing every session re-kills the freshly
  // healed rig client -- taking the pre-tune and the unkey path with it.
  const CIV_PROFILE = profile({
    // FE FE 94 E0 ... -- the third byte is the radio's CI-V address.
    ptt: { method: "rigctld", port: null, baud: 19200, keyHex: "FEFE94E01C0001FD", unkeyHex: "" },
  });
  const MODE_SCRIPT = {
    "\\get_mode": [ok(["Mode: PKTUSB", "Passband: 0"])],
    "\\set_mode PKTUSB 0": [ok()],
  };

  it("does not repeat a failed probe on the next session", async () => {
    const logs: string[] = [];
    const { client, sent } = fakeClient(MODE_SCRIPT); // \send_cmd_rx unscripted -> fails
    const session = new RigSession({ getClient: () => client, onLog: (m) => logs.push(m) });

    assert.equal((await session.prepareForCall(CIV_PROFILE)).ok, true);
    const probesFirst = sent.filter((c) => c.includes("send_cmd_rx")).length;
    assert.ok(probesFirst > 0, "the first session must probe");
    assert.ok(logs.some((l) => /will not be probed again/.test(l)), logs.join(" | "));

    assert.equal((await session.prepareForCall(CIV_PROFILE)).ok, true);
    const probesSecond = sent.filter((c) => c.includes("send_cmd_rx")).length - probesFirst;
    assert.equal(probesSecond, 0, `re-probed: ${sent.join(", ")}`);
  });
});
