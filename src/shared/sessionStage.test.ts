import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConnectionState, PatProgress, SessionStage } from "./ipcContract.ts";
import { canAdvanceTo, describeStage, isSessionBusy, isTerminalStage, stageFromLogLine } from "./sessionStage.ts";

function state(over: Partial<ConnectionState> = {}): ConnectionState {
  return {
    stage: "idle",
    transport: "telnet",
    messagesReceived: null,
    progress: null,
    error: null,
    eventsAttached: true,
    ...over,
  };
}

function progress(over: Partial<PatProgress> = {}): PatProgress {
  return {
    bytes_transferred: 500,
    bytes_total: 1000,
    mid: "ABC123",
    subject: "Net check-in",
    receiving: true,
    sending: false,
    done: false,
    ...over,
  };
}

const ALL: readonly SessionStage[] = [
  "idle",
  "starting-modem",
  "checking-channel",
  "dialing",
  "handshaking",
  "connected",
  "signing-off",
  "sending-id",
  "finished",
  "failed",
];

describe("stageFromLogLine", () => {
  it("reads the two lines Pat logs that actually mark a transition", () => {
    // app/connect.go:181 and app/exchange.go:207.
    assert.equal(stageFromLogLine("Connecting to K0RMS (ardop)..."), "dialing");
    assert.equal(stageFromLogLine("Connected to 10.0.0.1:8772 (tcp)"), "handshaking");
  });

  it("tells those two apart, because they differ by three letters", () => {
    // The whole reason this matches on a prefix rather than on a keyword: a
    // loose test for "connect" would map both onto the same stage and the
    // handshake would never show.
    assert.notEqual(
      stageFromLogLine("Connecting to K0RMS (ardop)..."),
      stageFromLogLine("Connected to 10.0.0.1:8772 (tcp)"),
    );
  });

  it("advances nothing for every other line Pat writes", () => {
    // Pat logs a great deal during a session. Anything not recognised must be
    // inert -- a status display that guesses is worse than one that waits.
    for (const line of [
      "Disconnected.",
      "Exchange failed: context deadline exceeded",
      "ARDOP TNC initialization failed: dial tcp: connection refused",
      "Unable to establish connection to remote: no answer",
      "Waiting for clear channel...",
      "",
      "   ",
      "Reconnecting to the CMS",
    ]) {
      assert.equal(stageFromLogLine(line), null, `should not have matched: ${line}`);
    }
  });

  it("ignores surrounding whitespace, which Pat's log framing adds", () => {
    assert.equal(stageFromLogLine("  Connecting to K0RMS (ardop)...  "), "dialing");
  });
});

describe("canAdvanceTo", () => {
  it("moves forward only", () => {
    assert.equal(canAdvanceTo("dialing", "connected"), true);
    assert.equal(canAdvanceTo("starting-modem", "dialing"), true);
    assert.equal(canAdvanceTo("connected", "dialing"), false);
    assert.equal(canAdvanceTo("handshaking", "starting-modem"), false);
  });

  it("places the RF-only stages where a session actually passes them", () => {
    // The channel check runs between the modem coming up and the dial; the
    // sign-off follows the connected session and precedes the end.
    assert.equal(canAdvanceTo("starting-modem", "checking-channel"), true);
    assert.equal(canAdvanceTo("checking-channel", "dialing"), true);
    assert.equal(canAdvanceTo("dialing", "checking-channel"), false);
    assert.equal(canAdvanceTo("connected", "signing-off"), true);
    assert.equal(canAdvanceTo("signing-off", "connected"), false);
    // The ID may follow the disconnect request OR come straight from
    // connected: the two close branches order the console lines differently.
    assert.equal(canAdvanceTo("signing-off", "sending-id"), true);
    assert.equal(canAdvanceTo("connected", "sending-id"), true);
    assert.equal(canAdvanceTo("sending-id", "signing-off"), false);
  });

  it("refuses to re-enter the stage it is already in", () => {
    for (const stage of ALL) assert.equal(canAdvanceTo(stage, stage), false);
  });

  it("lets a late log line lose a race it would otherwise win", () => {
    // Pat's "Connected to ..." line and its connected:true status frame
    // describe the same instant and arrive in either order. Whichever lands
    // second must not drag the display backwards -- an operator watching a live
    // session appear to un-connect itself would reasonably think it dropped.
    assert.equal(canAdvanceTo("connected", "handshaking"), false);
  });

  it("treats finished and failed as absorbing", () => {
    // A log line arriving after the session ended must never make it look alive
    // again. Pat writes several on its way out.
    for (const stage of ALL) {
      assert.equal(canAdvanceTo("finished", stage), false, `finished -> ${stage}`);
      assert.equal(canAdvanceTo("failed", stage), false, `failed -> ${stage}`);
    }
  });

  it("always allows a terminal stage from a live one", () => {
    // A session can fail from anywhere, including before it dialled.
    for (const stage of [
      "idle",
      "starting-modem",
      "checking-channel",
      "dialing",
      "handshaking",
      "connected",
      "signing-off",
      "sending-id",
    ] as const) {
      assert.equal(canAdvanceTo(stage, "failed"), true, `${stage} -> failed`);
      assert.equal(canAdvanceTo(stage, "finished"), true, `${stage} -> finished`);
    }
  });
});

describe("isSessionBusy", () => {
  it("is true for every stage where something is actually happening", () => {
    for (const stage of [
      "starting-modem",
      "checking-channel",
      "dialing",
      "handshaking",
      "connected",
      "signing-off",
      // Stop must stay available while the CW ID goes out, so this is busy.
      "sending-id",
    ] as const) {
      assert.equal(isSessionBusy(state({ stage })), true, stage);
    }
  });

  it("is false at rest, including after a session ended either way", () => {
    for (const stage of ["idle", "finished", "failed"] as const) {
      assert.equal(isSessionBusy(state({ stage })), false, stage);
    }
    assert.equal(isSessionBusy(null), false);
  });

  it("covers every stage, so a new one cannot be quietly neither", () => {
    for (const stage of ALL) {
      assert.equal(isSessionBusy(state({ stage })), !isTerminalStage(stage) && stage !== "idle", stage);
    }
  });
});

describe("describeStage", () => {
  it("never renders an object, a null or an undefined", () => {
    for (const stage of ALL) {
      const { label } = describeStage(state({ stage, error: null, messagesReceived: null }));
      assert.ok(label.length > 0, stage);
      assert.doesNotMatch(label, /object Object|undefined|null/, stage);
    }
  });

  it("says which stage is stalling, differently for RF than for Telnet", () => {
    // The point of the whole exercise: an operator watching a slow ARDOP
    // connect needs to know whether the modem, the call or the login is stuck.
    assert.match(describeStage(state({ stage: "starting-modem", transport: "ardop" })).label, /modem/i);
    assert.match(describeStage(state({ stage: "dialing", transport: "ardop" })).label, /station/i);
    assert.match(describeStage(state({ stage: "dialing", transport: "telnet" })).label, /Winlink/i);
  });

  it("lets transfer progress outrank the stage", () => {
    // Both describe the same moment; progress is the one that moves.
    const shown = describeStage(state({ stage: "connected", progress: progress() }));
    assert.match(shown.label, /Receiving Net check-in — 50%/);
    assert.equal(shown.tone, "pending");
  });

  it("falls back to the stage once a transfer is done", () => {
    const shown = describeStage(state({ stage: "connected", progress: progress({ done: true }) }));
    assert.equal(shown.label, "Connected");
  });

  it("does not divide by zero on a transfer of unknown size", () => {
    const shown = describeStage(state({ stage: "connected", progress: progress({ bytes_total: 0 }) }));
    assert.equal(shown.label, "Connected");
  });

  it("names the failure rather than saying a session failed", () => {
    const shown = describeStage(state({ stage: "failed", error: "The modem could not open those devices." }));
    assert.equal(shown.tone, "fail");
    assert.equal(shown.label, "The modem could not open those devices.");
  });

  it("claims the station ID only when it is actually being sent", () => {
    // Regression: "signing-off" once said "sending station ID", and a
    // teardown race meant the ID it claimed was never transmitted. Only the
    // stage driven by ardopcf's own SendID lines may say so.
    assert.doesNotMatch(describeStage(state({ stage: "signing-off" })).label, /ID/i);
    assert.match(describeStage(state({ stage: "sending-id" })).label, /station ID/);
  });

  it("counts received messages, singular and plural", () => {
    assert.match(describeStage(state({ stage: "finished", messagesReceived: 1 })).label, /1 new message$/);
    assert.match(describeStage(state({ stage: "finished", messagesReceived: 3 })).label, /3 new messages$/);
    assert.match(describeStage(state({ stage: "finished", messagesReceived: 0 })).label, /no new messages/);
  });

  it("gives a resting state a steady dot and a live one an animated dot", () => {
    assert.equal(describeStage(state({ stage: "idle" })).tone, "idle");
    assert.equal(describeStage(null).tone, "idle");
    assert.equal(describeStage(state({ stage: "dialing" })).tone, "pending");
  });
});
