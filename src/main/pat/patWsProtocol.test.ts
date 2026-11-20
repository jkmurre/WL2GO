import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeWsMessage, encodePong, encodePromptResponse } from "./patWsProtocol.ts";

describe("decodeWsMessage", () => {
  it("recognises the keepalive ping", () => {
    // Unanswered, this ends the session after KeepaliveInterval + 10s.
    assert.deepEqual(decodeWsMessage('{"Ping":true}'), { type: "ping" });
  });

  it("decodes a status frame into the same shape as /api/status", () => {
    const frame = JSON.stringify({
      Status: {
        active_listeners: [],
        connected: true,
        dialing: false,
        remote_addr: "cms.winlink.org",
        http_clients: [],
        config_hash: "abc",
      },
    });
    const event = decodeWsMessage(frame);
    assert.equal(event?.type, "status");
    assert.equal(event?.type === "status" && event.status.connected, true);
    assert.equal(event?.type === "status" && event.status.remote_addr, "cms.winlink.org");
  });

  it("decodes transfer progress", () => {
    const frame = JSON.stringify({
      Progress: {
        bytes_transferred: 512,
        bytes_total: 2048,
        mid: "ABC123",
        subject: "Test",
        receiving: true,
        sending: false,
        done: false,
      },
    });
    const event = decodeWsMessage(frame);
    assert.equal(event?.type, "progress");
    assert.equal(event?.type === "progress" && event.progress.bytes_transferred, 512);
    assert.equal(event?.type === "progress" && event.progress.receiving, true);
  });

  it("decodes a notification", () => {
    const event = decodeWsMessage(JSON.stringify({ Notification: { title: "New mail", body: "1 message" } }));
    assert.equal(event?.type, "notification");
    assert.equal(event?.type === "notification" && event.notification.title, "New mail");
  });

  it("decodes a log line", () => {
    const event = decodeWsMessage(JSON.stringify({ LogLine: "Connected to CMS" }));
    assert.equal(event?.type, "logLine");
    assert.equal(event?.type === "logLine" && event.line, "Connected to CMS");
  });

  it("decodes every prompt kind Pat can send", () => {
    for (const kind of [
      "password",
      "multi-select",
      "busy-channel",
      "pre-account-activation",
      "account-activation",
    ]) {
      const event = decodeWsMessage(JSON.stringify({ Prompt: { id: "p1", kind, message: "hi" } }));
      assert.equal(event?.type, "prompt", `kind "${kind}" should decode`);
      assert.equal(event?.type === "prompt" && event.prompt.kind, kind);
    }
  });

  it("decodes multi-select options", () => {
    const frame = JSON.stringify({
      Prompt: {
        id: "p1",
        kind: "multi-select",
        message: "Pick",
        options: [
          { value: "a", desc: "Option A", checked: true },
          { value: "b", checked: false },
        ],
      },
    });
    const event = decodeWsMessage(frame);
    assert.equal(event?.type, "prompt");
    const options = event?.type === "prompt" ? event.prompt.options : undefined;
    assert.equal(options?.length, 2);
    assert.equal(options?.[0]?.checked, true);
    assert.equal(options?.[1]?.desc, undefined);
  });

  it("distinguishes a withdrawn prompt from a new one", () => {
    // Pat sends PromptAbort when a prompt times out; answering it would be wrong.
    const event = decodeWsMessage(JSON.stringify({ PromptAbort: { id: "p1", kind: "password", message: "" } }));
    assert.equal(event?.type, "promptAbort");
    assert.equal(event?.type === "promptAbort" && event.prompt.id, "p1");
  });

  it("rejects a prompt with no id or an unknown kind", () => {
    assert.equal(decodeWsMessage(JSON.stringify({ Prompt: { kind: "password" } })), null);
    assert.equal(decodeWsMessage(JSON.stringify({ Prompt: { id: "p1", kind: "telepathy" } })), null);
  });

  it("returns null for junk instead of throwing", () => {
    // A malformed or unknown frame must not tear down a live session.
    for (const raw of ["not json", "[]", "null", '"a string"', "{}", '{"Unknown":{}}']) {
      assert.equal(decodeWsMessage(raw), null, `"${raw}" should decode to null`);
    }
  });
});

describe("encodePong", () => {
  it("is the shape Pat's read loop looks for", () => {
    // wshub.go checks for the presence of a "Pong" key.
    assert.deepEqual(JSON.parse(encodePong()), { Pong: true });
  });
});

describe("encodePromptResponse", () => {
  it("wraps the answer in prompt_response with the id", () => {
    const parsed = JSON.parse(encodePromptResponse("p1", "hunter2"));
    assert.deepEqual(parsed, { prompt_response: { id: "p1", value: "hunter2" } });
  });

  it("omits the error field entirely", () => {
    // Pat types it as `Err error`, a Go interface that cannot be unmarshalled
    // from JSON; including it risks the whole response failing to decode.
    const parsed = JSON.parse(encodePromptResponse("p1", "x"));
    assert.equal("error" in parsed.prompt_response, false);
    assert.equal("Err" in parsed.prompt_response, false);
  });

  it("can answer with an empty value", () => {
    const parsed = JSON.parse(encodePromptResponse("p1", ""));
    assert.equal(parsed.prompt_response.value, "");
  });
});

describe("decodeWsMessage mailbox events", () => {
  it("decodes the bare mailbox-changed event", () => {
    // No box, no MID, no operation -- Pat sends only the fact that something
    // moved. The whole diff-based sync design follows from this.
    assert.deepEqual(decodeWsMessage(JSON.stringify({ UpdateMailbox: true })), { type: "updateMailbox" });
  });

  it("decodes the callsign Pat announces on connect", () => {
    assert.deepEqual(decodeWsMessage(JSON.stringify({ MyCall: "N1CALL" })), {
      type: "myCall",
      callsign: "N1CALL",
    });
  });

  it("still answers a ping before looking at anything else", () => {
    assert.deepEqual(decodeWsMessage(JSON.stringify({ Ping: true })), { type: "ping" });
  });
});
