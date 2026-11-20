// Centralised logging, stood up in Module 0 per the project's cross-cutting
// rules: app logs plus captured stdout/stderr from every spawned subprocess
// (pat, and later ardopcf and rigctld), rotated so they cannot grow unbounded.

import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, type WriteStream } from "node:fs";
import { Writable } from "node:stream";
import * as path from "node:path";

export type LogLevel = "info" | "warn" | "error";

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_ROTATIONS = 3;

let logDir: string | null = null;
let stream: WriteStream | null = null;
let currentFile: string | null = null;

function timestamp(): string {
  return new Date().toISOString();
}

function rotateIfNeeded(file: string): void {
  if (!existsSync(file)) return;
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size < MAX_BYTES) return;

  stream?.end();
  stream = null;

  const parsed = path.parse(file);
  for (let i = KEEP_ROTATIONS - 1; i >= 1; i--) {
    const from = path.join(parsed.dir, `${parsed.name}.${i}${parsed.ext}`);
    const to = path.join(parsed.dir, `${parsed.name}.${i + 1}${parsed.ext}`);
    if (existsSync(from)) renameSync(from, to);
  }
  renameSync(file, path.join(parsed.dir, `${parsed.name}.1${parsed.ext}`));
}

/** Must be called once, early in main, before anything logs. */
export function initLogger(directory: string): void {
  logDir = directory;
  mkdirSync(directory, { recursive: true });
  currentFile = path.join(directory, "wl2go.log");
  rotateIfNeeded(currentFile);
  stream = createWriteStream(currentFile, { flags: "a" });
  log("info", "logger", `Logging to ${currentFile}`);
}

export function log(level: LogLevel, scope: string, message: string): void {
  const line = `${timestamp()} [${level.toUpperCase()}] [${scope}] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  stream?.write(`${line}\n`);
}

export const logger = {
  info: (scope: string, message: string) => log("info", scope, message),
  warn: (scope: string, message: string) => log("warn", scope, message),
  error: (scope: string, message: string) => log("error", scope, message),
};

/**
 * A dedicated append stream for one subprocess's stdout/stderr, TIMESTAMPED.
 *
 * Per line, not per write: a subprocess's output arrives in whatever chunks the
 * pipe happens to deliver, so stamping the chunk would date a whole burst by
 * when its last byte arrived.
 *
 * The stamps are the point. ardopcf's console output carries none of its own --
 * WL2GO passes -m, which turns off the log files where they would be -- so a
 * log full of "PTT-FALSE" and "Opened capture device" said nothing about the
 * one thing worth knowing, which is how long the gap between them is. That gap
 * is the modem's deaf window after every transmission, and a reply that lands
 * inside it is a session that fails with no evidence at all.
 */
export function subprocessLogStream(name: string): Writable {
  if (!logDir) throw new Error("initLogger() must be called before subprocessLogStream()");
  const file = path.join(logDir, `${name}.log`);
  rotateIfNeeded(file);
  return timestampLines(createWriteStream(file, { flags: "a" }));
}

/**
 * Wraps a stream so every LINE written through it is prefixed with the time.
 *
 * Holds a partial trailing line back until its newline arrives, so a line split
 * across two chunks is stamped once, at the front, rather than gaining a stamp
 * in the middle of itself.
 */
export function timestampLines(sink: Pick<WriteStream, "write" | "end">): Writable {
  let partial = "";
  const stamp = (line: string) => `${timestamp()} ${line}\n`;

  return new Writable({
    write(chunk, _encoding, callback) {
      partial += String(chunk);
      const lines = partial.split("\n");
      // The last element is whatever followed the final newline: empty when the
      // chunk ended cleanly, a partial line when it did not.
      partial = lines.pop() ?? "";
      for (const line of lines) sink.write(stamp(line));
      callback();
    },
    final(callback) {
      if (partial) sink.write(stamp(partial));
      partial = "";
      sink.end(() => callback());
    },
  });
}

export function logFilePath(): string | null {
  return currentFile;
}

/** Where the logs live, for subprocesses that write their own files there. */
export function logDirectory(): string | null {
  return logDir || null;
}

export function closeLogger(): void {
  stream?.end();
  stream = null;
}
