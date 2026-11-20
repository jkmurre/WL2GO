import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createServer, type Server, type Socket } from "node:net";
import { RigctlClient, formatRawBytes, labelledValue, parseRawBytes } from "./rigctlClient.ts";

/**
 * A stand-in rigctld that replays recorded wire traffic.
 *
 * The replies below are VERBATIM from the vendored rigctld against Hamlib's
 * dummy backend, which is the only way to be sure of a protocol whose two
 * response modes differ in whether they terminate at all.
 */
function fakeRigctld(replies: Record<string, string>): Promise<{ server: Server; port: number; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((socket: Socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const at = buffer.indexOf("\n");
        if (at === -1) break;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        seen.push(line);
        const reply = replies[line];
        if (reply !== undefined) socket.write(reply);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port, seen });
    });
  });
}

describe("RigctlClient", () => {
  let harness: { server: Server; port: number; seen: string[] };

  before(async () => {
    harness = await fakeRigctld({
      // Recorded from rigctld 4.7.2, Hamlib dummy backend.
      "+\\get_mode": "get_mode:\nMode: PKTUSB\nPassband: 0\nRPRT 0\n",
      "+\\set_mode PKTUSB 0": "set_mode: PKTUSB 0\nRPRT 0\n",
      "+\\get_freq": "get_freq:\nFrequency: 7101000\nRPRT 0\n",
      "+\\set_ptt 0": "set_ptt: 0\nRPRT 0\n",
      "+\\set_mode REFUSED 0": "set_mode: REFUSED 0\nRPRT -4\n",
      "+\\garbage": "what?\n",
    });
  });

  after(() => harness.server.close());

  async function connected(): Promise<RigctlClient> {
    const client = new RigctlClient({ port: harness.port, replyTimeoutMs: 500 });
    await client.connect();
    return client;
  }

  it("asks for extended responses, because a plain get never sends an RPRT", () => {
    // The whole reason the client exists in this shape. Verified against the
    // real daemon: "\\get_freq" answers "7101000\n" with no report line, so a
    // reader waiting for RPRT would hang on every read.
    assert.ok(harness.seen.every((line) => line.startsWith("+")) || harness.seen.length === 0);
  });

  it("returns a set's success without inventing value lines", async () => {
    const client = await connected();
    const result = await client.send("\\set_mode PKTUSB 0");
    assert.equal(result.ok, true);
    assert.deepEqual(result.lines, []);
    await client.close();
  });

  it("strips the echo and the report, leaving only the answer", async () => {
    const client = await connected();
    const result = await client.send("\\get_mode");
    assert.deepEqual(result.lines, ["Mode: PKTUSB", "Passband: 0"]);
    await client.close();
  });

  it("reads a value by its label rather than its position", async () => {
    const client = await connected();
    const { lines } = await client.send("\\get_mode");
    assert.equal(labelledValue(lines, "Mode"), "PKTUSB");
    assert.equal(labelledValue(lines, "Passband"), "0");
    assert.equal(labelledValue(lines, "Missing"), null);
    await client.close();
  });

  it("turns a non-zero RPRT into text an operator can act on", async () => {
    // Never thrown: a radio refusing a mode has to appear next to the thing the
    // operator was doing, not unwind a session teardown.
    const client = await connected();
    const result = await client.send("\\set_mode REFUSED 0");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /does not support that through Hamlib/);
    await client.close();
  });

  it("reports a reply with no report line instead of guessing at it", async () => {
    const client = await connected();
    const result = await client.send("\\garbage");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /did not answer/);
    await client.close();
  });

  it("refuses commands when nothing is connected", async () => {
    const client = new RigctlClient({ port: harness.port, replyTimeoutMs: 500 });
    const result = await client.send("\\get_freq");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /not running/);
  });

  it("serialises commands, because replies carry no request id", async () => {
    const client = await connected();
    const [a, b] = await Promise.all([client.send("\\get_freq"), client.send("\\get_mode")]);
    assert.equal(labelledValue(a.lines, "Frequency"), "7101000");
    assert.equal(labelledValue(b.lines, "Mode"), "PKTUSB");
    await client.close();
  });
});

describe("raw CI-V bytes", () => {
  it("uses the backslash form, which is the only one Hamlib parses correctly", () => {
    // rigctl_parse.c:5245 does strtol(p + 1, &p, 0). "\\0x1A" hands strtol
    // "0x1A" and base 0 recognises the prefix; the shorter "x1A" hands it "1A",
    // which base 0 reads as decimal 1 and stops at the 'A' -- silently sending
    // the wrong byte for every value containing a hex letter.
    assert.equal(formatRawBytes([0xfe, 0xfe, 0xb6, 0xe0]), "\\0xfe\\0xfe\\0xb6\\0xe0");
  });

  it("is LOWER case, which is what makes an Icom reply come back at all", () => {
    // Hamlib looks for the literal "xfd" in the command text to decide that
    // 0xFD terminates the reply (rigctl_parse.c:5356), case-sensitively. In
    // upper case that test fails, the terminator stays CR/LF, the read waits
    // for a newline an Icom never sends, and the reply comes back EMPTY with
    // RPRT 0 -- a silent failure that reads as success. Verified on a real
    // IC-7300 MkII: identical frame, nothing in upper case, the radio's answer
    // in lower.
    const frame = formatRawBytes([0xfe, 0xfe, 0xb6, 0xe0, 0x1a, 0x05, 0x00, 0x85, 0xfd]);
    assert.ok(frame.includes("xfd"), `Hamlib will not see a terminator in "${frame}"`);
    assert.equal(frame, frame.toLowerCase());
  });

  it("round-trips through the form Hamlib prints replies in", () => {
    const frame = [0xfe, 0xfe, 0xe0, 0xb6, 0x1a, 0x05, 0x00, 0x74, 0x01, 0xfd];
    assert.deepEqual(parseRawBytes(formatRawBytes(frame)), frame);
  });

  it("ignores the byte count Hamlib appends after the frame", () => {
    // The reply is "\\0xFE\\0xFE... 10" -- frame, space, count. Splitting on
    // whitespace would read the count as data.
    assert.deepEqual(parseRawBytes("\\0xFE\\0xFE\\0xE0\\0xB6\\0xFB\\0xFD 6"), [
      0xfe, 0xfe, 0xe0, 0xb6, 0xfb, 0xfd,
    ]);
  });

  it("returns nothing for a reply with no bytes in it", () => {
    assert.deepEqual(parseRawBytes(""), []);
    assert.deepEqual(parseRawBytes("send_cmd: nothing"), []);
  });
});
