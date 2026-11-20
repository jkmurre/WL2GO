import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { likelyRadioInterface, normalisePorts } from "./serialPortService.ts";

describe("normalisePorts", () => {
  it("normalises missing metadata to null rather than undefined", () => {
    const ports = normalisePorts([{ path: "/dev/ttyUSB0" }], "linux");
    assert.deepEqual(ports, [
      {
        path: "/dev/ttyUSB0",
        systemPath: "/dev/ttyUSB0",
        manufacturer: null,
        serialNumber: null,
        vendorId: null,
        productId: null,
        likelyRadioInterface: false,
      },
    ]);
  });

  it("keeps the identifiers used to recognise a known interface", () => {
    const ports = normalisePorts(
      [
        {
          path: "/dev/tty.SLAB_USBtoUART",
          manufacturer: "Silicon Labs",
          serialNumber: "0001",
          vendorId: "10c4",
          productId: "ea60",
        },
      ],
      "darwin",
    );
    assert.equal(ports[0].manufacturer, "Silicon Labs");
    assert.equal(ports[0].vendorId, "10c4");
    assert.equal(ports[0].productId, "ea60");
  });

  it("stores the callout node on macOS, not the tty node", () => {
    // Opening /dev/tty.X blocks until carrier detect asserts, which a radio's
    // CAT port never does. serialport enumerates the tty form, so this is where
    // it gets corrected -- the value stored in a profile goes on to rigctld.
    const ports = normalisePorts([{ path: "/dev/tty.usbserial-1420", vendorId: "0403" }], "darwin");
    assert.equal(ports[0].path, "/dev/cu.usbserial-1420");
    assert.equal(ports[0].systemPath, "/dev/tty.usbserial-1420");
  });

  it("leaves paths alone off macOS", () => {
    // Linux has no cu/tty split, and rewriting would invent a path.
    const ports = normalisePorts([{ path: "/dev/ttyUSB0", vendorId: "0403" }], "linux");
    assert.equal(ports[0].path, "/dev/ttyUSB0");
    const win = normalisePorts([{ path: "COM3", vendorId: "0403" }], "win32");
    assert.equal(win[0].path, "COM3");
  });

  it("leaves a macOS path that is already a callout node alone", () => {
    const ports = normalisePorts([{ path: "/dev/cu.usbserial-1420" }], "darwin");
    assert.equal(ports[0].path, "/dev/cu.usbserial-1420");
  });

  it("sorts probable radio interfaces first without hiding the others", () => {
    // macOS always contributes a Bluetooth entry; it must not sit above the
    // operator's adapter, and it must not be removed either -- see
    // likelyRadioInterface for why filtering is the wrong tool.
    const ports = normalisePorts(
      [
        { path: "/dev/tty.Bluetooth-Incoming-Port" },
        { path: "/dev/tty.usbserial-1420", vendorId: "0403" },
        { path: "/dev/tty.debug-console" },
      ],
      "darwin",
    );
    assert.deepEqual(
      ports.map((p) => p.path),
      ["/dev/cu.usbserial-1420", "/dev/cu.Bluetooth-Incoming-Port", "/dev/cu.debug-console"],
    );
    assert.equal(ports.length, 3);
  });

  it("drops entries with no path and sorts the rest", () => {
    const ports = normalisePorts([{ path: "/dev/ttyS1" }, { path: "" }, {}, { path: "/dev/ttyS0" }], "linux");
    assert.deepEqual(
      ports.map((p) => p.path),
      ["/dev/ttyS0", "/dev/ttyS1"],
    );
  });

  it("returns an empty list when no ports are connected", () => {
    assert.deepEqual(normalisePorts([], "darwin"), []);
  });
});

describe("likelyRadioInterface", () => {
  it("treats a USB vendor id as the signal", () => {
    assert.equal(likelyRadioInterface({ vendorId: "0403" }), true);
    assert.equal(likelyRadioInterface({ vendorId: null }), false);
  });
});
