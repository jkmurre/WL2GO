import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applySuggestion,
  collectRecentContacts,
  suggestContacts,
  tokenAtCaret,
  type ContactRow,
} from "./addressCompletion.ts";
import type { RecentContact } from "./ipcContract.ts";

function row(overrides: Partial<ContactRow>): ContactRow {
  return { date: "2026-08-24T14:32:00.000Z", from: "W1AW", to: ["N1CALL"], cc: [], ...overrides };
}

function contact(address: string, lastUsed = "2026-08-24T14:32:00.000Z"): RecentContact {
  return { address, lastUsed, count: 1 };
}

describe("collectRecentContacts", () => {
  it("takes the sender of incoming mail and the recipients of outgoing mail", () => {
    const contacts = collectRecentContacts(
      [
        row({ date: "2026-08-24T10:00:00.000Z", from: "N1CALL", to: ["N0CALL"], cc: ["ops@example.org"] }),
        row({ date: "2026-08-23T10:00:00.000Z", from: "W1AW", to: ["N1CALL", "K1ABC"] }),
      ],
      "N1CALL",
      10,
    );

    // K1ABC was only a fellow recipient of incoming mail: not traffic with them.
    assert.deepEqual(
      contacts.map((c) => c.address),
      ["N0CALL", "ops@example.org", "W1AW"],
    );
  });

  it("treats a message from the operator's winlink.org address as outgoing", () => {
    const contacts = collectRecentContacts(
      [row({ from: "n1call@winlink.org", to: ["N0CALL"] })],
      "N1CALL",
      10,
    );
    assert.deepEqual(contacts.map((c) => c.address), ["N0CALL"]);
  });

  it("never offers the operator themselves, in either form", () => {
    const contacts = collectRecentContacts(
      [row({ from: "N1CALL", to: ["N1CALL", "N1CALL@winlink.org", "W1AW"] })],
      "N1CALL",
      10,
    );
    assert.deepEqual(contacts.map((c) => c.address), ["W1AW"]);
  });

  it("merges case variants, counting both and keeping the newest spelling", () => {
    const contacts = collectRecentContacts(
      [
        row({ date: "2026-08-20T00:00:00.000Z", from: "Bob@Example.org" }),
        row({ date: "2026-08-24T00:00:00.000Z", from: "bob@example.org" }),
      ],
      "N1CALL",
      10,
    );
    assert.deepEqual(contacts, [{ address: "bob@example.org", lastUsed: "2026-08-24T00:00:00.000Z", count: 2 }]);
  });

  it("orders by recency, breaks ties by count, and caps the list", () => {
    const contacts = collectRecentContacts(
      [
        row({ date: "2026-08-24T00:00:00.000Z", from: "AAA" }),
        row({ date: "2026-08-24T00:00:00.000Z", from: "BBB" }),
        row({ date: "2026-08-01T00:00:00.000Z", from: "BBB" }),
        row({ date: "2026-08-10T00:00:00.000Z", from: "CCC" }),
      ],
      "N1CALL",
      2,
    );
    assert.deepEqual(contacts.map((c) => c.address), ["BBB", "AAA"]);
  });

  it("returns nothing for an empty mailbox", () => {
    assert.deepEqual(collectRecentContacts([], "N1CALL", 10), []);
  });
});

describe("tokenAtCaret", () => {
  it("finds the address around the caret", () => {
    assert.deepEqual(tokenAtCaret("W1AW, K1A, N0CALL", 9), { start: 6, end: 9, text: "K1A" });
    assert.deepEqual(tokenAtCaret("W1AW, K1A, N0CALL", 7), { start: 6, end: 9, text: "K1A" });
  });

  it("splits on spaces, commas and semicolons alike", () => {
    assert.equal(tokenAtCaret("W1AW;K1", 7).text, "K1");
    assert.equal(tokenAtCaret("W1AW K1", 7).text, "K1");
  });

  it("is empty right after a separator and in an empty field", () => {
    assert.deepEqual(tokenAtCaret("W1AW, ", 6), { start: 6, end: 6, text: "" });
    assert.deepEqual(tokenAtCaret("", 0), { start: 0, end: 0, text: "" });
  });

  it("clamps a caret past the end", () => {
    assert.equal(tokenAtCaret("W1A", 99).text, "W1A");
  });
});

describe("suggestContacts", () => {
  const contacts = [contact("W1AW"), contact("ops@example.org"), contact("K1ABC"), contact("w7xyz@ham.test")];

  it("matches a prefix of the address, case-insensitively", () => {
    assert.deepEqual(suggestContacts(contacts, "w1", []).map((c) => c.address), ["W1AW"]);
    assert.deepEqual(suggestContacts(contacts, "OPS", []).map((c) => c.address), ["ops@example.org"]);
  });

  it("matches a prefix of the domain", () => {
    assert.deepEqual(suggestContacts(contacts, "exa", []).map((c) => c.address), ["ops@example.org"]);
  });

  it("does not match from the middle of an address", () => {
    assert.deepEqual(suggestContacts(contacts, "AW", []), []);
  });

  it("leaves out addresses already in the field", () => {
    assert.deepEqual(suggestContacts(contacts, "", ["w1aw", "K1ABC"]).map((c) => c.address), [
      "ops@example.org",
      "w7xyz@ham.test",
    ]);
  });

  it("returns the most recent contacts for an empty query, up to the limit", () => {
    assert.deepEqual(suggestContacts(contacts, "", [], 2).map((c) => c.address), ["W1AW", "ops@example.org"]);
  });
});

describe("applySuggestion", () => {
  it("completes the last address and leaves room for the next", () => {
    assert.deepEqual(applySuggestion("N0CALL, W1", { start: 8, end: 10 }, "W1AW"), {
      value: "N0CALL, W1AW, ",
      caret: 14,
    });
  });

  it("does not double a separator when completing in the middle", () => {
    assert.deepEqual(applySuggestion("W1, N0CALL", { start: 0, end: 2 }, "W1AW"), {
      value: "W1AW, N0CALL",
      caret: 4,
    });
  });

  it("fills an empty field", () => {
    assert.deepEqual(applySuggestion("", { start: 0, end: 0 }, "W1AW"), { value: "W1AW, ", caret: 6 });
  });
});
