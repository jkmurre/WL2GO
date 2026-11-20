// Kills subprocesses of ours that outlived the app that started them.
//
// macOS has no parent-death signal, so a WL2GO that exits without cleanly
// stopping its children -- a crash, a force quit, a failed teardown -- leaves
// them running. They keep whatever they had open: ardopcf keeps the sound card,
// and under CAT keying it keeps the radio's CI-V port too.
//
// That is not a tidiness problem. A leftover modem holding the CI-V port eats
// the radio's replies to rigctld, so the NEXT session fails with "the radio's
// current mode could not be read" -- an error that points at the radio and the
// cable while the actual cause is a process from twenty minutes ago. Observed
// exactly that: an orphaned tuning modem held the port for seven minutes and no
// amount of correcting the profile could help, because the config was already
// right.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A process as `ps` reports it. */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  command: string;
}

/**
 * Parses `ps -axo pid=,ppid=,command=`.
 *
 * Split on whitespace only twice: the command is the rest of the line and
 * contains spaces, and on macOS it may contain almost anything else too.
 */
export function parseProcessList(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    entries.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return entries;
}

/**
 * The orphans among them, given where our binaries live.
 *
 * TWO conditions, and both are load-bearing:
 *
 *   ppid === 1   The process was reparented to init, which means the app that
 *                spawned it is gone. A live second instance's children have
 *                that instance as their parent, so this is what keeps the
 *                reaper from killing a running sibling's modem out from under
 *                it.
 *   our path     The command begins with our own resources/bin directory, so a
 *                user's separately installed ardopcf, rigctld or Pat -- which
 *                they may well be running deliberately -- is never touched.
 *
 * Our own pid is excluded for completeness; the app is not spawned from that
 * directory, but a reaper that could kill the process running it is not worth
 * the argument.
 */
export function findOrphans(
  entries: readonly ProcessEntry[],
  resourcesBinDir: string,
  self: number = process.pid,
): ProcessEntry[] {
  const prefix = resourcesBinDir.endsWith("/") ? resourcesBinDir : `${resourcesBinDir}/`;
  return entries.filter(
    (entry) => entry.ppid === 1 && entry.pid !== self && entry.command.startsWith(prefix),
  );
}

export interface ReapOptions {
  resourcesBinDir: string;
  onLog?: (message: string) => void;
  /** Injected for tests. */
  listProcesses?: () => Promise<string>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  wait?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function defaultKill(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

async function defaultList(): Promise<string> {
  const { stdout } = await run("ps", ["-axo", "pid=,ppid=,command="]);
  return stdout;
}

/**
 * Kills abandoned subprocesses. Call BEFORE starting any of them.
 *
 * SIGTERM first so ardopcf can release the sound card and rigctld can drop the
 * serial port properly, then SIGKILL for anything still there. Never throws:
 * failing to reap is worth a log line, not a refusal to start -- the app is
 * still usable, and on a machine where `ps` is unavailable it would otherwise
 * never launch at all.
 */
export async function reapOrphans(opts: ReapOptions): Promise<number[]> {
  const list = opts.listProcesses ?? defaultList;
  const kill = opts.kill ?? defaultKill;
  const wait = opts.wait ?? sleep;

  let orphans: ProcessEntry[];
  try {
    orphans = findOrphans(parseProcessList(await list()), opts.resourcesBinDir);
  } catch (err: unknown) {
    opts.onLog?.(`Could not check for leftover subprocesses: ${String(err)}`);
    return [];
  }
  if (orphans.length === 0) return [];

  for (const orphan of orphans) {
    opts.onLog?.(`Stopping a leftover ${nameOf(orphan.command)} (pid ${orphan.pid}) from an earlier run`);
    try {
      kill(orphan.pid, "SIGTERM");
    } catch {
      // Already gone between the listing and here. Nothing to do.
    }
  }

  await wait(500);

  for (const orphan of orphans) {
    try {
      // Signal 0 tests for existence without sending anything.
      kill(orphan.pid, 0 as unknown as NodeJS.Signals);
      kill(orphan.pid, "SIGKILL");
      opts.onLog?.(`Leftover ${nameOf(orphan.command)} (pid ${orphan.pid}) ignored SIGTERM and was killed`);
    } catch {
      // Exited on SIGTERM, which is the normal path.
    }
  }

  return orphans.map((orphan) => orphan.pid);
}

/** The binary's own name, for a message an operator can read. */
function nameOf(command: string): string {
  const executable = command.split(" ")[0] ?? command;
  return executable.split("/").pop() || executable;
}
