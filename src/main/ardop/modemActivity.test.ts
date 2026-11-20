import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModemActivityTracker } from "./modemActivity.ts";
import type { ModemActivity } from "../../shared/ipcContract.ts";

// Every line here is copied verbatim from a real session log (2026-08-27, the
// N0GWY session), so the patterns are tested against what ardopcf actually
// prints rather than what we remember it printing.

function collect(): { events: ModemActivity[]; tracker: ModemActivityTracker } {
  const events: ModemActivity[] = [];
  const tracker = new ModemActivityTracker({ onChange: (activity) => events.push(activity) });
  return { events, tracker };
}

describe("ModemActivityTracker", () => {
  it("follows a transmit through key-up and key-down", () => {
    const { events, tracker } = collect();
    tracker.ingest("[Main.KeyPTT]  PTT-TRUE\n");
    tracker.ingest("Tx Time 490 Time till end = 6\n");
    tracker.ingest("[Main.KeyPTT]  PTT-FALSE\n");
    assert.deepEqual(events, [
      { transmitting: true, rx: "idle" },
      { transmitting: false, rx: "idle" },
    ]);
  });

  it("walks a received control frame from leader lock to good decode", () => {
    const { events, tracker } = collect();
    tracker.ingest("EnvelopeCorrelator CorMax:MaxProd= 60.315159  J= 235\n");
    tracker.ingest("[Acquire2ToneLeaderSymbolFraming] intIatMinError= 0\n");
    tracker.ingest(
      "[Frame Type Decode OK  ] Ldr; S:N(3KHz) Early= -2.257458 dB, Full -2.721899 dB, Offset= -36.241291 Hz:  MD Decode;8 ID=H76, Critical Type=HFF: DataACK, D1= 0.03, D2= 0.01\n"
    );
    assert.deepEqual(events, [
      { transmitting: false, rx: "receiving" },
      { transmitting: false, rx: "good" },
    ]);
  });

  it("reports a failed frame-type decode as bad", () => {
    const { events, tracker } = collect();
    tracker.ingest("EnvelopeCorrelator CorMax:MaxProd= 50.410255  J= 256\n");
    tracker.ingest("poor frame type decode\n");
    assert.deepEqual(events, [
      { transmitting: false, rx: "receiving" },
      { transmitting: false, rx: "bad" },
    ]);
  });

  it("lets a data frame's payload verdict overwrite its header's green", () => {
    const { events, tracker } = collect();
    tracker.ingest("EnvelopeCorrelator CorMax:MaxProd= 59.245972  J= 346\n");
    tracker.ingest(
      "[Frame Type Decode OK  ] Ldr; S:N(3KHz) Early= -4.195110 dB, Full -5.967510 dB, Offset= -36.809311 Hz:  MD Decode;9 ID=H76, Type=H51: 4PSK.500.100.O, D1= 0.02, D2= 0.02\n"
    );
    tracker.ingest("[DecodeFrame] Frame: 4PSK.500.100.O Decode FAIL,  Quality= 43\n");
    assert.deepEqual(
      events.map((e) => e.rx),
      ["receiving", "good", "bad"]
    );
  });

  it("reassembles lines split across chunks", () => {
    const { events, tracker } = collect();
    tracker.ingest("[Main.KeyP");
    tracker.ingest("TT]  PTT-TR");
    tracker.ingest("UE\n");
    assert.deepEqual(events, [{ transmitting: true, rx: "idle" }]);
  });

  it("emits nothing for lines it does not recognise", () => {
    const { events, tracker } = collect();
    tracker.ingest("Input peaks = -13730, 13276\nCommand Trace TO Host BUFFER 108\n");
    assert.equal(events.length, 0);
  });

  it("resets to a dark panel exactly once", () => {
    const { events, tracker } = collect();
    tracker.ingest("[Main.KeyPTT]  PTT-TRUE\nEnvelopeCorrelator CorMax:MaxProd= 60.9  J= 106\n");
    tracker.reset();
    tracker.reset();
    assert.deepEqual(events.at(-1), { transmitting: false, rx: "idle" });
    assert.equal(events.length, 3);
  });

  it("drops a partial line on reset rather than gluing it to the next session", () => {
    const { events, tracker } = collect();
    tracker.ingest("[Main.KeyPTT]  PTT-TR");
    tracker.reset();
    tracker.ingest("UE\n");
    assert.deepEqual(events, []);
  });
});

describe("ModemActivityTracker sign-off and ID events", () => {
  function collectSignOff() {
    const events: string[] = [];
    const tracker = new ModemActivityTracker({
      onChange: () => {},
      onSignOff: () => events.push("sign-off"),
      onIdStart: () => events.push("id-start"),
      onPtt: (on) => events.push(on ? "ptt-on" : "ptt-off"),
    });
    return { events, tracker };
  }

  it("keeps the DISCONNECT trace and the ID lines as separate events", () => {
    // The DISCONNECT trace only requests the close; treating it as "sending
    // station ID" once had the status bar claiming an ID that a teardown race
    // kept off the air. Only the ID lines may say the ID is going out.
    const { events, tracker } = collectSignOff();
    tracker.ingest("18:54:18.170 [Command Trace FROM host: DISCONNECT]\n");
    tracker.ingest("18:54:20.101 [ARDOPC.SendID] SendID  N1CALL:[FN31] ARQ FinalID\n");
    tracker.ingest("18:54:23.871 Sending CW ID of N1CALL\n");
    assert.deepEqual(events, ["sign-off", "id-start", "id-start"]);
  });

  it("does not fire on DISCONNECTED going TO the host", () => {
    // The trailing "]" in the match is what tells the host's DISCONNECT
    // command apart from the modem's DISCONNECTED notification trace.
    const { events, tracker } = collectSignOff();
    tracker.ingest("Command Trace TO Host DISCONNECTED\n");
    tracker.ingest("[Command Trace FROM host: DISCONNECTED IGNORED]\n");
    assert.equal(events.length, 0);
  });

  it("does not mistake SendID's other log lines for an ID", () => {
    // Every line inside SendID() carries the "[ARDOPC.SendID]" logger tag,
    // where a "]" follows the name; only the announcement has "SendID ".
    const { events, tracker } = collectSignOff();
    tracker.ingest("[ARDOPC.SendID] Don't send ID now because SoundIsPlaying\n");
    assert.equal(events.length, 0);
  });

  it("reports every PTT edge in stream order", () => {
    const { events, tracker } = collectSignOff();
    tracker.ingest("[Main.KeyPTT]  PTT-TRUE\n");
    tracker.ingest("[Main.KeyPTT]  PTT-FALSE\n");
    tracker.ingest("[Main.KeyPTT]  PTT-TRUE\n");
    tracker.ingest("[Main.KeyPTT]  PTT-FALSE\n");
    assert.deepEqual(events, ["ptt-on", "ptt-off", "ptt-on", "ptt-off"]);
  });

  it("only requires onChange, so a lights-only construction still works", () => {
    const tracker = new ModemActivityTracker({ onChange: () => {} });
    tracker.ingest("[Command Trace FROM host: DISCONNECT]\n");
    tracker.ingest("Sending CW ID of N1CALL\n");
  });
});
