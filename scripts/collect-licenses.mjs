#!/usr/bin/env node
// Gathers the license text of everything WL2GO ships into resources/licenses/.
//
// The packaged app redistributes four native programs, the Go modules compiled
// into Pat, the npm packages in app.asar or bundled into the renderer, and
// Electron itself. MIT and BSD require their notices to travel with binaries;
// GPLv2 (rigctld) and LGPL (libhamlib, libusb) require their license texts too.
// electron-builder copies the output into Contents/Resources/licenses/.
//
// Generated from the build inputs rather than kept by hand, so the notices name
// exactly what is in this build. Any component whose license cannot be found
// fails the script: a silent gap here is a compliance gap in the release.
//
// Usage (run after build:pat, build:ardopcf and build:rigctld):
//   node scripts/collect-licenses.mjs

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "resources", "licenses");
const BUILD = path.join(ROOT, ".build");
const PAT_BINARY = path.join(ROOT, "resources", "bin", process.platform, process.arch, "pat");

const LICENSE_FILE = /^(LICEN[CS]E|COPYING)(\.(md|txt))?$/i;

/** @type {{ name: string, version: string, license: string, files: string[] }[]} */
const components = [];
const missing = [];

function add(name, version, license, files) {
  const present = files.filter((f) => existsSync(f));
  if (present.length === 0) {
    missing.push(`${name} ${version}: none of ${files.map((f) => path.relative(ROOT, f)).join(", ")}`);
    return;
  }
  components.push({ name, version, license, files: present });
}

function readTrimmed(file) {
  return readFileSync(file, "utf8").trim();
}

function licenseFilesIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .map((f) => path.join(dir, f));
}

// ------------------------------------------------------------ native programs

const ardopcfVersion = readTrimmed(path.join(ROOT, "vendor", "ardopcf", "ARDOPCF_VERSION"));
const portaudioVersion = readTrimmed(path.join(ROOT, "vendor", "ardopcf", "PORTAUDIO_VERSION"));
const hamlibDir = readdirSync(BUILD).find((d) => d.startsWith("hamlib-")) ?? "hamlib-missing";
const libusbDir = readdirSync(BUILD).find((d) => /^libusb-\d/.test(d)) ?? "libusb-missing";

add("Pat", readTrimmed(path.join(ROOT, "resources", "bin", "PAT_VERSION")), "MIT", [
  path.join(BUILD, "pat", "LICENSE"),
]);
add("ardopcf", ardopcfVersion, "MIT", [path.join(BUILD, "ardopcf", "LICENSE")]);
// ardopcf compiles these vendored libraries in; each carries its own terms.
add("ardopcf: lib/hid (hidapi)", ardopcfVersion, "BSD-style (see text)", [
  path.join(BUILD, "ardopcf", "lib", "hid", "LICENSE.txt"),
  path.join(BUILD, "ardopcf", "lib", "hid", "LICENSE-orig.txt"),
]);
add("ardopcf: lib/zf_log", ardopcfVersion, "MIT", [path.join(BUILD, "ardopcf", "lib", "zf_log", "LICENSE")]);
add("PortAudio", portaudioVersion, "MIT", [path.join(BUILD, "portaudio", "LICENSE.txt")]);
add("Hamlib (rigctld, libhamlib)", hamlibDir.replace("hamlib-", ""), "GPL-2.0-or-later (rigctld), LGPL-2.1-or-later (libhamlib)", [
  path.join(BUILD, hamlibDir, "LICENSE"),
  path.join(BUILD, hamlibDir, "COPYING"),
  path.join(BUILD, hamlibDir, "COPYING.LIB"),
]);
add("libusb (statically linked into libhamlib)", libusbDir.replace("libusb-", ""), "LGPL-2.1-or-later", [
  path.join(BUILD, libusbDir, "COPYING"),
]);

// ------------------------------------------------------- Go modules inside Pat

// Module paths are case-encoded in the module cache: "Pat-Vara" is stored as
// "!pat-!vara", so a capital letter becomes "!" plus its lowercase form.
const encodeModulePath = (p) => p.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);

// cronexpr offers GPLv3 or Apache-2.0 at the user's choice; Apache-2.0 is taken.
const GO_LICENSE_OVERRIDES = { "github.com/gorhill/cronexpr": { license: "Apache-2.0", file: "APLv2" } };

const modCache = execFileSync("go", ["env", "GOMODCACHE"], { encoding: "utf8" }).trim();
const buildInfo = execFileSync("go", ["version", "-m", PAT_BINARY], { encoding: "utf8" })
  .split("\n")
  .map((line) => line.trim().split(/\s+/));
for (const [i, fields] of buildInfo.entries()) {
  if (fields[0] !== "dep") continue;
  let [, modPath, version] = fields;
  // A replaced module is listed as "dep old v" followed by "=> new v".
  if (buildInfo[i + 1]?.[0] === "=>") [, modPath, version] = buildInfo[i + 1];

  const dir = path.join(modCache, `${encodeModulePath(modPath)}@${version}`);
  const override = GO_LICENSE_OVERRIDES[modPath];
  if (override) add(`Go: ${modPath}`, version, override.license, [path.join(dir, override.file)]);
  else add(`Go: ${modPath}`, version, "see text", licenseFilesIn(dir));
}

// ------------------------------------------------------------------ npm + Electron

// Production packages land in app.asar. React, react-dom and scheduler are
// bundled into the renderer whatever their dependency type.
const npmTree = JSON.parse(
  execFileSync("npm", ["ls", "--omit=dev", "--all", "--json", "--long"], { cwd: ROOT, encoding: "utf8" }),
);
const npmSeen = new Map();
(function walk(deps) {
  for (const [name, info] of Object.entries(deps ?? {})) {
    if (info.path && !npmSeen.has(info.path)) npmSeen.set(info.path, { name, version: info.version, license: info.license });
    walk(info.dependencies);
  }
})(npmTree.dependencies);
for (const name of ["react", "react-dom", "scheduler"]) {
  const dir = path.join(ROOT, "node_modules", name);
  if (!npmSeen.has(dir)) {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    npmSeen.set(dir, { name, version: pkg.version, license: pkg.license });
  }
}
// Identical copies nested under different parents need listing only once.
const npmUnique = new Map();
for (const [dir, info] of npmSeen) {
  const key = `${info.name}@${info.version}`;
  if (!npmUnique.has(key)) npmUnique.set(key, { ...info, dir });
}
for (const info of [...npmUnique.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  add(`npm: ${info.name}`, info.version, info.license ?? "see text", licenseFilesIn(info.dir));
}

const electronDist = path.join(ROOT, "node_modules", "electron", "dist");
const electronVersion = readTrimmed(path.join(electronDist, "version"));
add("Electron", electronVersion, "MIT", [path.join(electronDist, "LICENSE")]);

// ------------------------------------------------------------------ write

if (missing.length > 0) {
  console.error("error: no license text found for:");
  for (const m of missing) console.error(`  ${m}`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const rule = "=".repeat(79);
let notices =
  "WL2GO THIRD-PARTY NOTICES\n\n" +
  "WL2GO includes the software listed below. Each is distributed under its own\n" +
  "license, reproduced in full. Chromium's notices, which apply to the Electron\n" +
  "runtime, are in LICENSES.chromium.html alongside this file.\n\n" +
  "Hamlib's rigctld is licensed under the GNU GPL v2, and libhamlib and libusb\n" +
  "under the GNU LGPL v2.1. The complete corresponding source for the versions\n" +
  "shipped, with the build configuration used, is published with each WL2GO\n" +
  "release.\n\n" +
  "Components:\n" +
  components.map((c) => `  - ${c.name} ${c.version} (${c.license})`).join("\n") +
  "\n";
for (const c of components) {
  notices += `\n${rule}\n${c.name} ${c.version}\nLicense: ${c.license}\n${rule}\n`;
  for (const file of c.files) {
    if (c.files.length > 1) notices += `\n--- ${path.basename(file)} ---\n`;
    notices += `\n${readTrimmed(file)}\n`;
  }
}

writeFileSync(path.join(OUT, "THIRD_PARTY_NOTICES.txt"), notices);
copyFileSync(path.join(ROOT, "LICENSE"), path.join(OUT, "LICENSE.txt"));
copyFileSync(path.join(electronDist, "LICENSES.chromium.html"), path.join(OUT, "LICENSES.chromium.html"));

console.log(`==> ${components.length} components -> ${path.relative(ROOT, OUT)}/`);
