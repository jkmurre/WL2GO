import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { ArdopWebguiClient, WEBGUI_PROTOCOL_VERSION, webguiVersionRefusal, type WebguiSocket } from "./ardopWebgui.ts";
import { SERVER_SEPARATOR, TAG_CURRENT_LEVEL, TAG_DRIVE_LEVEL, encodeUvint } from "../../shared/webguiProtocol.ts";
import type { WebguiReading } from "../../shared/webguiProtocol.ts";

function framed(type: number, data: number[]): number[] {
  const body = [type, SERVER_SEPARATOR, ...data];
  return [...encodeUvint(body.length), ...body];
}

/** A socket the test drives by hand. */
function fakeSocket() {
  const sent: number[][] = [];
  let open = () => {};
  let binary: (d: Uint8Array) => void = () => {};
  let closed = false;

  const socket: WebguiSocket = {
    send: (data) => sent.push(Array.from(data)),
    close: () => {
      closed = true;
    },
    onOpen: (l) => {
      open = l;
    },
    onBinary: (l) => {
      binary = l;
    },
    onClose: () => {},
    onError: () => {},
  };

  return {
    socket,
    sent,
    fire: {
      open: () => open(),
      binary: (bytes: number[]) => binary(Uint8Array.from(bytes)),
    },
    isClosed: () => closed,
  };
}

describe("webguiVersionRefusal", () => {
  it("accepts the modem this decoder was written against", () => {
    assert.equal(webguiVersionRefusal(WEBGUI_PROTOCOL_VERSION), null);
  });

  it("names both versions when they differ", () => {
    // The protocol carries no handshake of its own, so this is the only place a
    // moved tag can be caught. A silently wrong level is worse than no level.
    const refusal = webguiVersionRefusal("1.0.5.0.0");
    assert.match(String(refusal), /1\.0\.5\.0\.0/);
    assert.match(String(refusal), new RegExp(WEBGUI_PROTOCOL_VERSION.replace(/\./g, "\\.")));
  });

  it("refuses rather than assumes when the version is unknown", () => {
    assert.ok(webguiVersionRefusal(null));
  });

  it("is pinned to the version actually vendored", async () => {
    // Nothing else keeps these in step. Without this test a version bump
    // silently disables the meter with a message that blames the operator's
    // build; with it, the bump fails here and whoever does it has to look at
    // the message tags first.
    const vendored = (
      await readFile(new URL("../../../vendor/ardopcf/ARDOPCF_VERSION", import.meta.url), "utf8")
    ).trim();
    assert.equal(
      WEBGUI_PROTOCOL_VERSION,
      vendored,
      "Bumping ardopcf means re-checking Webgui.c's message tags, then updating this constant.",
    );
  });
});

describe("ArdopWebguiClient", () => {
  it("connects to /ws, which is the only path ardopcf upgrades", () => {
    // Regression. The client dialled the root for its whole life, ardopcf
    // refused the upgrade (Webgui.c:120 calls ws_set_uri("/ws")), and the only
    // symptom was one "Level meter: WebGui socket error" line in the log -- so
    // the meter has never worked and nothing failed loudly enough to say so.
    const urls: string[] = [];
    const fake = fakeSocket();
    new ArdopWebguiClient({
      port: 18701,
      onReading: () => {},
      createSocket: (url) => {
        urls.push(url);
        return fake.socket;
      },
    }).connect();
    assert.deepEqual(urls, ["ws://127.0.0.1:18701/ws"]);
  });

  it("says hello, because the server sends nothing until it does", () => {
    const fake = fakeSocket();
    new ArdopWebguiClient({ port: 18701, onReading: () => {}, createSocket: () => fake.socket }).connect();
    fake.fire.open();
    assert.deepEqual(fake.sent, [[0x02, 0x30, 0x7e]]);
  });

  it("reports receive level and drive level", () => {
    const readings: WebguiReading[] = [];
    const fake = fakeSocket();
    new ArdopWebguiClient({
      port: 18701,
      onReading: (r) => readings.push(r),
      createSocket: () => fake.socket,
    }).connect();

    fake.fire.binary(framed(TAG_CURRENT_LEVEL, [96]));
    fake.fire.binary(framed(TAG_DRIVE_LEVEL, [60]));
    assert.deepEqual(readings, [
      { kind: "receiveLevel", value: 96 },
      { kind: "driveLevel", value: 60 },
    ]);
  });

  it("reassembles a message split across WebSocket frames", () => {
    // Not an edge case: wg_send_msg sends the length header and the body with
    // two separate ws_send calls, so every message arrives split.
    const readings: WebguiReading[] = [];
    const fake = fakeSocket();
    new ArdopWebguiClient({
      port: 18701,
      onReading: (r) => readings.push(r),
      createSocket: () => fake.socket,
    }).connect();

    const whole = framed(TAG_CURRENT_LEVEL, [123]);
    fake.fire.binary(whole.slice(0, 1));
    assert.deepEqual(readings, []);
    fake.fire.binary(whole.slice(1));
    assert.deepEqual(readings, [{ kind: "receiveLevel", value: 123 }]);
  });

  it("ignores messages it does not decode without complaining", () => {
    const readings: WebguiReading[] = [];
    let desync: string | null = null;
    const fake = fakeSocket();
    new ArdopWebguiClient({
      port: 18701,
      onReading: (r) => readings.push(r),
      onDesynchronised: (r) => {
        desync = r;
      },
      createSocket: () => fake.socket,
    }).connect();

    fake.fire.binary(framed(0x8b, [200])); // bandwidth: Module 12's business
    assert.deepEqual(readings, []);
    assert.equal(desync, null);
  });

  it("stops and reports when the stream stops lining up", () => {
    let desync: string | null = null;
    const readings: WebguiReading[] = [];
    const fake = fakeSocket();
    new ArdopWebguiClient({
      port: 18701,
      onReading: (r) => readings.push(r),
      onDesynchronised: (r) => {
        desync = r;
      },
      createSocket: () => fake.socket,
    }).connect();

    fake.fire.binary([...encodeUvint(3), TAG_CURRENT_LEVEL, 0x00, 96]);
    assert.ok(desync, "a lost frame boundary must be reported");
    assert.deepEqual(readings, []);
    assert.equal(fake.isClosed(), true, "the socket must be closed, not resynchronised");
  });

  it("goes quiet after close rather than emitting late readings", () => {
    const readings: WebguiReading[] = [];
    const fake = fakeSocket();
    const client = new ArdopWebguiClient({
      port: 18701,
      onReading: (r) => readings.push(r),
      createSocket: () => fake.socket,
    });
    client.connect();
    client.close();
    fake.fire.binary(framed(TAG_CURRENT_LEVEL, [96]));
    assert.deepEqual(readings, []);
  });

  it("does not reconnect after close", () => {
    // Whatever is on that port later is not necessarily the modem we started.
    let created = 0;
    const fake = fakeSocket();
    const client = new ArdopWebguiClient({
      port: 18701,
      onReading: () => {},
      createSocket: () => {
        created += 1;
        return fake.socket;
      },
    });
    client.connect();
    client.close();
    client.connect();
    assert.equal(created, 1);
  });
});
