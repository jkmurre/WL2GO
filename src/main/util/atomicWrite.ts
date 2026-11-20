// Durable, atomic file replacement, shared by the config and credential stores.
//
// Writing a temp file and renaming it over the target gives ATOMICITY -- a
// reader never sees a half-written file. It does not give DURABILITY: the
// filesystem is free to order the rename ahead of the data, so a crash or power
// loss can leave the new name pointing at empty or stale content.
//
// The complete sequence is write -> fsync the file -> close -> rename -> fsync
// the containing directory. The last step is the one most often missed: without
// it the rename itself may not have reached disk.
//
// Deliberately free of any `electron` import so the stores that use it stay
// testable under `node --test`, which runs outside Electron.

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import * as path from "node:path";

export interface AtomicWriteOptions {
  /** Permission bits for the created file. Credentials use 0o600. */
  mode?: number;
}

/**
 * Replaces `filePath` with `contents`, atomically and durably.
 *
 * Creates the parent directory if needed, and never leaves a temp file behind
 * on failure.
 */
export function writeFileAtomicSync(filePath: string, contents: string, options: AtomicWriteOptions = {}): void {
  const mode = options.mode ?? 0o600;
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });

  // The temp file must live in the SAME directory as the target: rename() is
  // only atomic within one filesystem, and the OS temp dir is often another.
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);

  let fd: number | null = null;
  try {
    fd = openSync(temp, "w", mode);
    writeSync(fd, contents);
    fsyncSync(fd); // the data itself
    closeSync(fd);
    fd = null;

    renameSync(temp, filePath);
    fsyncDir(dir); // the rename
  } catch (err: unknown) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed or never opened */
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      /* the temp file may not exist; nothing to clean up */
    }
    throw err;
  }
}

/**
 * Flushes a directory entry so the rename survives a crash.
 *
 * Best effort by design: opening a directory for fsync is not portable -- it is
 * not permitted on Windows, and some filesystems reject it. Failing here means
 * losing durability of the rename, not correctness of the file, so it must never
 * turn a successful write into an error.
 */
function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    /* not supported on this platform or filesystem; the write itself stands */
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* nothing further to do */
      }
    }
  }
}
