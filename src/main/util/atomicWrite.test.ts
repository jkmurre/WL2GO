import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { writeFileAtomicSync } from "./atomicWrite.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "wl2go-atomic-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomicSync", () => {
  it("creates the file and its parent directories", () => {
    const target = path.join(dir, "deep", "nested", "config.json");
    writeFileAtomicSync(target, "hello\n");
    assert.equal(readFileSync(target, "utf8"), "hello\n");
  });

  it("replaces existing content rather than appending", () => {
    const target = path.join(dir, "config.json");
    writeFileAtomicSync(target, "first");
    writeFileAtomicSync(target, "second");
    assert.equal(readFileSync(target, "utf8"), "second");
  });

  it("leaves no temp file behind on success", () => {
    writeFileAtomicSync(path.join(dir, "config.json"), "x");
    assert.deepEqual(readdirSync(dir), ["config.json"]);
  });

  it("applies the requested permissions", () => {
    const target = path.join(dir, "secrets.json");
    writeFileAtomicSync(target, "x", { mode: 0o600 });
    assert.equal(statSync(target).mode & 0o777, 0o600);
  });

  it("defaults to owner-only permissions", () => {
    const target = path.join(dir, "config.json");
    writeFileAtomicSync(target, "x");
    assert.equal(statSync(target).mode & 0o777, 0o600);
  });

  it("throws and cleans up when the target cannot be replaced", () => {
    // A directory cannot be renamed over, so this exercises the failure path
    // after the temp file has already been written.
    const target = path.join(dir, "occupied");
    mkdirSync(path.join(target, "child"), { recursive: true });

    assert.throws(() => writeFileAtomicSync(target, "x"));
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.startsWith(".")),
      [],
      "a failed write must not leave a temp file behind",
    );
  });

  it("does not corrupt the existing file when the write fails", () => {
    const target = path.join(dir, "config.json");
    writeFileSync(target, "original");

    // Writing content that is fine, but to a path whose parent is a file --
    // mkdirSync then fails and the original is untouched.
    const bad = path.join(target, "nested.json");
    assert.throws(() => writeFileAtomicSync(bad, "x"));
    assert.equal(readFileSync(target, "utf8"), "original");
  });
});
