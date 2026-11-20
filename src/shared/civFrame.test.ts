import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CIV_BROADCAST_ADDRESS,
  CIV_CONTROLLER_ADDRESS,
  CIV_NAK,
  buildCivFrame,
  buildReadIdFrame,
  formatCivAddress,
  parseCivFrames,
  radioAddressFromReply,
} from "./civFrame.ts";

const MK2 = 0xb6;

describe("buildReadIdFrame", () => {
  it("matches the frame Hamlib's prober sends", () => {
    // rigs/icom/icom.c:9962 -- make_cmd_frame(buf, civ_addr, CTRLID,
    // C_RD_TRXID, S_RD_TRXID, NULL, 0). Byte-for-byte, because a frame that is
    // nearly right draws no reply and looks exactly like an absent radio.
    assert.deepEqual(Array.from(buildReadIdFrame(MK2)), [0xfe, 0xfe, 0xb6, 0xe0, 0x19, 0x00, 0xfd]);
  });

  it("addresses the broadcast probe to 00", () => {
    assert.deepEqual(Array.from(buildReadIdFrame(CIV_BROADCAST_ADDRESS)), [
      0xfe, 0xfe, 0x00, 0xe0, 0x19, 0x00, 0xfd,
    ]);
  });

  it("only ever asks the radio to identify itself", () => {
    // 0x19/0x00 is a read. This test exists so that a future edit which turns
    // the prober into something that can transmit has to delete it first.
    // Byte 4 is the command, byte 5 the subcommand. Checking the whole frame
    // for 0x1C would be wrong rather than merely strict -- 0x1C is also a valid
    // destination address, which the prober's sweep legitimately reaches.
    const frame = Array.from(buildReadIdFrame(MK2));
    assert.equal(frame[4], 0x19, "must be the read-transceiver-ID command");
    assert.equal(frame[5], 0x00);
  });
});

describe("parseCivFrames", () => {
  function reply(from: number, payload: number[] = [0x19, 0x00, from]): number[] {
    return [...buildCivFrame(CIV_CONTROLLER_ADDRESS, from, payload)];
  }

  it("reads one clean reply", () => {
    const frames = parseCivFrames(reply(MK2));
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0], { to: CIV_CONTROLLER_ADDRESS, from: MK2, payload: [0x19, 0x00, MK2] });
  });

  it("reads the echo and the reply as two frames", () => {
    // With CI-V USB Echo Back on -- an operator setting -- our own query comes
    // back before the answer does.
    const bytes = [...buildReadIdFrame(CIV_BROADCAST_ADDRESS), ...reply(MK2)];
    const frames = parseCivFrames(bytes);
    assert.equal(frames.length, 2);
    assert.equal(frames[0].from, CIV_CONTROLLER_ADDRESS);
    assert.equal(frames[1].from, MK2);
  });

  it("ignores leading rubbish left in the port", () => {
    assert.equal(parseCivFrames([0x00, 0xff, 0x12, ...reply(MK2)]).length, 1);
  });

  it("skips a run of extra preambles rather than reading one as an address", () => {
    assert.deepEqual(parseCivFrames([0xfe, 0xfe, 0xfe, MK2, 0xe0, 0x19, 0xfd])[0], {
      to: MK2,
      from: 0xe0,
      payload: [0x19],
    });
  });

  it("drops a truncated frame instead of half-reading it", () => {
    // No terminator yet. Guessing here would report an address assembled from
    // whatever bytes happened to arrive.
    assert.deepEqual(parseCivFrames([0xfe, 0xfe, 0xe0, MK2, 0x19]), []);
  });

  it("drops a frame too short to carry addresses and a payload", () => {
    assert.deepEqual(parseCivFrames([0xfe, 0xfe, 0xe0, 0xfd]), []);
  });

  it("finds nothing in an empty buffer", () => {
    assert.deepEqual(parseCivFrames([]), []);
  });
});

describe("radioAddressFromReply", () => {
  const frames = (bytes: number[]) => parseCivFrames(bytes);

  it("reads the address off the radio rather than off our query", () => {
    // The whole reason the broadcast probe works: we ask address 00 and the
    // answer carries whatever the radio is really set to, including an address
    // the operator changed by hand.
    const bytes = [
      ...buildReadIdFrame(CIV_BROADCAST_ADDRESS),
      ...buildCivFrame(CIV_CONTROLLER_ADDRESS, 0x22, [0x19, 0x00, 0x22]),
    ];
    assert.equal(radioAddressFromReply(frames(bytes)), 0x22);
  });

  it("does not mistake our own echo for a radio", () => {
    assert.equal(radioAddressFromReply(frames([...buildReadIdFrame(MK2)])), null);
  });

  it("treats a NAK as no answer", () => {
    // An older Icom that does not implement 0x19. Something is there, but it
    // did not tell us its address, and inventing one would be worse than
    // reporting nothing.
    const bytes = buildCivFrame(CIV_CONTROLLER_ADDRESS, MK2, [CIV_NAK]);
    assert.equal(radioAddressFromReply(frames([...bytes])), null);
  });

  it("ignores a frame answering some other command", () => {
    const bytes = buildCivFrame(CIV_CONTROLLER_ADDRESS, MK2, [0x03, 0x00]);
    assert.equal(radioAddressFromReply(frames([...bytes])), null);
  });

  it("finds nothing when nothing replied", () => {
    assert.equal(radioAddressFromReply([]), null);
  });
});

describe("formatCivAddress", () => {
  it("matches how Icom's own menus write it", () => {
    assert.equal(formatCivAddress(0xb6), "B6h");
    assert.equal(formatCivAddress(0x04), "04h");
  });
});
