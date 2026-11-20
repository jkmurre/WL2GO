#!/usr/bin/env node
// Replays a recorded RX WAV through ardopcf's own decoder, with no radio.
//
// This is the other half of WL2GO_RECORD_RX (see src/main/diagnostics/rxRecording.ts).
// Recording answers "is the station's reply in our captured audio"; this answers
// "and can the decoder get it out", repeatably, offline, at any squelch value.
//
// That separation matters because the two failures look identical live. During a
// calling sequence the modem is deaf for every transmission (Capturing = FALSE,
// Modulate.c:701) and StartCapture() then discards all accumulated state
// (PaSound.c:1485-1493). A decode that succeeds here but failed on the air is
// therefore proof of a real-time timing problem rather than a weak signal --
// and a decode that fails here too rules the timing out.
//
// Usage:
//   npm run decode-rx-wav -- <file.wav> [squelch]
//
// squelch defaults to ardopcf's own default of 5 (ARDOPC.c:109). Pass a lower
// number to test whether the leader gate at SoundInput.c:1796 is what rejected
// a reply:
//     if (dblSNdBPwr > (4 + Squelch) && dblSNdBPwrEarly > Squelch && ...)

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const [wav, squelchArg] = process.argv.slice(2);

if (!wav) {
  console.error("Usage: npm run decode-rx-wav -- <file.wav> [squelch]\n");
  console.error("Recordings are written to the WL2GO log directory when Settings >");
  console.error("Diagnostics enables them (or WL2GO_RECORD_RX=1 forces them on),");
  console.error("named ARDOP_rxaudio_<port>_<UTC>.wav.");
  process.exit(2);
}

if (!existsSync(wav)) {
  console.error(`No such file: ${wav}`);
  process.exit(2);
}

const squelch = squelchArg ?? "5";
if (!/^\d+$/.test(squelch)) {
  console.error(`Squelch must be a whole number, not "${squelch}".`);
  process.exit(2);
}

const binary = path.resolve("resources/bin/darwin/arm64/ardopcf");
if (!existsSync(binary)) {
  console.error(`ardopcf not found at ${binary}. Run: npm run build:ardopcf`);
  process.exit(2);
}

// CONSOLELOG 1 is VERBOSE -- ardopcf's levels run backwards, VERBOSE=1 and
// FATAL=6 (log.h:190-191). VERBOSE is what adds FrameType_bytSym
// (SoundInput.c:2094), the per-symbol 4FSK tone magnitudes. One tone near 100%
// is a clean signal; energy smeared across all four is a timebase problem. That
// line is the whole reason to replay offline rather than read the session log,
// where VERBOSE would bury everything else.
//
// A port is required as the positional even though nothing will connect to it.
const args = ["-d", path.resolve(wav), "-H", `CONSOLELOG 1;SQUELCH ${squelch}`, "8515"];

console.error(`Decoding ${wav} at SQUELCH ${squelch}\n`);

const child = spawn(binary, args, { stdio: "inherit" });
child.on("error", (err) => {
  console.error(`Could not run ardopcf: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`\nardopcf terminated on ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
