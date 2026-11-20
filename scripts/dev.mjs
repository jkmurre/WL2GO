#!/usr/bin/env node
// Launches the dev server with ELECTRON_RUN_AS_NODE cleared.
//
// When that variable is set, the electron binary runs as plain Node and no
// window ever appears. Editors that are themselves Electron apps (VS Code, and
// Claude Code) export it into their integrated terminals, so `npm start` would
// silently do nothing there. This already cost this project one full session,
// when it was misdiagnosed as a quirk of the old dev machine.
import { spawn } from "node:child_process";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn("electron-vite", ["dev"], {
  stdio: "inherit",
  env,
  // npm puts node_modules/.bin on PATH; Windows needs a shell to resolve the .cmd shim.
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
