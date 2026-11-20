// The rig models this build of Hamlib can actually drive.
//
// Read from `rigctld -l` at runtime rather than transcribed into a table, for
// the same reason audio devices come from ardopcf: the list has to be the one
// the binary WILL USE, and a hand-maintained copy drifts the moment Hamlib is
// upgraded. A model number that is not in this build's list produces a daemon
// that starts and then cannot talk to the radio, with nothing on screen saying
// the model was the problem.

import { execFile } from "node:child_process";
import { resolveBinaryPath } from "../pat/patProcessManager.ts";
import type { RigModel } from "../../shared/ipcContract.ts";

/**
 * Parses `rigctld -l`. Pure, for testing.
 *
 * The format is a fixed-width table with a header line:
 *
 *   Rig #  Mfg     Model      Version      Status   Macro
 *    3094  Icom    IC-7300MK2 20250517.14  Beta     RIG_MODEL_IC7300MK2
 *
 * Split on runs of two-or-more spaces rather than on single ones, because both
 * the manufacturer and the model can contain a space ("TRXManager 5.7.630+").
 * Splitting on any whitespace is how "IC-7300 MkII" becomes two columns and
 * every field after it shifts.
 */
export function parseRigModels(output: string): RigModel[] {
  const models: RigModel[] = [];

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Rig #")) continue;

    const parts = trimmed.split(/\s{2,}/);
    if (parts.length < 5) continue;

    const [id, make, model, , status] = parts;
    const number = Number.parseInt(id ?? "", 10);
    if (!Number.isInteger(number) || number <= 0) continue;
    if (!make || !model) continue;

    models.push({ model: number, make, name: model, status: status ?? "" });
  }

  return models;
}

/**
 * The models worth offering, in the order the picker shows them.
 *
 * Alpha and Untested backends are dropped. That is not tidiness: Hamlib marks a
 * backend Alpha when nobody has driven a real radio with it, and an operator
 * picking one gets a rig that reports success and does nothing -- which is
 * indistinguishable, from the outside, from the bug this whole module exists to
 * fix. Stable and Beta are both known to work on real hardware.
 *
 * The Dummy and NET rigctl backends go too. Neither drives a radio, and
 * "Hamlib Dummy" sitting at the top of an alphabetical list is an invitation to
 * pick it.
 */
export function usableRigModels(models: readonly RigModel[]): RigModel[] {
  return models
    .filter((rig) => rig.status === "Stable" || rig.status === "Beta")
    .filter((rig) => rig.make !== "Hamlib")
    .sort((a, b) => a.make.localeCompare(b.make) || a.name.localeCompare(b.name));
}

export async function listRigModels(resourcesBinDir: string, timeoutMs = 10_000): Promise<RigModel[]> {
  const binPath = resolveBinaryPath(resourcesBinDir, "rigctld");

  const stdout = await new Promise<string>((resolve, reject) => {
    // maxBuffer raised well past the default 1 MB: Hamlib ships several hundred
    // backends and the listing is comfortably larger than the node default,
    // which would otherwise truncate it into a silently short picker.
    execFile(
      binPath,
      ["-l"],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, out) => {
        if (err) {
          reject(new Error(`Could not list radio models (${binPath}): ${err.message}`));
          return;
        }
        resolve(out);
      },
    );
  });

  return usableRigModels(parseRigModels(stdout));
}
