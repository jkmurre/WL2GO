import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PatConnectionManager,
  TELNET_ALIAS,
  describeConnectFailure,
  type PatConnectionApi,
} from "./patConnectionManager.ts";
import type { ConnectionState } from "../../shared/ipcContract.ts";

interface Harness {
  manager: PatConnectionManager;
  states: ConnectionState[];
  urls: string[];
  disconnects: number;
}

function harness(
  options: {
    callsign?: string;
    attached?: boolean;
    connect?: (url: string) => Promise<{ NumReceived: number }>;
  } = {},
): Harness {
  const states: ConnectionState[] = [];
  const urls: string[] = [];
  let disconnects = 0;

  const api: PatConnectionApi = {
    connect: async (url) => {
      urls.push(url);
      return options.connect ? options.connect(url) : { NumReceived: 0 };
    },
    disconnect: async () => {
      disconnects += 1;
    },
  };

  const manager = new PatConnectionManager({
    getApi: () => api,
    getCallsign: () => options.callsign ?? "N1CALL",
    isEventStreamAttached: () => options.attached ?? true,
    onStateChange: (s) => states.push(s),
  });

  return {
    manager,
    states,
    urls,
    get disconnects() {
      return disconnects;
    },
  };
}

describe("describeConnectFailure over the air", () => {
  // Pat answers every session failure with HTTP 500 "Session failure"
  // (api/api.go:363-365) -- modem unreachable, station silent, login rejected,
  // all identical. What tells them apart is HOW FAR the session got, because
  // each stage is only entered once the previous thing worked.
  const base = { callsign: "W1AW", attached: true, transport: "ardop" as const, modemStarted: true };
  const failure = new Error("Pat API /api/connect returned status 500: Session failure");

  it("blames the modem when Pat could not reach it", () => {
    const described = describeConnectFailure(
      new Error("ARDOP TNC initialization failed: dial tcp 127.0.0.1:8515: connection refused"),
      { ...base, reachedStage: "dialing" },
    );
    assert.match(described, /could not reach the modem/i);
    assert.match(described, /Reset modem/);
  });

  it("says the station did not answer when the session died while dialling", () => {
    const described = describeConnectFailure(failure, { ...base, reachedStage: "dialing" });
    assert.match(described, /did not answer/i);
    assert.match(described, /frequency/i);
  });

  it("blames the password, NOT propagation, once the link came up", () => {
    // The distinction that matters most on the air. Reaching handshaking means
    // the station answered, so the radio path demonstrably works -- telling the
    // operator to check their antenna here would send them the wrong way.
    const described = describeConnectFailure(failure, { ...base, reachedStage: "handshaking" });
    assert.match(described, /Winlink password/);
    assert.match(described, /radio link itself was working/);
  });

  it("reports a mid-session drop as a drop", () => {
    const described = describeConnectFailure(failure, { ...base, reachedStage: "connected" });
    assert.match(described, /dropped part-way/i);
  });

  it("reports a drop during the sign-off stages as a drop, never a refusal", () => {
    // Regression: signing-off and sending-id sit PAST connected, but were
    // missing from the stage switch, so a session that logged in, exchanged
    // traffic, and died during the close fell through to "Winlink refused /
    // check your password" -- seen in the field for a stalled gateway.
    for (const reachedStage of ["signing-off", "sending-id"] as const) {
      const described = describeConnectFailure(failure, { ...base, reachedStage });
      assert.match(described, /dropped part-way/i, reachedStage);
      assert.doesNotMatch(described, /password|refused/i, reachedStage);
    }
  });

  it("describes a session WE ended as disconnected, not diagnosed", () => {
    // Pat wraps a deliberate disconnect in the same failure as any other.
    // Whatever the stage and whatever the wording, our own abort must never
    // come back as advice to check the password.
    const described = describeConnectFailure(failure, {
      ...base,
      reachedStage: "connected",
      aborted: true,
    });
    assert.match(described, /disconnected before the mail exchange completed/i);
  });

  it("says the modem was not running when it was not", () => {
    const described = describeConnectFailure(failure, { ...base, modemStarted: false, reachedStage: "dialing" });
    assert.match(described, /modem was not running/i);
  });

  it("never reports an RF cause for a Telnet session", () => {
    // The two transports share Pat's error string and almost never share a
    // cause. A Telnet failure that mentioned tuning the radio would be absurd.
    const described = describeConnectFailure(failure, {
      callsign: "W1AW",
      attached: true,
      transport: "telnet",
      reachedStage: "dialing",
    });
    assert.doesNotMatch(described, /frequency|station did not answer|modem/i);
    assert.match(described, /Winlink refused the session/);
  });

  it("still puts the setup problems first, before any RF guess", () => {
    // No callsign and no event stream are certainties; an RF cause is an
    // inference. Reporting the inference over the certainty would be wrong.
    assert.match(
      describeConnectFailure(failure, { ...base, callsign: "", reachedStage: "dialing" }),
      /No callsign is set/,
    );
    assert.match(
      describeConnectFailure(failure, { ...base, attached: false, reachedStage: "dialing" }),
      /event stream/,
    );
  });

  it("falls through to the shared causes when the stage says nothing useful", () => {
    const described = describeConnectFailure(new Error("getaddrinfo ENOTFOUND api.winlink.org"), {
      ...base,
      reachedStage: "idle",
    });
    assert.match(described, /no working internet connection/);
  });
});

describe("describeConnectFailure", () => {
  const ok = { callsign: "N1CALL", attached: true };

  it("names a missing callsign before anything else", () => {
    const described = describeConnectFailure(new Error("Session failure"), { callsign: "", attached: true });
    assert.match(described, /No callsign/);
  });

  it("names a detached event stream", () => {
    const described = describeConnectFailure(new Error("Session failure"), { ...ok, attached: false });
    assert.match(described, /event stream/);
  });

  it("distinguishes no internet from a busy CMS", () => {
    assert.match(describeConnectFailure(new Error("getaddrinfo ENOTFOUND cms.winlink.org"), ok), /no working internet/);
    assert.match(describeConnectFailure(new Error("connect ETIMEDOUT"), ok), /did not respond in time/);
  });

  it("names the engine dying separately from Winlink refusing", () => {
    assert.match(describeConnectFailure(new Error("socket hang up"), ok), /protocol engine stopped responding/);
    assert.match(describeConnectFailure(new Error("Session failure"), ok), /refused the session/);
  });

  it("never leaves the operator with Pat's bare wording", () => {
    // The whole point: "Session failure" tells nobody anything.
    const described = describeConnectFailure(new Error("Pat API /api/connect returned status 500: Session failure"), ok);
    assert.notEqual(described.trim(), "Session failure");
    assert.match(described, /callsign|password/i);
  });

  it("passes an unrecognised error through rather than inventing one", () => {
    assert.match(describeConnectFailure(new Error("something odd"), ok), /something odd/);
  });
});

describe("PatConnectionManager", () => {
  it("connects using the telnet alias, letting Pat own the CMS address", async () => {
    const h = harness({ connect: async () => ({ NumReceived: 3 }) });
    const state = await h.manager.connect();

    assert.deepEqual(h.urls, [TELNET_ALIAS]);
    assert.equal(state.stage, "finished");
    assert.equal(state.messagesReceived, 3);
  });

  it("reports connecting before it reports finished", async () => {
    const h = harness();
    await h.manager.connect();
    assert.deepEqual(h.states.map((s) => s.stage), ["dialing", "finished"]);
  });

  it("refuses to connect with no callsign", async () => {
    const h = harness({ callsign: "" });
    await assert.rejects(h.manager.connect(), /No callsign/);
    assert.deepEqual(h.urls, [], "nothing should be attempted");
  });

  it("refuses to connect before the event stream is attached", async () => {
    // Pat prompts before parsing the transport, so connecting unattached hangs
    // for a two-minute timeout and then fails opaquely. Refusing is kinder.
    const h = harness({ attached: false });
    await assert.rejects(h.manager.connect(), /Wait a moment/);
    assert.deepEqual(h.urls, []);
  });

  it("refuses a second session while one is running", async () => {
    let release: () => void = () => {};
    const h = harness({
      connect: async () => {
        await new Promise<void>((r) => { release = r; });
        return { NumReceived: 0 };
      },
    });

    const first = h.manager.connect();
    await assert.rejects(h.manager.connect(), /already in progress/);
    release();
    await first;
  });

  it("classifies a failure instead of surfacing Pat's wording", async () => {
    const h = harness({
      connect: async () => {
        throw new Error("Pat API /api/connect returned status 500: Session failure");
      },
    });
    const state = await h.manager.connect();

    assert.equal(state.stage, "failed");
    assert.match(state.error ?? "", /refused the session/);
  });

  it("does not throw on a failed session, so the UI keeps its state", async () => {
    const h = harness({
      connect: async () => {
        throw new Error("boom");
      },
    });
    await assert.doesNotReject(h.manager.connect());
  });

  it("clears the previous result when a new session starts", async () => {
    const h = harness({ connect: async () => ({ NumReceived: 2 }) });
    await h.manager.connect();

    const second = h.manager.connect();
    const duringSecond = h.states[h.states.length - 1]!;
    assert.equal(duringSecond.messagesReceived, null, "a stale count must not linger");
    await second;
  });

  it("becomes connected when the event stream says so", async () => {
    let release: () => void = () => {};
    const h = harness({
      connect: async () => {
        await new Promise<void>((r) => { release = r; });
        return { NumReceived: 0 };
      },
    });

    const running = h.manager.connect();
    h.manager.applyStatus({
      active_listeners: [],
      connected: true,
      dialing: false,
      remote_addr: "cms.winlink.org",
      http_clients: [],
      config_hash: "x",
    });
    assert.equal(h.manager.getState().stage, "connected");

    release();
    await running;
  });

  it("ignores status and progress when no session is running", () => {
    // Pat pushes status on every client attach; that must not look like a session.
    const h = harness();
    h.manager.applyStatus({
      active_listeners: [],
      connected: true,
      dialing: false,
      remote_addr: "",
      http_clients: [],
      config_hash: "",
    });
    assert.equal(h.manager.getState().stage, "idle");
  });

  it("surfaces transfer progress during a session", async () => {
    let release: () => void = () => {};
    const h = harness({
      connect: async () => {
        await new Promise<void>((r) => { release = r; });
        return { NumReceived: 1 };
      },
    });

    const running = h.manager.connect();
    h.manager.applyProgress({
      bytes_transferred: 100,
      bytes_total: 400,
      mid: "M1",
      subject: "Test",
      receiving: true,
      sending: false,
      done: false,
    });
    assert.equal(h.manager.getState().progress?.bytes_transferred, 100);

    release();
    await running;
    assert.equal(h.manager.getState().progress, null, "progress is cleared when the session ends");
  });

  it("does nothing on disconnect when no session is running", async () => {
    const h = harness();
    await h.manager.disconnect();
    assert.equal(h.disconnects, 0);
  });

  it("aborts a running session on disconnect", async () => {
    let release: () => void = () => {};
    const h = harness({
      connect: async () => {
        await new Promise<void>((r) => { release = r; });
        return { NumReceived: 0 };
      },
    });

    const running = h.manager.connect();
    await h.manager.disconnect();
    assert.equal(h.disconnects, 1);

    // connect() still settles on its own; disconnect must not invent a second
    // completion path that could disagree with Pat.
    release();
    assert.equal((await running).stage, "finished");
  });

  it("describes the failure after its own disconnect as a disconnect", async () => {
    // The field case: operator hits Disconnect on a stalled exchange, Pat
    // gives up dirty and rejects /api/connect with its catch-all. That must
    // read as OUR disconnect, not as Winlink refusing the login.
    let reject: (err: Error) => void = () => {};
    const h = harness({
      connect: async () => new Promise((_r, rj) => { reject = rj; }),
    });

    const running = h.manager.connect();
    await h.manager.disconnect();
    reject(new Error("Pat API /api/connect returned status 500: Session failure"));

    const state = await running;
    assert.equal(state.stage, "failed");
    assert.match(state.error ?? "", /disconnected before the mail exchange completed/i);
    assert.doesNotMatch(state.error ?? "", /password|refused/i);
  });

  it("does not carry a stale abort into the next session's failure", async () => {
    // The flag is per-session: a disconnect yesterday must not soften a real
    // refusal today.
    let fail = false;
    const h = harness({
      connect: async () => {
        if (fail) throw new Error("Pat API /api/connect returned status 500: Session failure");
        return { NumReceived: 0 };
      },
    });

    const first = h.manager.connect();
    await h.manager.disconnect();
    await first;

    fail = true;
    const state = await h.manager.connect();
    assert.equal(state.stage, "failed");
    assert.doesNotMatch(state.error ?? "", /disconnected before/i);
  });
});

describe("PatConnectionManager: failure attribution", () => {
  it("does not blame the event stream when it drops along with the session", async () => {
    // A dying session often takes the socket with it. Re-reading attachment
    // after the fact would mislabel every CMS refusal.
    let attached = true;
    const states: ConnectionState[] = [];
    const manager = new PatConnectionManager({
      getApi: () => ({
        connect: async () => {
          attached = false; // the socket drops as the session fails
          throw new Error("Pat API /api/connect returned status 500: Session failure");
        },
        disconnect: async () => {},
      }),
      getCallsign: () => "N1CALL",
      isEventStreamAttached: () => attached,
      onStateChange: (s) => states.push(s),
    });

    const state = await manager.connect();
    assert.match(state.error ?? "", /refused the session/);
    assert.doesNotMatch(state.error ?? "", /event stream/);
  });
});

describe("sign-off stages and the beforeFinish hold", () => {
  it("holds the finished patch until beforeFinish resolves", async () => {
    // Pat reports the session over up to three seconds BEFORE ardopcf's
    // deferred station ID even starts; beforeFinish is where the RF session
    // waits it out, and "finished" may not appear until it has.
    let release: () => void = () => {};
    const h = harness();
    const running = h.manager.connect("ardop", "ardop:///K0RMS", {
      beforeFinish: () => new Promise<void>((resolve) => (release = resolve)),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(!h.states.some((s) => s.stage === "finished"), "finished before the ID");

    release();
    const state = await running;
    assert.equal(state.stage, "finished");
  });

  it("keeps advancing the sign-off stages while beforeFinish is pending", async () => {
    const h = harness();
    const running = h.manager.connect("ardop", "ardop:///K0RMS", {
      beforeFinish: async () => {
        // The ID lines arrive from the modem console during the hold.
        h.manager.beginSignOff();
        h.manager.beginSendingId();
      },
    });
    h.manager.applyStatus({ connected: true } as Parameters<typeof h.manager.applyStatus>[0]);
    await running;
    const stages = h.states.map((s) => s.stage);
    assert.ok(stages.includes("signing-off"), stages.join(","));
    assert.ok(stages.includes("sending-id"), stages.join(","));
  });

  it("a beforeFinish failure cannot fail a session whose mail succeeded", async () => {
    const h = harness();
    const state = await h.manager.connect("ardop", "ardop:///K0RMS", {
      beforeFinish: async () => {
        throw new Error("watcher bug");
      },
    });
    assert.equal(state.stage, "finished");
  });

  it("beginSendingId advances from connected or signing-off, and from nowhere earlier", async () => {
    const h = harness();
    const running = h.manager.connect("ardop", "ardop:///K0RMS", {
      beforeFinish: async () => {
        h.manager.beginSendingId(); // straight from connected: allowed
      },
    });
    h.manager.applyStatus({ connected: true } as Parameters<typeof h.manager.applyStatus>[0]);
    await running;
    assert.ok(h.states.some((s) => s.stage === "sending-id"));

    // And a stray mid-session ten-minute IDFrame advances nothing: a fresh
    // session that has only dialled must not jump to sending-id.
    const h2 = harness();
    const running2 = h2.manager.connect("ardop", "ardop:///K0RMS", {
      beforeFinish: async () => {
        h2.manager.beginSendingId();
      },
    });
    await running2;
    assert.ok(!h2.states.some((s) => s.stage === "sending-id"));
  });
});
