import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { isTrustedSender } from "./senderGuard.ts";

const RENDERER = path.resolve("/Applications/WL2GO.app/Contents/Resources/app.asar/out/renderer/index.html");
const FILE_ORIGIN = { file: RENDERER };
const top = (url: string) => ({ url, parent: null });

describe("isTrustedSender", () => {
  it("accepts the packaged renderer page, with or without a query", () => {
    const page = pathToFileURL(RENDERER).href;
    assert.equal(isTrustedSender(top(page), FILE_ORIGIN), true);
    assert.equal(isTrustedSender(top(`${page}?compose=d1`), FILE_ORIGIN), true);
    assert.equal(isTrustedSender(top(`${page}#x`), FILE_ORIGIN), true);
  });

  it("refuses any other local file", () => {
    for (const other of [
      path.resolve("/tmp/evil.html"),
      path.resolve(path.dirname(RENDERER), "other.html"),
      path.resolve(path.dirname(RENDERER), "../renderer/index.html.evil"),
    ]) {
      assert.equal(isTrustedSender(top(pathToFileURL(other).href), FILE_ORIGIN), false, other);
    }
    assert.equal(isTrustedSender(top("file://server/share/index.html"), FILE_ORIGIN), false);
  });

  it("refuses remote pages and odd schemes", () => {
    for (const url of ["https://example.org/", "http://127.0.0.1:5173/", "data:text/html,hi", "about:blank", "not a url"]) {
      assert.equal(isTrustedSender(top(url), FILE_ORIGIN), false, url);
    }
  });

  it("refuses sub-frames, even of the right page", () => {
    const page = pathToFileURL(RENDERER).href;
    assert.equal(isTrustedSender({ url: page, parent: {} }, FILE_ORIGIN), false);
  });

  it("refuses a missing frame", () => {
    assert.equal(isTrustedSender(null, FILE_ORIGIN), false);
    assert.equal(isTrustedSender(undefined, FILE_ORIGIN), false);
  });

  it("matches the dev server by origin", () => {
    const dev = { devUrl: "http://localhost:5173/" };
    assert.equal(isTrustedSender(top("http://localhost:5173/?compose=d1"), dev), true);
    assert.equal(isTrustedSender(top("http://localhost:5174/"), dev), false);
    assert.equal(isTrustedSender(top("http://evil.localhost:5173/"), dev), false);
    assert.equal(isTrustedSender(top(pathToFileURL(RENDERER).href), dev), false);
  });
});
