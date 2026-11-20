import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isMailBox, mapPatFolder, mapPatMessage } from "./patMessageMapper.ts";

/**
 * One entry exactly as Pat v1.0.0 serialises it: capitalised keys, no json
 * tags, every field present. Taken from JSONMessage.MarshalJSON.
 */
function patMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    MID: "E88DNN8D4ONK",
    Date: "2026-08-24T14:32:00Z",
    From: { Proto: "", Addr: "N1CALL" },
    To: [{ Proto: "", Addr: "W1AW" }],
    Cc: null,
    Subject: "Test message",
    Body: "",
    BodyHTML: "",
    Files: [],
    P2POnly: false,
    Unread: true,
    ...overrides,
  };
}

describe("mapPatMessage", () => {
  it("maps a listing entry, carrying the box in from the request path", () => {
    const message = mapPatMessage("in", patMessage());

    assert.deepEqual(message, {
      box: "in",
      mid: "E88DNN8D4ONK",
      date: "2026-08-24T14:32:00.000Z",
      from: "N1CALL",
      to: ["W1AW"],
      cc: [],
      subject: "Test message",
      unread: true,
      p2pOnly: false,
      attachments: [],
      body: null,
    });
  });

  it("treats null To and Cc as empty lists", () => {
    // Pat appends to a nil slice, so an absent header marshals as null, not [].
    const message = mapPatMessage("in", patMessage({ To: null, Cc: null }));

    assert.deepEqual(message?.to, []);
    assert.deepEqual(message?.cc, []);
  });

  it("keeps the address of an SMTP recipient, not the protocol", () => {
    const message = mapPatMessage("sent", patMessage({ To: [{ Proto: "SMTP", Addr: "ops@example.org" }] }));

    assert.deepEqual(message?.to, ["ops@example.org"]);
  });

  it("drops address entries that carry no address", () => {
    const message = mapPatMessage("in", patMessage({ To: [{ Proto: "", Addr: "" }, null, { Proto: "", Addr: "W1AW" }] }));

    assert.deepEqual(message?.to, ["W1AW"]);
  });

  it("refuses a message with no MID, because it has nowhere to live", () => {
    assert.equal(mapPatMessage("in", patMessage({ MID: "" })), null);
    assert.equal(mapPatMessage("in", patMessage({ MID: "   " })), null);
    assert.equal(mapPatMessage("in", patMessage({ MID: 42 })), null);
  });

  it("refuses a MID longer than Pat itself allows", () => {
    // Pat's own Validate rejects anything over 12 characters.
    assert.equal(mapPatMessage("in", patMessage({ MID: "A".repeat(13) })), null);
    assert.ok(mapPatMessage("in", patMessage({ MID: "A".repeat(12) })));
  });

  it("normalises a date carrying a local offset to UTC", () => {
    // Pat emits the server's local offset. Two messages minutes apart across a
    // DST change would otherwise sort backwards as strings.
    const message = mapPatMessage("in", patMessage({ Date: "2026-08-24T16:32:00+02:00" }));

    assert.equal(message?.date, "2026-08-24T14:32:00.000Z");
  });

  it("keeps an undated message rather than dropping it, sorted to the end", () => {
    const message = mapPatMessage("in", patMessage({ Date: "not a date" }));

    assert.equal(message?.date, "1970-01-01T00:00:00.000Z");
  });

  it("maps attachments to name and size, never to content", () => {
    const message = mapPatMessage("in", patMessage({ Files: [{ Name: "photo.jpg", Size: 40213 }] }));

    assert.deepEqual(message?.attachments, [{ name: "photo.jpg", sizeBytes: 40213 }]);
  });

  it("tolerates an attachment with a missing or nonsensical size", () => {
    const message = mapPatMessage("in", patMessage({ Files: [{ Name: "a.txt" }, { Name: "b.txt", Size: -1 }] }));

    assert.deepEqual(message?.attachments, [
      { name: "a.txt", sizeBytes: 0 },
      { name: "b.txt", sizeBytes: 0 },
    ]);
  });

  it("distinguishes an unfetched body from an empty one", () => {
    // The listing endpoint always sends "Body":"" -- caching that as a real body
    // would mean never fetching the actual one.
    assert.equal(mapPatMessage("in", patMessage({ Body: "" }))?.body, null);
    assert.equal(mapPatMessage("in", patMessage({ Body: "hello" }))?.body, "hello");
  });

  it("reads the P2P and unread flags", () => {
    const message = mapPatMessage("in", patMessage({ P2POnly: true, Unread: false }));

    assert.equal(message?.p2pOnly, true);
    assert.equal(message?.unread, false);
  });

  it("rejects anything that is not an object", () => {
    assert.equal(mapPatMessage("in", null), null);
    assert.equal(mapPatMessage("in", "a string"), null);
    assert.equal(mapPatMessage("in", []), null);
  });
});

describe("mapPatFolder", () => {
  it("maps a listing and counts what it could not use", () => {
    const folder = mapPatFolder("in", [patMessage(), patMessage({ MID: "" }), patMessage({ MID: "SECOND" })]);

    assert.equal(folder.messages.length, 2);
    assert.equal(folder.skipped, 1);
    assert.deepEqual(
      folder.messages.map((m) => m.mid),
      ["E88DNN8D4ONK", "SECOND"],
    );
  });

  it("treats a non-array response as an empty folder", () => {
    assert.deepEqual(mapPatFolder("in", null), { messages: [], skipped: 0 });
    assert.deepEqual(mapPatFolder("in", { error: "nope" }), { messages: [], skipped: 0 });
  });
});

describe("isMailBox", () => {
  it("accepts Pat's four folders and nothing else", () => {
    for (const box of ["in", "out", "sent", "archive"]) {
      assert.ok(isMailBox(box), `${box} should be a mailbox`);
    }
    assert.equal(isMailBox("drafts"), false);
    assert.equal(isMailBox("trash"), false);
    assert.equal(isMailBox("../../etc/passwd"), false);
    assert.equal(isMailBox(null), false);
  });
});
