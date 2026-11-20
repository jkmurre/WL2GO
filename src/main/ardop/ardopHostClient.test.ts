import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer, type Server, type Socket } from "node:net";
import { ArdopHostClient } from "./ardopHostClient.ts";

/**
 * A stand-in for ardopcf's host port, on loopback.
 *
 * A real socket rather than a stub: the thing worth testing here is line
 * framing over a stream, and a stub that hands over whole lines would test
 * nothing -- ardopcf's replies arrive split and coalesced at the transport's
 * convenience, which is exactly where a naive reader goes wrong.
 */
async function fakeModem(respond: (line: string, reply: (text: string) => void) => void) {
  const received: string[] = [];
  let connection: Socket | null = null;

  const server: Server = createServer((socket) => {
    connection = socket;
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const at = buffer.indexOf("\r");
        if (at === -1) break;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        received.push(line);
        respond(line, (text) => socket.write(text + "\r"));
      }
    });
    socket.on("error", () => {});
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    port,
    received,
    push: (text: string) => connection?.write(text + "\r"),
    async stop() {
      connection?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("ArdopHostClient", () => {
  it("sends a command and returns the modem's reply", async () => {
    const modem = await fakeModem((line, reply) => {
      if (line === "DRIVELEVEL 60") reply("DRIVELEVEL now 60");
    });
    const client = new ArdopHostClient({ port: modem.port });
    try {
      await client.connect();
      const result = await client.send("DRIVELEVEL 60");
      assert.equal(result.ok, true);
      assert.equal(result.reply, "DRIVELEVEL now 60");
      assert.deepEqual(modem.received, ["DRIVELEVEL 60"]);
    } finally {
      await client.close();
      await modem.stop();
    }
  });

  it("reports a FAULT without swallowing it or throwing", async () => {
    // A rejected drive level is something to show the operator in the tuning
    // window, not an exception that tears the window down around them.
    const modem = await fakeModem((_line, reply) => reply("FAULT Not from state ISS"));
    const client = new ArdopHostClient({ port: modem.port });
    try {
      await client.connect();
      const result = await client.send("TWOTONETEST");
      assert.equal(result.ok, false);
      assert.equal(result.reply, "Not from state ISS");
    } finally {
      await client.close();
      await modem.stop();
    }
  });

  it("does not mistake an unsolicited notification for a reply", async () => {
    // ardopcf sends INPUTPEAKS and PTT down the same socket as command replies.
    // Handing one back as the answer to DRIVELEVEL would report the wrong thing
    // entirely -- and would then leave the real reply to be read as the answer
    // to whatever came next.
    const modem = await fakeModem((line, reply) => {
      if (line === "DRIVELEVEL 60") {
        reply("INPUTPEAKS -3000 3000");
        reply("DRIVELEVEL now 60");
      }
    });
    const client = new ArdopHostClient({ port: modem.port });
    try {
      await client.connect();
      const result = await client.send("DRIVELEVEL 60");
      assert.equal(result.reply, "DRIVELEVEL now 60");
    } finally {
      await client.close();
      await modem.stop();
    }
  });

  it("hands unsolicited lines to listeners", async () => {
    const modem = await fakeModem(() => {});
    const client = new ArdopHostClient({ port: modem.port });
    const lines: string[] = [];
    try {
      await client.connect();
      client.onLine((line) => lines.push(line));
      modem.push("INPUTPEAKS -100 100");
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(lines, ["INPUTPEAKS -100 100"]);
    } finally {
      await client.close();
      await modem.stop();
    }
  });

  it("keeps commands in order rather than in flight together", async () => {
    // Replies carry no request id, so two commands outstanding at once would
    // make matching a reply to its command a guess.
    const modem = await fakeModem((line, reply) => reply(`${line} ok`));
    const client = new ArdopHostClient({ port: modem.port });
    try {
      await client.connect();
      const [a, b, c] = await Promise.all([client.send("ONE"), client.send("TWO"), client.send("THREE")]);
      assert.equal(a.reply, "ONE ok");
      assert.equal(b.reply, "TWO ok");
      assert.equal(c.reply, "THREE ok");
      assert.deepEqual(modem.received, ["ONE", "TWO", "THREE"]);
    } finally {
      await client.close();
      await modem.stop();
    }
  });

  it("gives up rather than hanging when the modem never answers", async () => {
    const modem = await fakeModem(() => {});
    const client = new ArdopHostClient({ port: modem.port, replyTimeoutMs: 60 });
    try {
      await client.connect();
      const result = await client.send("DRIVELEVEL 60");
      assert.equal(result.ok, false);
      assert.match(result.reply, /did not answer/);
    } finally {
      await client.close();
      await modem.stop();
    }
  });

  it("refuses to send when it is not connected", async () => {
    const client = new ArdopHostClient({ port: 1 });
    const result = await client.send("DRIVELEVEL 60");
    assert.equal(result.ok, false);
    assert.match(result.reply, /not connected/);
  });

  it("reports a connection it could not make", async () => {
    // A refused connect must not leave the caller waiting forever, and must not
    // take the process down through an unhandled socket error.
    const client = new ArdopHostClient({ port: 1 });
    await assert.rejects(() => client.connect());
  });

  it("closes cleanly twice", async () => {
    const modem = await fakeModem(() => {});
    const client = new ArdopHostClient({ port: modem.port });
    await client.connect();
    await client.close();
    await client.close();
    await modem.stop();
  });
});
