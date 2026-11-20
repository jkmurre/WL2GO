import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { hostTarget, inspectBinary, isCompatibleWithHost, parseExecutableHeader } from "./binaryInfo.ts";

const MACHO_CPU_ARM64 = 0x0100000c;
const MACHO_CPU_X86_64 = 0x01000007;

function machoLittleEndian(cpuType: number): Buffer {
  const buf = Buffer.alloc(64);
  buf.writeUInt32BE(0xcffaedfe, 0); // byte-swapped 64-bit magic
  buf.writeUInt32LE(cpuType, 4);
  return buf;
}

function machoUniversal(cpuType: number): Buffer {
  const buf = Buffer.alloc(64);
  buf.writeUInt32BE(0xcafebabe, 0);
  buf.writeUInt32BE(1, 4); // nfat_arch
  buf.writeUInt32BE(cpuType, 8);
  return buf;
}

function elf(machine: number): Buffer {
  const buf = Buffer.alloc(64);
  buf[0] = 0x7f;
  buf[1] = 0x45;
  buf[2] = 0x4c;
  buf[3] = 0x46;
  buf[4] = 2; // 64-bit
  buf[5] = 1; // little endian
  buf.writeUInt16LE(machine, 18);
  return buf;
}

function pe(machine: number): Buffer {
  const buf = Buffer.alloc(128);
  buf[0] = 0x4d; // 'M'
  buf[1] = 0x5a; // 'Z'
  buf.writeUInt32LE(0x40, 0x3c);
  buf.writeUInt32LE(0x00004550, 0x40); // 'PE\0\0'
  buf.writeUInt16LE(machine, 0x44);
  return buf;
}

describe("parseExecutableHeader", () => {
  it("identifies Mach-O arm64", () => {
    assert.deepEqual(parseExecutableHeader(machoLittleEndian(MACHO_CPU_ARM64)), {
      format: "macho",
      arch: "arm64",
    });
  });

  it("identifies Mach-O x64", () => {
    assert.deepEqual(parseExecutableHeader(machoLittleEndian(MACHO_CPU_X86_64)), {
      format: "macho",
      arch: "x64",
    });
  });

  it("reads the first slice of a universal Mach-O binary", () => {
    assert.deepEqual(parseExecutableHeader(machoUniversal(MACHO_CPU_ARM64)), {
      format: "macho",
      arch: "arm64",
    });
  });

  it("identifies ELF aarch64 and x86-64", () => {
    assert.deepEqual(parseExecutableHeader(elf(0xb7)), { format: "elf", arch: "arm64" });
    assert.deepEqual(parseExecutableHeader(elf(0x3e)), { format: "elf", arch: "x64" });
  });

  it("identifies PE x64 and arm64", () => {
    assert.deepEqual(parseExecutableHeader(pe(0x8664)), { format: "pe", arch: "x64" });
    assert.deepEqual(parseExecutableHeader(pe(0xaa64)), { format: "pe", arch: "arm64" });
  });

  it("returns unknown for non-executable and truncated input", () => {
    assert.deepEqual(parseExecutableHeader(Buffer.from("not a binary at all")), {
      format: "unknown",
      arch: "unknown",
    });
    assert.deepEqual(parseExecutableHeader(Buffer.alloc(2)), { format: "unknown", arch: "unknown" });
  });
});

describe("hostTarget", () => {
  it("maps each platform to its executable format", () => {
    assert.equal(hostTarget("darwin", "arm64").format, "macho");
    assert.equal(hostTarget("linux", "x64").format, "elf");
    assert.equal(hostTarget("win32", "x64").format, "pe");
  });

  it("maps Node arch names to executable arch names", () => {
    assert.equal(hostTarget("linux", "x64").arch, "x64");
    assert.equal(hostTarget("linux", "arm64").arch, "arm64");
    assert.equal(hostTarget("linux", "ia32").arch, "x86");
  });
});

describe("isCompatibleWithHost", () => {
  const macArm = hostTarget("darwin", "arm64");

  it("rejects a Linux binary on macOS", () => {
    // This is exactly the failure that blocked the previous session: a
    // node_modules copied from a Linux box onto a Mac.
    assert.equal(isCompatibleWithHost({ format: "elf", arch: "arm64" }, macArm), false);
  });

  it("accepts a matching Mach-O arm64 binary", () => {
    assert.equal(isCompatibleWithHost({ format: "macho", arch: "arm64" }, macArm), true);
  });

  it("accepts x64 on Apple Silicon via Rosetta", () => {
    assert.equal(isCompatibleWithHost({ format: "macho", arch: "x64" }, macArm), true);
  });

  it("rejects arm64 on an Intel Mac", () => {
    assert.equal(
      isCompatibleWithHost({ format: "macho", arch: "arm64" }, hostTarget("darwin", "x64")),
      false,
    );
  });

  it("rejects an unidentifiable architecture", () => {
    assert.equal(isCompatibleWithHost({ format: "macho", arch: "unknown" }, macArm), false);
  });
});

describe("inspectBinary", () => {
  it("reports a missing file without throwing", async () => {
    const info = await inspectBinary("/definitely/not/here/pat");
    assert.equal(info.exists, false);
    assert.equal(info.matchesHost, false);
    assert.equal(info.sizeBytes, null);
  });

  it("identifies the vendored Pat binary as runnable on this host", async (t) => {
    const patPath = path.resolve(
      import.meta.dirname,
      "../../../resources/bin",
      process.platform,
      process.arch,
      process.platform === "win32" ? "pat.exe" : "pat",
    );
    if (!existsSync(patPath)) {
      t.skip("Pat is not vendored yet; run npm run build:pat");
      return;
    }

    const info = await inspectBinary(patPath);
    assert.equal(info.exists, true);
    assert.equal(info.matchesHost, true, `vendored Pat is ${info.format}/${info.arch}`);
    assert.ok((info.sizeBytes ?? 0) > 0);
  });
});
