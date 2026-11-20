import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { IPC_CHANNELS, IPC_EVENT_CHANNELS } from "./ipcContract.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("IPC contract", () => {
  it("declares no duplicate channel names", () => {
    assert.equal(new Set(IPC_CHANNELS).size, IPC_CHANNELS.length);
    assert.equal(new Set(IPC_EVENT_CHANNELS).size, IPC_EVENT_CHANNELS.length);
  });

  it("keeps request and event channels disjoint", () => {
    const overlap = IPC_CHANNELS.filter((c) => (IPC_EVENT_CHANNELS as readonly string[]).includes(c));
    assert.deepEqual(overlap, []);
  });

  it("namespaces every channel", () => {
    for (const channel of [...IPC_CHANNELS, ...IPC_EVENT_CHANNELS]) {
      assert.match(channel, /^[a-z]+:[a-zA-Z]+$/, `channel "${channel}" should look like "scope:action"`);
    }
  });

  it("has a main-process handler registered for every request channel", async () => {
    // The contract is only a contract if main actually implements it; this
    // catches a channel added to the type but never wired up.
    const handlers = await readFile(path.join(REPO_ROOT, "src/main/ipc/handlers.ts"), "utf8");
    for (const channel of IPC_CHANNELS) {
      assert.ok(handlers.includes(` handle("${channel}"`), `no handler registered for "${channel}"`);
    }
  });

  it("registers every handler through the sender check", async () => {
    // registerIpcHandlers' `handle` wrapper refuses frames that are not
    // WL2GO's own page. A direct ipcMain.handle("...") would bypass it.
    const handlers = await readFile(path.join(REPO_ROOT, "src/main/ipc/handlers.ts"), "utf8");
    assert.doesNotMatch(handlers, /ipcMain\.(handle|handleOnce|on|once)\("/);
  });

  it("exposes every request channel through the preload bridge", async () => {
    const preload = await readFile(path.join(REPO_ROOT, "src/preload/index.ts"), "utf8");
    for (const channel of IPC_CHANNELS) {
      assert.ok(preload.includes(`"${channel}"`), `"${channel}" is not exposed in the preload bridge`);
    }
  });
});
