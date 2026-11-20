import assert from "node:assert/strict";
import * as net from "node:net";
import { after, describe, it } from "node:test";
import { waitForTcpPort } from "./tcpProbe.ts";

const servers: net.Server[] = [];

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

async function listen(): Promise<number> {
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("expected a TCP address");
  return address.port;
}

describe("waitForTcpPort", () => {
  it("resolves once the port accepts connections", async () => {
    const port = await listen();
    await waitForTcpPort(port, 3000, { intervalMs: 10 });
  });

  it("rejects when nothing ever listens, naming the subprocess", async () => {
    // Port 1 is privileged and unbound in test environments.
    await assert.rejects(waitForTcpPort(1, 200, { intervalMs: 10, label: "rigctld" }), /rigctld did not open its port 1/);
  });

  it("aborts early when the process dies, rather than waiting out the timeout", async () => {
    const started = Date.now();
    await assert.rejects(
      waitForTcpPort(1, 30_000, { intervalMs: 10, shouldAbort: () => "ardopcf exited with code=1" }),
      /exited with code=1/,
    );
    assert.ok(Date.now() - started < 5000, "should abort promptly rather than run the full timeout");
  });
});
