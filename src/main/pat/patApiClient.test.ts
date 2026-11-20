import assert from "node:assert/strict";
import * as http from "node:http";
import { after, describe, it } from "node:test";
import { PatApiClient, PatApiError } from "./patApiClient.ts";
import type { PatStatus } from "../../shared/ipcContract.ts";

const servers: http.Server[] = [];

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

async function startServer(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("expected a TCP address");
  return address.port;
}

/** The exact shape Pat v1.0.0 returns from GET /api/status. */
const SAMPLE_STATUS: PatStatus = {
  active_listeners: [],
  connected: false,
  dialing: false,
  remote_addr: "",
  http_clients: [],
  config_hash: "d41d8cd98f00b204e9800998ecf8427e",
};

describe("PatApiClient token", () => {
  it("sends the API token on every request", async () => {
    const seen: (string | undefined)[] = [];
    const port = await startServer((req, res) => {
      seen.push(req.headers["x-wl2go-token"] as string | undefined);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SAMPLE_STATUS));
    });

    await new PatApiClient(port, "tok").getStatus();
    await new PatApiClient(port).getStatus();
    assert.deepEqual(seen, ["tok", undefined]);
  });
});

describe("PatApiClient.getStatus", () => {
  it("parses a well-formed status response", async () => {
    const port = await startServer((req, res) => {
      assert.equal(req.url, "/api/status");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SAMPLE_STATUS));
    });

    const status = await new PatApiClient(port).getStatus();
    assert.deepEqual(status, SAMPLE_STATUS);
  });

  it("surfaces the body when the API returns a non-2xx status", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(503);
      res.end("engine busy");
    });

    await assert.rejects(new PatApiClient(port).getStatus(), /returned status 503.*engine busy/s);
  });

  it("reports malformed JSON as a parse failure, naming the endpoint", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not json");
    });

    await assert.rejects(new PatApiClient(port).getStatus(), /Failed to parse.*\/api\/status/s);
  });

  it("times out rather than hanging when the API never responds", async () => {
    const port = await startServer(() => {
      /* deliberately never responds */
    });

    await assert.rejects(new PatApiClient(port).getStatus(150), /timed out after 150ms/);
  });

  it("rejects when nothing is listening", async () => {
    await assert.rejects(new PatApiClient(1).getStatus(300));
  });
});

describe("PatApiClient mailbox calls", () => {
  it("lists a folder with no timeout, because Pat's listing cost scales with bytes on disk", async () => {
    // A fixed deadline here is the defect small fixtures never reveal: Pat reads
    // every attachment of every message to produce this metadata-only response.
    // The server below stalls past any default before answering.
    const port = await startServer((req, res) => {
      assert.equal(req.url, "/api/mailbox/in");
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ MID: "AAAA" }]));
      }, 120);
    });

    const client = new PatApiClient(port);
    const messages = await client.getMailbox("in");
    assert.deepEqual(messages, [{ MID: "AAAA" }]);
  });

  it("fetches one message from the box/mid path", async () => {
    const port = await startServer((req, res) => {
      assert.equal(req.url, "/api/mailbox/in/E88DNN8D4ONK");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ MID: "E88DNN8D4ONK", Body: "hello" }));
    });

    const message = await new PatApiClient(port).getMessage("in", "E88DNN8D4ONK");
    assert.deepEqual(message, { MID: "E88DNN8D4ONK", Body: "hello" });
  });

  it("sends a JSON body when marking read, and accepts Pat's empty 200", async () => {
    let seenBody = "";
    let seenType = "";
    let seenMethod = "";

    const port = await startServer((req, res) => {
      seenMethod = req.method ?? "";
      seenType = String(req.headers["content-type"] ?? "");
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seenBody = Buffer.concat(chunks).toString("utf8");
        // Pat's readHandler writes nothing to the response at all.
        res.writeHead(200);
        res.end();
      });
    });

    await new PatApiClient(port).setRead("in", "E88DNN8D4ONK", true);

    assert.equal(seenMethod, "POST");
    assert.equal(seenType, "application/json");
    assert.deepEqual(JSON.parse(seenBody), { read: true });
  });

  it("can mark a message unread again", async () => {
    let seenBody = "";
    const port = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seenBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200);
        res.end();
      });
    });

    await new PatApiClient(port).setRead("in", "X", false);
    assert.deepEqual(JSON.parse(seenBody), { read: false });
  });

  it("surfaces the 500 Pat returns for a message that is no longer there", async () => {
    // readHandler omits the os.IsNotExist check its neighbours have, so a moved
    // or deleted message is a 500 rather than a 404. The caller has to map it.
    const port = await startServer((_req, res) => {
      res.writeHead(500);
      res.end("open ...: no such file or directory");
    });

    await assert.rejects(new PatApiClient(port).setRead("in", "GONE", true), /returned status 500/);
  });

  it("returns attachment bytes verbatim rather than parsing them", async () => {
    // Deliberately bytes that are not valid UTF-8 and not JSON: the raw path
    // must not run them through JSON.parse or a string round-trip.
    const payload = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    const port = await startServer((req, res) => {
      assert.equal(req.url, "/api/mailbox/in/E88DNN8D4ONK/photo%20one.jpg");
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(payload);
    });

    const file = await new PatApiClient(port).getAttachment("in", "E88DNN8D4ONK", "photo one.jpg");

    assert.equal(file.name, "photo one.jpg");
    assert.equal(file.contentType, "image/jpeg");
    assert.deepEqual([...file.bytes], [...payload]);
  });

  it("never asks Pat to render an attachment as HTML", async () => {
    // rendertohtml would return Pat's rendered form instead of the real file.
    let seenUrl = "";
    const port = await startServer((req, res) => {
      seenUrl = req.url ?? "";
      res.writeHead(200, { "content-type": "text/xml" });
      res.end("<form/>");
    });

    await new PatApiClient(port).getAttachment("in", "X", "RMS_Express_Form.xml");
    assert.ok(!seenUrl.includes("rendertohtml"), `unexpected query in ${seenUrl}`);
  });
});

describe("PatApiClient move and delete", () => {
  it("moves a message by posting to the target box with a source-path header", async () => {
    // There is no move route: Pat overloads the compose endpoint and reads the
    // source entirely from this header.
    let seenUrl = "";
    let seenMethod = "";
    let seenSource = "";

    const port = await startServer((req, res) => {
      seenUrl = req.url ?? "";
      seenMethod = req.method ?? "";
      seenSource = String(req.headers["x-pat-sourcepath"] ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify("OK"));
    });

    await new PatApiClient(port).moveMessage("in", "E88DNN8D4ONK", "archive");

    assert.equal(seenMethod, "POST");
    assert.equal(seenUrl, "/api/mailbox/archive");
    assert.equal(seenSource, "/api/mailbox/in/E88DNN8D4ONK");
  });

  it("refuses to move into the Outbox rather than letting Pat misread it", () => {
    // Pat branches to the compose path whenever the target is `out`, so this
    // would be parsed as a malformed new message instead of failing.
    assert.throws(() => new PatApiClient(1).moveMessage("in", "X", "out"), /cannot be moved into the Outbox/);
  });

  it("deletes with the DELETE verb on the message path", async () => {
    let seenUrl = "";
    let seenMethod = "";

    const port = await startServer((req, res) => {
      seenUrl = req.url ?? "";
      seenMethod = req.method ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify("OK"));
    });

    await new PatApiClient(port).deleteMessage("archive", "E88DNN8D4ONK");

    assert.equal(seenMethod, "DELETE");
    assert.equal(seenUrl, "/api/mailbox/archive/E88DNN8D4ONK");
  });

  it("reports a delete of something already gone", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(404);
      res.end("404 page not found");
    });

    await assert.rejects(new PatApiClient(port).deleteMessage("archive", "GONE"), /returned status 404/);
  });

  it("sends no stray headers on an ordinary request", async () => {
    // The header plumbing must not leak a content-type onto bodyless GETs.
    let seenType: string | undefined;
    const port = await startServer((req, res) => {
      seenType = req.headers["content-type"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([]));
    });

    await new PatApiClient(port).getMailbox("in");
    assert.equal(seenType, undefined);
  });
});

describe("PatApiClient.postMessage", () => {
  it("posts multipart to the outbox with the fields Pat reads", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenType = "";
    let seenBody = Buffer.alloc(0);

    const port = await startServer((req, res) => {
      seenUrl = req.url ?? "";
      seenMethod = req.method ?? "";
      seenType = String(req.headers["content-type"] ?? "");
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seenBody = Buffer.concat(chunks);
        res.writeHead(201);
        res.end("Message posted (0.42 kB)");
      });
    });

    await new PatApiClient(port).postMessage({
      to: "W1AW",
      cc: "",
      subject: "Sunday net",
      body: "See you at 1900.",
      p2ponly: "",
      date: "2026-08-24T14:32:00.000Z",
    });

    assert.equal(seenMethod, "POST");
    assert.equal(seenUrl, "/api/mailbox/out");
    assert.match(seenType, /^multipart\/form-data; boundary=/);

    const text = seenBody.toString("utf8");
    assert.match(text, /name="to"\r\n\r\nW1AW\r\n/);
    assert.match(text, /name="subject"\r\n\r\nSunday net\r\n/);
    assert.match(text, /name="date"\r\n\r\n2026-08-24T14:32:00\.000Z\r\n/);
  });

  it("never sends in_reply_to, which Pat's Go source does not read", async () => {
    let seenBody = "";
    const port = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seenBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(201);
        res.end("ok");
      });
    });

    await new PatApiClient(port).postMessage({ to: "W1AW", subject: "s", body: "b", date: "2026-01-01T00:00:00Z" });
    assert.ok(!seenBody.includes("in_reply_to"));
  });

  it("carries attachment bytes through unchanged", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    let seenBody = Buffer.alloc(0);

    const port = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seenBody = Buffer.concat(chunks);
        res.writeHead(201);
        res.end("ok");
      });
    });

    await new PatApiClient(port).postMessage({ to: "W1AW", subject: "s", body: "b", date: "2026-01-01T00:00:00Z" }, [
      { field: "files", filename: "photo.jpg", contentType: "image/jpeg", bytes: jpeg },
    ]);

    assert.ok(seenBody.includes(jpeg), "attachment bytes were altered in transit");
  });

  it("surfaces a validation rejection from Pat", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(400);
      res.end("Validation error: Subject: Empty subject");
    });

    await assert.rejects(
      new PatApiClient(port).postMessage({ to: "W1AW", subject: "", body: "b", date: "2026-01-01T00:00:00Z" }),
      /Empty subject/,
    );
  });
});

describe("PatApiClient hybrid network calls", () => {
  /** Records each request and answers with whatever the test hands back. */
  async function recording(answer: (req: http.IncomingMessage) => { status: number; body: string }) {
    const seen: { method: string; url: string; body: string }[] = [];
    const port = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
        const { status, body } = answer(req);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body);
      });
    });
    return { client: new PatApiClient(port), seen };
  }

  it("reads the hybrid list and the pickup stations from the patched routes", async () => {
    const { client, seen } = await recording((req) => ({
      status: 200,
      body: req.url === "/api/wl2go/hybrid_stations" ? '[{"callsign":"W1AW-10"}]' : '[{"callsign":"K1ABC"}]',
    }));

    assert.deepEqual(await client.getHybridStations(), [{ callsign: "W1AW-10" }]);
    assert.deepEqual(await client.getPickupStations(), [{ callsign: "K1ABC" }]);
    assert.deepEqual(
      seen.map((r) => `${r.method} ${r.url}`),
      ["GET /api/wl2go/hybrid_stations", "GET /api/wl2go/mps"],
    );
  });

  it("adds with a JSON body and clears with DELETE", async () => {
    const { client, seen } = await recording((req) => ({
      status: 200,
      body: req.method === "DELETE" ? "[]" : '[{"callsign":"W1AW-10"}]',
    }));

    assert.deepEqual(await client.addPickupStation("W1AW-10"), [{ callsign: "W1AW-10" }]);
    await client.clearPickupStations();

    assert.equal(seen[0]!.method, "POST");
    assert.equal(seen[0]!.url, "/api/wl2go/mps");
    assert.deepEqual(JSON.parse(seen[0]!.body), { callsign: "W1AW-10" });
    assert.equal(seen[1]!.method, "DELETE");
  });

  it("rejects with the status and body kept, so offline can be told from refused", async () => {
    const { client } = await recording(() => ({ status: 503, body: '{"error":"no route","kind":"network"}' }));

    await assert.rejects(client.getPickupStations(), (err: unknown) => {
      assert.ok(err instanceof PatApiError);
      assert.equal(err.status, 503);
      assert.equal(JSON.parse(err.body).kind, "network");
      return true;
    });
  });
});
