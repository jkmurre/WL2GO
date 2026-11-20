// Identifies what a binary on disk actually is, by reading its header bytes.
//
// This module exists because a whole development session was lost to a
// node_modules/ copied between machines: the Electron binary was a Linux ELF on
// a macOS host, which surfaces only as a confusing spawn failure. Every vendored
// subprocess (pat, ardopcf, rigctld) goes through this check so a mismatch is
// reported in plain language instead of being diagnosed by hand.
//
// Deliberately free of any electron import so it stays unit-testable under
// `node --test`.

import { open, stat } from "node:fs/promises";
import type { BinaryInfo, ExecutableArch, ExecutableFormat } from "../../shared/ipcContract.ts";

export interface ExecutableIdentity {
  format: ExecutableFormat;
  arch: ExecutableArch;
}

/** Bytes needed to identify every format below. */
export const HEADER_BYTES = 64;

// Mach-O CPU types (mach/machine.h). The 0x01000000 bit flags 64-bit.
const MACHO_CPU_X86_64 = 0x01000007;
const MACHO_CPU_ARM64 = 0x0100000c;

// ELF e_machine values.
const ELF_MACHINE_X86_64 = 0x3e;
const ELF_MACHINE_AARCH64 = 0xb7;

// PE IMAGE_FILE_MACHINE values.
const PE_MACHINE_I386 = 0x014c;
const PE_MACHINE_AMD64 = 0x8664;
const PE_MACHINE_ARM64 = 0xaa64;

/**
 * Parses an executable header. Pure and synchronous so it can be tested with
 * hand-built buffers.
 */
export function parseExecutableHeader(header: Buffer): ExecutableIdentity {
  if (header.length < 4) return { format: "unknown", arch: "unknown" };

  const magicBE = header.readUInt32BE(0);

  // Mach-O thin binaries. 0xFEEDFACE/0xFEEDFACF big-endian, byte-swapped
  // variants little-endian; macOS on arm64/x64 uses the little-endian ones.
  if (magicBE === 0xcffaedfe || magicBE === 0xcefaedfe) {
    // Byte-swapped magic => the rest of the header is little-endian.
    return { format: "macho", arch: machoArch(header.readUInt32LE(4)) };
  }
  if (magicBE === 0xfeedface || magicBE === 0xfeedfacf) {
    return { format: "macho", arch: machoArch(header.readUInt32BE(4)) };
  }

  // Mach-O universal ("fat") binaries: report the first slice's architecture.
  if (magicBE === 0xcafebabe || magicBE === 0xbebafeca) {
    if (header.length >= 12) {
      const cpu = magicBE === 0xcafebabe ? header.readUInt32BE(8) : header.readUInt32LE(8);
      return { format: "macho", arch: machoArch(cpu) };
    }
    return { format: "macho", arch: "unknown" };
  }

  // ELF: 0x7F 'E' 'L' 'F'
  if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
    if (header.length < 20) return { format: "elf", arch: "unknown" };
    const littleEndian = header[5] === 1;
    const machine = littleEndian ? header.readUInt16LE(18) : header.readUInt16BE(18);
    return { format: "elf", arch: elfArch(machine) };
  }

  // PE/COFF: 'MZ' stub, with the PE header offset stored at 0x3C.
  if (header[0] === 0x4d && header[1] === 0x5a) {
    if (header.length < 0x40) return { format: "pe", arch: "unknown" };
    const peOffset = header.readUInt32LE(0x3c);
    // The PE header usually lives beyond our 64-byte window; callers that need
    // the architecture should pass a larger buffer.
    if (header.length >= peOffset + 6 && header.readUInt32LE(peOffset) === 0x00004550) {
      return { format: "pe", arch: peArch(header.readUInt16LE(peOffset + 4)) };
    }
    return { format: "pe", arch: "unknown" };
  }

  return { format: "unknown", arch: "unknown" };
}

function machoArch(cpuType: number): ExecutableArch {
  if (cpuType === MACHO_CPU_ARM64) return "arm64";
  if (cpuType === MACHO_CPU_X86_64) return "x64";
  if (cpuType === 7) return "x86";
  return "unknown";
}

function elfArch(machine: number): ExecutableArch {
  if (machine === ELF_MACHINE_AARCH64) return "arm64";
  if (machine === ELF_MACHINE_X86_64) return "x64";
  if (machine === 0x03) return "x86";
  return "unknown";
}

function peArch(machine: number): ExecutableArch {
  if (machine === PE_MACHINE_ARM64) return "arm64";
  if (machine === PE_MACHINE_AMD64) return "x64";
  if (machine === PE_MACHINE_I386) return "x86";
  return "unknown";
}

/** The executable identity a binary must have to run on the given host. */
export function hostTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ExecutableIdentity {
  const format: ExecutableFormat =
    platform === "darwin" ? "macho" : platform === "win32" ? "pe" : platform === "linux" ? "elf" : "unknown";

  const hostArch: ExecutableArch = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : arch === "ia32" ? "x86" : "unknown";

  return { format, arch: hostArch };
}

/**
 * A universal Mach-O binary reports its first slice, so treat any Mach-O as
 * acceptable on macOS when the arch cannot be pinned down, rather than crying
 * wolf. Everything else must match exactly.
 */
export function isCompatibleWithHost(binary: ExecutableIdentity, host: ExecutableIdentity): boolean {
  if (binary.format !== host.format) return false;
  if (binary.arch === "unknown") return false;
  // x64 binaries run on Apple Silicon under Rosetta 2.
  if (host.format === "macho" && host.arch === "arm64" && binary.arch === "x64") return true;
  return binary.arch === host.arch;
}

/** Reads a binary's header and reports what it is, without executing it. */
export async function inspectBinary(filePath: string): Promise<BinaryInfo> {
  const host = hostTarget();

  let sizeBytes: number | null = null;
  try {
    const stats = await stat(filePath);
    sizeBytes = stats.size;
  } catch {
    return {
      path: filePath,
      exists: false,
      format: "unknown",
      arch: "unknown",
      sizeBytes: null,
      matchesHost: false,
    };
  }

  let identity: ExecutableIdentity = { format: "unknown", arch: "unknown" };
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    identity = parseExecutableHeader(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }

  return {
    path: filePath,
    exists: true,
    format: identity.format,
    arch: identity.arch,
    sizeBytes,
    matchesHost: isCompatibleWithHost(identity, host),
  };
}
