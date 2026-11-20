import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PatEventStream, type EventSocket } from "./patEventStream.ts";
import type { PatPrompt } from "../../shared/ipcContract.ts";
import type { PatWsEvent } from "./patWsProtocol.ts";

/** A socket we drive by hand, standing in for Pat. */
class FakeSocket implements EventSocket {
  sent: string[] = [];
  closed = false;
  private openListener: (() => void) | null = null;
  private messageListener: ((data: string) => void) | null = null;
  private closeListener: (() => void) | null = null;
  private errorListener: ((err: Error) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  onOpen(listener: () => void): void {
    this.openListener = listener;
  }
  onMessage(listener: (data: string) => void): void {
    this.messageListener = listener;
  }
  onClose(listener: () => void): void {
    this.closeListener = listener;
  }
  onError(listener: (err: Error) => void): void {
    this.errorListener = listener;
  }

  // --- driven by the test ---
  emitOpen(): void {
    this.openListener?.();
  }
  emitMessage(value: unknown): void {
    this.messageListener?.(typeof value === "string" ? value : JSON.stringify(value));
  }
  emitClose(): void {
    this.closeListener?.();
  }
  emitError(): void {
    this.errorListener?.(new Error("boom"));
  }
  /** What was sent, parsed. */
  parsed(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

interface Harness {
  stream: PatEventStream;
  sockets: FakeSocket[];
  events: PatWsEvent[];
  unanswered: PatPrompt[];
  attachedChanges: boolean[];
  latest: () => FakeSocket;
}

function harness(password: string | null = null): Harness {
  const sockets: FakeSocket[] = [];
  const events: PatWsEvent[] = [];
  const unanswered: PatPrompt[] = [];
  const attachedChanges: boolean[] = [];

  const stream = new PatEventStream({
    url: "ws://127.0.0.1:17812/ws",
    getPassword: () => password,
    onEvent: (e) => events.push(e),
    onPromptUnanswered: (p) => unanswered.push(p),
    onAttachedChange: (a) => attachedChanges.push(a),
    minRetryMs: 1,
    maxRetryMs: 4,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });

  return { stream, sockets, events, unanswered, attachedChanges, latest: () => sockets[sockets.length - 1]! };
}

describe("PatEventStream: keepalive", () => {
  it("answers Pat's ping, which is what keeps the session alive", () => {
    // Without this Pat drops the client after KeepaliveInterval + 10s -- which
    // passes every short test and then fails mid-transfer.
    const h = harness();
    h.stream.start();
    h.latest().emitOpen();
    h.latest().emitMessage({ Ping: true });

    assert.deepEqual(h.latest().parsed(), [{ Pong: true }]);
  });

  it("does not surface the ping as an application event", () => {
    const h = harness();
    h.stream.start();
    h.latest().emitOpen();
    h.latest().emitMessage({ Ping: true });

    assert.deepEqual(h.events, []);
  });
});

describe("PatEventStream: prompts", () => {
  it("answers a password challenge from the keychain without asking", () => {
    const h = harness("hunter2");
    h.stream.start();
    h.latest().emitOpen();
    h.latest().emitMessage({ Prompt: { id: "p1", kind: "password", message: "Enter password" } });

    assert.deepEqual(h.latest().parsed(), [{ prompt_response: { id: "p1", value: "hunter2" } }]);
    assert.deepEqual(h.unanswered, [], "the operator should not be bothered");
  });

  it("asks the operator when no password is stored", () => {
    const h = harness(null);
    h.stream.start();
    h.latest().emitOpen();
    h.latest().emitMessage({ Prompt: { id: "p1", kind: "password", message: "Enter password" } });

    assert.equal(h.latest().sent.length, 0, "nothing may be sent until the operator answers");
    assert.equal(h.unanswered.length, 1);
    assert.equal(h.unanswered[0]?.id, "p1");
  });

  it("always asks the operator about account activation", () => {
    // This is Winlink asking whether the account exists; only a human knows.
    const h = harness("hunter2");
    h.stream.start();
    h.latest().emitOpen();
    h.latest().emitMessage({ Prompt: { id: "p2", kind: "pre-account-activation", message: "Activate?" } });

    assert.equal(h.unanswered.length, 1);
    assert.equal(h.latest().sent.length, 0);
  });

  it("sends the operator's answer with the right id", () => {
    const h = harness(null);
    h.stream.start();
    h.latest().emitOpen();
    h.latest().emitMessage({ Prompt: { id: "p1", kind: "password", message: "" } });

    h.stream.respond("p1", "typed-by-hand");
    assert.deepEqual(h.latest().parsed(), [{ prompt_response: { id: "p1", value: "typed-by-hand" } }]);
    assert.deepEqual(h.stream.pendingPrompts(), [], "answering clears it");
  });

  it("drops a prompt Pat withdrew", () => {
    // PromptAbort means it timed out or was answered elsewhere; a late answer
    // would be applied to nothing.
    const h = harness(null);
    h.stream.start();
    h.latest().emitOpen();
    h.latest().emitMessage({ Prompt: { id: "p1", kind: "password", message: "" } });
    assert.equal(h.stream.pendingPrompts().length, 1);

    h.latest().emitMessage({ PromptAbort: { id: "p1", kind: "password", message: "" } });
    assert.deepEqual(h.stream.pendingPrompts(), []);
  });

  it("keeps unanswered prompts so a reopened window can show them", () => {
    const h = harness(null);
    h.stream.start();
    h.latest().emitOpen();
    h.latest().emitMessage({ Prompt: { id: "p1", kind: "password", message: "Need it" } });

    assert.equal(h.stream.pendingPrompts()[0]?.message, "Need it");
  });
});

describe("PatEventStream: attachment and reconnection", () => {
  it("reports attachment only once the socket opens", () => {
    const h = harness();
    h.stream.start();
    assert.equal(h.stream.isAttached(), false, "constructing a socket is not being attached");

    h.latest().emitOpen();
    assert.equal(h.stream.isAttached(), true);
    assert.deepEqual(h.attachedChanges, [true]);
  });

  it("detaches and reconnects when Pat restarts", async () => {
    // Pat is restarted whenever the station identity changes, so this is
    // routine rather than exceptional.
    const h = harness();
    h.stream.start();
    h.latest().emitOpen();
    h.latest().emitClose();

    assert.equal(h.stream.isAttached(), false);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(h.sockets.length >= 2, "a new socket should have been opened");

    h.latest().emitOpen();
    assert.equal(h.stream.isAttached(), true);
    h.stream.stop();
  });

  it("does not queue two reconnects when an error precedes the close", async () => {
    const h = harness();
    h.stream.start();
    h.latest().emitOpen();
    h.latest().emitError();
    h.latest().emitClose();

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.sockets.length, 2, "one retry, not one per event");
    h.stream.stop();
  });

  it("stops retrying once stopped", async () => {
    const h = harness();
    h.stream.start();
    h.latest().emitOpen();
    h.stream.stop();
    h.latest().emitClose();

    const count = h.sockets.length;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.sockets.length, count);
  });

  it("survives a runtime with no WebSocket at all", async () => {
    // If the global is absent the factory throws. The app must report "not
    // attached" and keep running rather than crash on startup.
    const logs: string[] = [];
    const stream = new PatEventStream({
      url: "ws://127.0.0.1:17812/ws",
      getPassword: () => null,
      onEvent: () => {},
      onPromptUnanswered: () => {},
      onAttachedChange: () => {},
      onLog: (m) => logs.push(m),
      minRetryMs: 1,
      maxRetryMs: 2,
      socketFactory: () => {
        throw new Error("WebSocket is not defined");
      },
    });

    assert.doesNotThrow(() => stream.start());
    assert.equal(stream.isAttached(), false);
    assert.match(logs.join(" "), /Could not open the event stream/);
    stream.stop();
  });
});

describe("PatEventStream: events", () => {
  it("forwards status, progress, notifications and log lines", () => {
    const h = harness();
    h.stream.start();
    h.latest().emitOpen();

    h.latest().emitMessage({ Status: { connected: true, dialing: false, remote_addr: "cms" } });
    h.latest().emitMessage({ Progress: { bytes_transferred: 1, bytes_total: 2, mid: "M", subject: "S" } });
    h.latest().emitMessage({ Notification: { title: "t", body: "b" } });
    h.latest().emitMessage({ LogLine: "hello" });

    assert.deepEqual(h.events.map((e) => e.type), ["status", "progress", "notification", "logLine"]);
  });

  it("ignores frames it does not understand", () => {
    const h = harness();
    h.stream.start();
    h.latest().emitOpen();
    h.latest().emitMessage("not json");
    h.latest().emitMessage({ SomethingNew: {} });

    assert.deepEqual(h.events, []);
  });
});
