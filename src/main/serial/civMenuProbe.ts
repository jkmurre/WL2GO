// Finds a menu setting's CI-V sub-address by watching which one changes.
//
// The problem this solves: Icom's menu items are addressed as 1A 05 <hi> <lo>,
// the addresses are per model, Hamlib does not carry them (icom_defs.h:395),
// and writing to a guessed one alters an unrelated setting on the operator's
// radio. Hamlib's own IC-7300 and IC-7300 MkII tables differ on every shared
// entry, so "close enough" does not exist here.
//
// The answer is to stop guessing and MEASURE. Read a block of addresses, have
// the operator change the one setting in the radio's menu, read the block
// again, and report what moved. Every operation is a read, so a wrong address
// costs nothing -- which is the whole reason this is safe to run against
// someone's radio and a speculative write is not.

import { parseCivFrames } from "../../shared/civFrame.ts";
import {
  buildMenuReadFrame,
  formatMenuAddress,
  menuValueFromReply,
  type CivMenuAddress,
} from "../../shared/civMenu.ts";
import type { ProbePort } from "./civProbe.ts";

/** How long to wait for a reply to one read. */
const READ_WINDOW_MS = 60;

export interface MenuReading {
  address: CivMenuAddress;
  value: number[];
}

export interface MenuDifference {
  address: CivMenuAddress;
  before: number[];
  after: number[];
  /** "1A 05 00 74: 00 -> 01", ready to print. */
  summary: string;
}

export interface ScanRange {
  /** Inclusive, as the two bytes after 1A 05. */
  firstHigh: number;
  lastHigh: number;
}

/**
 * Icom's menu addresses are BCD-ish: the low byte runs 0x00-0x99, not 0x00-0xFF.
 *
 * Read straight off Hamlib's tables, where every low byte is a valid pair of
 * decimal digits -- 0x23, 0x81, 0x89, 0x95, 0x60, 0x64, 0x91. Scanning the
 * binary range would spend 60% of its time on addresses that cannot exist and
 * make a full pass take minutes instead of seconds.
 */
export function menuAddresses(range: ScanRange): CivMenuAddress[] {
  const addresses: CivMenuAddress[] = [];
  for (let high = range.firstHigh; high <= range.lastHigh; high++) {
    for (let tens = 0; tens <= 9; tens++) {
      for (let units = 0; units <= 9; units++) {
        addresses.push({ high, low: (tens << 4) | units });
      }
    }
  }
  return addresses;
}

/** Reads every address in the range. Absent ones are simply left out. */
export async function scanMenu(
  port: ProbePort,
  radioAddress: number,
  range: ScanRange,
  onProgress?: (done: number, total: number) => void,
): Promise<MenuReading[]> {
  const addresses = menuAddresses(range);
  const readings: MenuReading[] = [];

  for (const [index, address] of addresses.entries()) {
    await port.write(buildMenuReadFrame(radioAddress, address));
    const value = menuValueFromReply(parseCivFrames(await port.read(READ_WINDOW_MS)), address);
    // A NAK or silence means "no such menu item", which is the ordinary answer
    // for most of the range and is not an error.
    if (value) readings.push({ address, value });
    onProgress?.(index + 1, addresses.length);
  }

  return readings;
}

/**
 * What changed between two scans.
 *
 * Pure, so the interesting cases -- nothing moved, several things moved -- are
 * testable without a radio. Several moving is a real outcome worth reporting
 * rather than resolving: an operator who nudged the dial while in the menu has
 * changed two settings, and picking one of them silently would hand back an
 * address for the wrong thing.
 */
export function diffScans(before: readonly MenuReading[], after: readonly MenuReading[]): MenuDifference[] {
  const key = (address: CivMenuAddress) => `${address.high},${address.low}`;
  const first = new Map(before.map((reading) => [key(reading.address), reading.value]));
  const hex = (bytes: readonly number[]) =>
    bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");

  const changed: MenuDifference[] = [];
  for (const reading of after) {
    const previous = first.get(key(reading.address));
    if (!previous) continue;
    if (previous.length === reading.value.length && previous.every((b, i) => b === reading.value[i])) continue;
    changed.push({
      address: reading.address,
      before: previous,
      after: reading.value,
      summary: `${formatMenuAddress(reading.address)}: ${hex(previous)} -> ${hex(reading.value)}`,
    });
  }
  return changed;
}
