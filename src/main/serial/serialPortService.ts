import { SerialPort } from "serialport";
import type { SerialPortInfo } from "../../shared/ipcContract.ts";
import { preferCalloutPath } from "../../shared/configSchema.ts";

/**
 * Serial ports for CAT and PTT.
 *
 * serialport's native binding ships N-API prebuilds, which are ABI-stable
 * across Electron versions, so this needs no electron-rebuild step. The .node
 * file must still be unpacked from the asar to be loadable -- see
 * asarUnpack in electron-builder.yml.
 */

/**
 * Whether a port looks like something a radio could be on.
 *
 * A USB vendor id is the signal: it is present for any USB-serial adapter and
 * absent for the ports macOS always offers (a Bluetooth serial profile, a debug
 * console). Used to ORDER and LABEL the list, never to hide an entry -- the
 * same reasoning as addressWarnings() in shared/composeModel.ts. An unusual
 * adapter filtered out on the day it matters is worse than an odd entry in a
 * dropdown.
 */
export function likelyRadioInterface(port: { vendorId: string | null }): boolean {
  return Boolean(port.vendorId);
}

/** Normalises serialport's raw entries. Pure, for testing. */
export function normalisePorts(
  raw: Array<Record<string, unknown>>,
  platform: string = process.platform,
): SerialPortInfo[] {
  return raw
    .map((port) => {
      const systemPath = String(port["path"] ?? "");
      const vendorId = (port["vendorId"] as string | undefined) ?? null;
      return {
        // serialport enumerates the /dev/tty.* form on macOS; rig control needs
        // the callout node. This is the value that gets stored in a profile and
        // handed to rigctld, so the rewrite belongs here rather than at use.
        path: preferCalloutPath(systemPath, platform),
        systemPath,
        manufacturer: (port["manufacturer"] as string | undefined) ?? null,
        serialNumber: (port["serialNumber"] as string | undefined) ?? null,
        vendorId,
        productId: (port["productId"] as string | undefined) ?? null,
        likelyRadioInterface: likelyRadioInterface({ vendorId }),
      };
    })
    .filter((port) => port.path.length > 0)
    .sort((a, b) => {
      // Probable radio interfaces first, so the operator's port is near the top
      // rather than below the Bluetooth entry macOS always contributes.
      if (a.likelyRadioInterface !== b.likelyRadioInterface) return a.likelyRadioInterface ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
}

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  const ports = await SerialPort.list();
  return normalisePorts(ports as unknown as Array<Record<string, unknown>>);
}
