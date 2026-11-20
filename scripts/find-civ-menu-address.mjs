#!/usr/bin/env node
// Finds the CI-V sub-address of ONE Icom menu setting, by measuring it.
//
// Usage:
//   node scripts/find-civ-menu-address.mjs [--port /dev/cu.usbmodem21101]
//                                          [--baud 19200] [--address B6]
//                                          [--range 0-2]
//
// Why this exists: Icom addresses menu items as 1A 05 <hi> <lo>, the addresses
// differ between models -- Hamlib's IC-7300 and IC-7300 MkII tables disagree on
// every shared entry -- and Hamlib does not carry them at all
// (icom_defs.h:395). Writing to a guessed address changes an unrelated setting
// on a real radio, so WL2GO refuses to guess. This measures instead.
//
// EVERY OPERATION IS A READ. Nothing here writes to the radio, so a wrong
// address costs nothing but a moment.

import { SerialPort } from "serialport";
import { createInterface } from "node:readline/promises";

// The probe logic is TypeScript and shared with the app, so what this sends
// cannot drift from what WL2GO itself sends. Node strips the types on import.
import { scanMenu, diffScans } from "../src/main/serial/civMenuProbe.ts";
import { buildReadIdFrame, parseCivFrames, radioAddressFromReply } from "../src/shared/civFrame.ts";

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const path = arg("port", "/dev/cu.usbmodem21101");
const baud = Number.parseInt(arg("baud", "19200"), 10);
const range = arg("range", "0-2").split("-").map((n) => Number.parseInt(n, 10));
const explicitAddress = arg("address", null);

function openPort() {
  const port = new SerialPort({ path, baudRate: baud, autoOpen: false });
  const buffered = [];
  port.on("data", (chunk) => buffered.push(chunk));
  port.on("error", () => {});
  return new Promise((resolve, reject) => {
    port.open((err) => {
      if (err) return reject(err);
      resolve({
        write: (data) =>
          new Promise((res, rej) => port.write(Buffer.from(data), (e) => (e ? rej(e) : res()))),
        read: (windowMs) =>
          new Promise((res) =>
            setTimeout(() => res(Uint8Array.from(Buffer.concat(buffered.splice(0)))), windowMs),
          ),
        close: () => new Promise((res) => (port.isOpen ? port.close(() => res()) : res())),
      });
    });
  });
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const scanRange = { firstHigh: range[0] ?? 0, lastHigh: range[1] ?? 2 };

console.log(`Opening ${path} at ${baud} baud…`);
const port = await openPort();

try {
  // Find the radio unless told. Same read the app's own detector uses.
  let radioAddress = explicitAddress ? Number.parseInt(explicitAddress, 16) : null;
  if (radioAddress === null) {
    await port.write(buildReadIdFrame(0x00));
    radioAddress = radioAddressFromReply(parseCivFrames(await port.read(250)));
    if (radioAddress === null) {
      console.error("No Icom answered. Check the port, the baud rate, and that CI-V Transceive is on.");
      process.exit(1);
    }
  }
  console.log(`Radio at CI-V address ${radioAddress.toString(16).toUpperCase()}h.`);
  console.log(`Scanning 1A 05 ${scanRange.firstHigh.toString(16).padStart(2, "0").toUpperCase()}xx ` +
    `through ${scanRange.lastHigh.toString(16).padStart(2, "0").toUpperCase()}xx. Reads only — nothing is written.\n`);

  const progress = (done, total) => {
    if (done % 100 === 0 || done === total) process.stdout.write(`\r  ${done}/${total} addresses…`);
  };

  const before = await scanMenu(port, radioAddress, scanRange, progress);
  console.log(`\nRead ${before.length} menu settings.\n`);

  console.log("Now, ON THE RADIO, change ONLY the one setting you want the address for.");
  console.log("  For DATA MOD:  MENU > SET > Connectors > DATA MOD  — switch it, e.g. USB -> ACC.");
  console.log("Change nothing else, and do not touch the VFO.\n");
  await rl.question("Press Enter when you have changed it… ");

  const after = await scanMenu(port, radioAddress, scanRange, progress);
  console.log("\n");

  const changed = diffScans(before, after);
  if (changed.length === 0) {
    console.log("Nothing changed. Either the setting was not altered, or it lives outside the");
    console.log(`scanned range — try a wider one, e.g. --range 0-4.`);
  } else if (changed.length === 1) {
    console.log(`Found it:  ${changed[0].summary}`);
    console.log(`\nThe sub-address is ${changed[0].address.high.toString(16).padStart(2, "0").toUpperCase()} ` +
      `${changed[0].address.low.toString(16).padStart(2, "0").toUpperCase()}.`);
    console.log("Put the radio's setting back the way you want it, then give this line to WL2GO.");
  } else {
    console.log(`${changed.length} settings changed, so more than one thing moved:`);
    for (const change of changed) console.log(`  ${change.summary}`);
    console.log("\nPut them back, then run this again changing ONLY the one setting.");
  }
} finally {
  rl.close();
  await port.close();
}
