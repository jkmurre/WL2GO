import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SERVER_SEPARATOR,
  TAG_CURRENT_LEVEL,
  TAG_DRIVE_LEVEL,
  decodeWebguiMessages,
  encodeUvint,
  helloMessage,
  interpretMessage,
} from "./webguiProtocol.ts";

/** One server message, framed the way wg_send_msg does it. */
function framed(type: number, data: number[] = []): number[] {
  const body = [type, SERVER_SEPARATOR, ...data];
  return [...encodeUvint(body.length), ...body];
}

describe("encodeUvint", () => {
  it("matches ardopcf's LEB128 for the sizes this protocol uses", () => {
    // Webgui.c:160-170: seven bits per byte, high bit means "more follows".
    assert.deepEqual(encodeUvint(0), [0x00]);
    assert.deepEqual(encodeUvint(3), [0x03]);
    assert.deepEqual(encodeUvint(127), [0x7f]);
    assert.deepEqual(encodeUvint(128), [0x80, 0x01]);
    assert.deepEqual(encodeUvint(300), [0xac, 0x02]);
  });
});

describe("helloMessage", () => {
  it('is the "0~" the server waits for before sending anything', () => {
    // wg_send_msg returns early while WebGuiNumConnected is 0 (Webgui.c:302),
    // so without this the meter would sit at zero forever and look broken.
    assert.deepEqual(Array.from(helloMessage()), [0x02, 0x30, 0x7e]);
  });
});

describe("decodeWebguiMessages", () => {
  it("reads a receive level", () => {
    const { messages } = decodeWebguiMessages(Uint8Array.from(framed(TAG_CURRENT_LEVEL, [96])));
    assert.deepEqual(messages, [{ type: TAG_CURRENT_LEVEL, data: [96] }]);
  });

  it("reads several messages out of one buffer", () => {
    const bytes = [...framed(TAG_CURRENT_LEVEL, [10]), ...framed(TAG_DRIVE_LEVEL, [60])];
    const { messages, rest } = decodeWebguiMessages(Uint8Array.from(bytes));
    assert.equal(messages.length, 2);
    assert.equal(rest.length, 0);
  });

  it("holds a half-arrived message back instead of guessing at it", () => {
    // ardopcf sends the length header and the body as two SEPARATE WebSocket
    // frames (wg_send_msg calls ws_send twice), so a split mid-message is the
    // normal case rather than an edge one.
    const whole = framed(TAG_CURRENT_LEVEL, [96]);
    const first = decodeWebguiMessages(Uint8Array.from(whole.slice(0, 1)));
    assert.deepEqual(first.messages, []);
    assert.equal(first.desynchronised, null);

    const joined = Uint8Array.from([...first.rest, ...whole.slice(1)]);
    assert.deepEqual(decodeWebguiMessages(joined).messages, [{ type: TAG_CURRENT_LEVEL, data: [96] }]);
  });

  it("returns an empty result for an empty buffer", () => {
    const { messages, rest, desynchronised } = decodeWebguiMessages(new Uint8Array());
    assert.deepEqual(messages, []);
    assert.equal(rest.length, 0);
    assert.equal(desynchronised, null);
  });

  it("stops dead when the separator is wrong rather than resynchronising", () => {
    // ardopcf's own frame-sync guard. A decoder that has lost its place still
    // produces numbers -- plausible ones, from the middle of some other
    // message -- and a meter showing an invented level is worse than a meter
    // that stops and says so.
    const bad = [...encodeUvint(3), TAG_CURRENT_LEVEL, 0x5c, 96];
    const result = decodeWebguiMessages(Uint8Array.from(bad));
    assert.ok(result.desynchronised, "a bad separator must be reported");
    assert.deepEqual(result.messages, []);
  });

  it("keeps the messages it had already read before losing sync", () => {
    const bytes = [...framed(TAG_CURRENT_LEVEL, [42]), ...encodeUvint(3), TAG_DRIVE_LEVEL, 0x00, 60];
    const result = decodeWebguiMessages(Uint8Array.from(bytes));
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].data[0], 42);
    assert.ok(result.desynchronised);
  });

  it("refuses a message too short to carry a type", () => {
    const result = decodeWebguiMessages(Uint8Array.from([...encodeUvint(1), TAG_CURRENT_LEVEL]));
    assert.ok(result.desynchronised);
  });
});

describe("interpretMessage", () => {
  it("names the two readings the tuning window uses", () => {
    assert.deepEqual(interpretMessage({ type: TAG_CURRENT_LEVEL, data: [120] }), {
      kind: "receiveLevel",
      value: 120,
    });
    assert.deepEqual(interpretMessage({ type: TAG_DRIVE_LEVEL, data: [55] }), {
      kind: "driveLevel",
      value: 55,
    });
  });

  it("ignores everything else by tag, without calling it an error", () => {
    // This reads a slice of a much larger protocol. An unrecognised message is
    // ordinary -- a waterfall line, a state change -- and must not be confused
    // with a malformed one.
    assert.equal(interpretMessage({ type: 0x8b, data: [200] }), null);
    assert.equal(interpretMessage({ type: 0x41, data: [1, 2, 3] }), null);
  });

  it("ignores a known tag that arrived with no value", () => {
    assert.equal(interpretMessage({ type: TAG_CURRENT_LEVEL, data: [] }), null);
  });
});
