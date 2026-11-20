import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  draftFromQueued,
  MAX_SUBJECT_LENGTH,
  FORWARD_UNCHANGED_NOTICE,
  addressWarnings,
  buildAcknowledgement,
  buildForward,
  buildForwardUnchanged,
  buildReply,
  buildReplyAll,
  draftToFields,
  emptyDraft,
  formatWinlinkDate,
  internetRecipients,
  isInternetAddress,
  isOwnAddress,
  parseAddresses,
  quoteBody,
  validateDraft,
  type ComposeDraft,
} from "./composeModel.ts";
import type { MailMessage } from "./ipcContract.ts";

function original(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    box: "in",
    mid: "E88DNN8D4ONK",
    date: "2026-08-24T14:32:00.000Z",
    from: "N1CALL",
    to: ["W1AW"],
    cc: [],
    subject: "Sunday net check-in",
    unread: false,
    p2pOnly: false,
    attachments: [],
    body: "All stations please acknowledge.",
    ...overrides,
  };
}

function draft(overrides: Partial<ComposeDraft> = {}): ComposeDraft {
  return { ...emptyDraft("d1"), to: "W1AW", subject: "Net", body: "Text", ...overrides };
}

describe("parseAddresses", () => {
  it("splits on whitespace, commas and semicolons alike, as Pat does", () => {
    assert.deepEqual(parseAddresses("W1AW, K1ABC; N0CALL N1CALL"), ["W1AW", "K1ABC", "N0CALL", "N1CALL"]);
  });

  it("collapses runs of separators", () => {
    assert.deepEqual(parseAddresses("W1AW ,;  K1ABC"), ["W1AW", "K1ABC"]);
  });

  it("drops duplicates regardless of case", () => {
    // Callsigns are conventionally upper case, but a field is typed by hand.
    assert.deepEqual(parseAddresses("W1AW, w1aw, W1AW"), ["W1AW"]);
  });

  it("returns nothing for an empty or separator-only field", () => {
    assert.deepEqual(parseAddresses(""), []);
    assert.deepEqual(parseAddresses("  , ; "), []);
  });

  it("keeps internet addresses intact", () => {
    assert.deepEqual(parseAddresses("ops@example.org; W1AW"), ["ops@example.org", "W1AW"]);
  });
});

describe("internet addresses", () => {
  it("treats anything with an @ as internet mail and anything else as Winlink", () => {
    assert.equal(isInternetAddress("ops@example.org"), true);
    assert.equal(isInternetAddress("W1AW"), false);
    assert.equal(isInternetAddress("SAREX-1"), false);
  });

  it("preserves the case an email address was typed in", () => {
    // Local parts may be case-sensitive at the receiving server, so only the
    // duplicate check folds case -- never the address that is transmitted.
    assert.deepEqual(parseAddresses("Bob.Smith@Example.ORG"), ["Bob.Smith@Example.ORG"]);
  });

  it("still collapses the same address typed twice in different cases", () => {
    assert.deepEqual(parseAddresses("bob@example.org, BOB@EXAMPLE.ORG"), ["bob@example.org"]);
  });

  it("collects internet recipients from both To and Cc", () => {
    assert.deepEqual(
      internetRecipients({ to: "W1AW, ops@example.org", cc: "K1ABC; sar@county.example" }),
      ["ops@example.org", "sar@county.example"],
    );
  });

  it("names an address in both To and Cc only once", () => {
    assert.deepEqual(internetRecipients({ to: "ops@example.org", cc: "ops@example.org" }), ["ops@example.org"]);
  });

  it("recognises the operator by callsign and by their winlink.org address", () => {
    assert.equal(isOwnAddress("N1CALL", "N1CALL"), true);
    assert.equal(isOwnAddress("n1call@winlink.org", "N1CALL"), true);
    assert.equal(isOwnAddress("W1AW", "N1CALL"), false);
  });

  it("does not claim an unrelated provider's mailbox as the operator's", () => {
    // Dropping a real recipient from a Cc is worse than the fault being fixed.
    assert.equal(isOwnAddress("N1CALL@gmail.com", "N1CALL"), false);
  });

  it("sends an email address through to Pat unchanged", () => {
    const fields = draftToFields(draft({ to: "W1AW, ops@example.org" }), "2026/08/25 12:00");
    assert.equal(fields.to, "W1AW,ops@example.org");
  });

  it("replies to an internet sender at their email address", () => {
    // Pat gives us fbb's {Proto:"SMTP", Addr:"bob@example.org"}; the mapper
    // keeps only the address, so a reply must go straight back to it.
    const reply = buildReply("d1", original({ from: "bob@example.org" }), { mycall: "W1AW" });
    assert.equal(reply.to, "bob@example.org");
  });

  it("does not block sending to an email address", () => {
    assert.deepEqual(validateDraft(draft({ to: "ops@example.org" })), []);
  });
});

describe("addressWarnings", () => {
  const quiet = { to: "W1AW", cc: "", p2pOnly: false };

  it("says nothing about callsigns", () => {
    assert.deepEqual(addressWarnings(quiet), []);
  });

  it("never questions an address without an @", () => {
    // Tactical and group addresses are legitimate and unguessable in shape.
    // Warning about them would train the operator to ignore the warnings.
    assert.deepEqual(addressWarnings({ ...quiet, to: "SAREX-1 W1AW/P NTS_TRAFFIC" }), []);
  });

  it("says nothing about a well-formed email address", () => {
    assert.deepEqual(addressWarnings({ ...quiet, to: "ops@example.co.uk" }), []);
  });

  it("accepts an explicit SMTP proto prefix without complaint", () => {
    assert.deepEqual(addressWarnings({ ...quiet, to: "SMTP:ops@example.org" }), []);
  });

  it("flags an address whose domain has no dot", () => {
    const warnings = addressWarnings({ ...quiet, to: "bob@gmail" });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /bob@gmail/);
  });

  it("flags a trailing @ and a doubled @", () => {
    assert.equal(addressWarnings({ ...quiet, to: "bob@" }).length, 1);
    assert.equal(addressWarnings({ ...quiet, to: "bob@@example.org" }).length, 1);
  });

  it("warns that peer-to-peer cannot reach an internet recipient", () => {
    // P2P never touches the CMS, and the CMS is what holds the internet
    // gateway -- so this is undeliverable, not merely slow.
    const warnings = addressWarnings({ to: "W1AW", cc: "ops@example.org", p2pOnly: true });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /ops@example\.org/);
  });

  it("does not warn about peer-to-peer when every recipient is a callsign", () => {
    assert.deepEqual(addressWarnings({ to: "W1AW, K1ABC", cc: "", p2pOnly: true }), []);
  });

  it("never disables Send: a warning is not a validation problem", () => {
    const bad = draft({ to: "bob@gmail", p2pOnly: true });
    assert.ok(addressWarnings(bad).length > 0);
    assert.deepEqual(validateDraft(bad), []);
  });
});

describe("validateDraft", () => {
  it("accepts a complete draft", () => {
    assert.deepEqual(validateDraft(draft()), []);
  });

  it("requires a recipient", () => {
    assert.deepEqual(
      validateDraft(draft({ to: "  " })).map((p) => p.field),
      ["to"],
    );
  });

  it("requires a subject, because Pat rejects an empty one", () => {
    // Pat's own UI substitutes "<No subject>" here; we tell the operator.
    assert.deepEqual(
      validateDraft(draft({ subject: "   " })).map((p) => p.field),
      ["subject"],
    );
  });

  it("requires a body, because Pat rejects an empty one", () => {
    assert.deepEqual(
      validateDraft(draft({ body: "\n\n" })).map((p) => p.field),
      ["body"],
    );
  });

  it("enforces Pat's subject length exactly at the boundary", () => {
    assert.deepEqual(validateDraft(draft({ subject: "x".repeat(MAX_SUBJECT_LENGTH) })), []);
    assert.equal(validateDraft(draft({ subject: "x".repeat(MAX_SUBJECT_LENGTH + 1) })).length, 1);
  });

  it("reports every problem at once rather than one at a time", () => {
    assert.equal(validateDraft(emptyDraft("d1")).length, 3);
  });
});

describe("formatWinlinkDate", () => {
  it("uses Winlink's layout in UTC", () => {
    assert.equal(formatWinlinkDate("2026-08-24T14:32:00.000Z"), "2026/08/24 14:32");
  });

  it("converts an offset to UTC rather than printing local time", () => {
    assert.equal(formatWinlinkDate("2026-08-24T16:32:00+02:00"), "2026/08/24 14:32");
  });

  it("survives an unparseable date", () => {
    assert.equal(formatWinlinkDate("nonsense"), "unknown date");
  });
});

describe("quoteBody", () => {
  it("matches Pat's quote format byte for byte", () => {
    // Replies must read the same in every Winlink client in the thread.
    assert.equal(
      quoteBody(original({ body: "line one\nline two" })),
      "--- 2026/08/24 14:32 N1CALL wrote: ---\n>line one\n>line two\n",
    );
  });

  it("quotes an empty body without losing the header", () => {
    assert.equal(quoteBody(original({ body: "" })), "--- 2026/08/24 14:32 N1CALL wrote: ---\n>\n");
  });

  it("treats a missing body as empty", () => {
    assert.match(quoteBody(original({ body: null })), /wrote: ---\n>/);
  });

  it("re-quotes text that was already quoted, deepening it", () => {
    assert.match(quoteBody(original({ body: ">earlier" })), />>earlier/);
  });
});

describe("buildReply", () => {
  it("addresses the sender and prefixes the subject", () => {
    const reply = buildReply("d1", original(), { mycall: "W1AW" });

    assert.equal(reply.to, "N1CALL");
    assert.equal(reply.subject, "Re: Sunday net check-in");
  });

  it("does not stack Re: prefixes", () => {
    const reply = buildReply("d1", original({ subject: "Re: Sunday net" }), { mycall: "W1AW" });
    assert.equal(reply.subject, "Re: Sunday net");
  });

  it("leaves room above the quote for the operator to write", () => {
    assert.match(buildReply("d1", original(), { mycall: "W1AW" }).body, /^\n\n--- /);
  });

  it("copies no one", () => {
    assert.equal(buildReply("d1", original(), { mycall: "W1AW" }).cc, "");
  });

  it("carries no attachments: a reply is not a forward", () => {
    const reply = buildReply("d1", original({ attachments: [{ name: "a.jpg", sizeBytes: 10 }] }), { mycall: "W1AW" });
    assert.deepEqual(reply.attachments, []);
  });
});

describe("buildReplyAll", () => {
  it("copies the other recipients", () => {
    const message = original({ to: ["W1AW", "K1ABC"], cc: ["N0CALL"] });
    const reply = buildReplyAll("d1", message, { mycall: "W1AW" });

    assert.equal(reply.to, "N1CALL");
    assert.deepEqual(parseAddresses(reply.cc), ["K1ABC", "N0CALL"]);
  });

  it("does not copy the operator themselves", () => {
    const reply = buildReplyAll("d1", original({ to: ["W1AW", "K1ABC"] }), { mycall: "W1AW" });
    assert.ok(!parseAddresses(reply.cc).includes("W1AW"));
  });

  it("does not copy the sender, who is already the recipient", () => {
    const message = original({ from: "N1CALL", to: ["W1AW"], cc: ["N1CALL"] });
    const reply = buildReplyAll("d1", message, { mycall: "W1AW" });

    assert.ok(!parseAddresses(reply.cc).includes("N1CALL"));
    assert.equal(reply.to, "N1CALL");
  });

  it("ignores the case a callsign was typed in", () => {
    const reply = buildReplyAll("d1", original({ to: ["w1aw", "K1ABC"] }), { mycall: "W1AW" });
    assert.deepEqual(parseAddresses(reply.cc), ["K1ABC"]);
  });

  it("leaves Cc empty when there was no one else", () => {
    assert.equal(buildReplyAll("d1", original({ to: ["W1AW"] }), { mycall: "W1AW" }).cc, "");
  });
});

describe("buildReplyAll with internet addresses", () => {
  it("drops the operator's own winlink.org address from the Cc", () => {
    // A message that came in through the gateway carries the internet form, so
    // matching only the bare callsign would send the operator a copy of their
    // own reply -- out through the CMS and back, over the air.
    const reply = buildReplyAll("d1", original({ from: "W1AW", to: ["N1CALL@winlink.org", "K1ABC"] }), {
      mycall: "N1CALL",
    });
    assert.deepEqual(parseAddresses(reply.cc), ["K1ABC"]);
  });

  it("keeps an internet recipient who is not the operator", () => {
    const reply = buildReplyAll("d1", original({ from: "W1AW", to: ["ops@example.org", "N1CALL"] }), {
      mycall: "N1CALL",
    });
    assert.deepEqual(parseAddresses(reply.cc), ["ops@example.org"]);
  });

  it("still drops the sender when the sender is an email address", () => {
    const reply = buildReplyAll("d1", original({ from: "bob@example.org", to: ["bob@example.org", "K1ABC"] }), {
      mycall: "N1CALL",
    });
    assert.equal(reply.to, "bob@example.org");
    assert.deepEqual(parseAddresses(reply.cc), ["K1ABC"]);
  });
});

describe("buildForward", () => {
  it("prefixes the subject and quotes the body", () => {
    const forward = buildForward("d1", original());

    assert.equal(forward.subject, "Fw: Sunday net check-in");
    assert.match(forward.body, /^--- 2026\/08\/24 14:32 N1CALL wrote: ---/);
  });

  it("leaves the recipient for the operator to fill in", () => {
    assert.equal(buildForward("d1", original()).to, "");
  });

  it("carries the attachments across", () => {
    const forward = buildForward("d1", original({ attachments: [{ name: "photo.jpg", sizeBytes: 40213 }] }));
    assert.deepEqual(
      forward.attachments.map((a) => a.name),
      ["photo.jpg"],
    );
  });
});

describe("buildForwardUnchanged", () => {
  it("leaves the body verbatim under the notice", () => {
    const forward = buildForwardUnchanged("d1", original({ body: "All stations please acknowledge." }));

    assert.equal(forward.body, `${FORWARD_UNCHANGED_NOTICE}\n\nAll stations please acknowledge.`);
  });

  it("does not quote the original", () => {
    assert.ok(!buildForwardUnchanged("d1", original()).body.includes("wrote: ---"));
  });

  it("leaves the subject alone", () => {
    // "Without changes" means what it says; the notice announces what happened.
    assert.equal(buildForwardUnchanged("d1", original()).subject, "Sunday net check-in");
  });

  it("carries the attachments across", () => {
    const forward = buildForwardUnchanged("d1", original({ attachments: [{ name: "photo.jpg", sizeBytes: 1 }] }));
    assert.deepEqual(
      forward.attachments.map((a) => a.name),
      ["photo.jpg"],
    );
  });

  it("asks only for recipients", () => {
    assert.equal(buildForwardUnchanged("d1", original()).to, "");
  });
});

describe("buildAcknowledgement", () => {
  const context = { mycall: "N1CALL", acknowledgedAt: "2026-08-24T14:32:00.000Z" };

  it("produces exactly the agreed text", () => {
    // This never opens for editing, so the generated text IS the feature.
    const ack = buildAcknowledgement("d1", original({ from: "W1AW" }), context);

    assert.equal(ack.to, "W1AW");
    assert.equal(ack.subject, "ACK: Sunday net check-in");
    assert.equal(
      ack.body,
      "The following message was received by N1CALL.\n\n" +
        "Message ID:   E88DNN8D4ONK\n" +
        "Acknowledged: 2026/08/24 14:32 UTC\n",
    );
  });

  it("passes its own validation, so it can never fail to send", () => {
    assert.deepEqual(validateDraft(buildAcknowledgement("d1", original(), context)), []);
  });

  it("stays valid when the original had no subject", () => {
    const ack = buildAcknowledgement("d1", original({ subject: "" }), context);

    assert.equal(ack.subject, "ACK: ");
    assert.deepEqual(validateDraft(ack), [], "an ACK must never be rejected by Pat");
  });

  it("timestamps when it was acknowledged, not when the message arrived", () => {
    const ack = buildAcknowledgement("d1", original({ date: "2020-01-01T00:00:00.000Z" }), context);
    assert.match(ack.body, /Acknowledged: 2026\/08\/24 14:32 UTC/);
  });
});

describe("draftToFields", () => {
  it("sends the fields Pat reads, and only those", () => {
    const fields = draftToFields(draft({ to: "W1AW; K1ABC", cc: "N0CALL" }), "2026-08-24T14:32:00.000Z");

    assert.deepEqual(Object.keys(fields).sort(), ["body", "cc", "date", "p2ponly", "subject", "to"]);
    assert.equal(fields["to"], "W1AW,K1ABC");
    assert.equal(fields["cc"], "N0CALL");
    assert.equal(fields["date"], "2026-08-24T14:32:00.000Z");
  });

  it("sends p2ponly only when it is set", () => {
    // Pat checks only that the field is non-empty.
    assert.equal(draftToFields(draft({ p2pOnly: false }), "2026-01-01T00:00:00Z")["p2ponly"], "");
    assert.equal(draftToFields(draft({ p2pOnly: true }), "2026-01-01T00:00:00Z")["p2ponly"], "true");
  });

  it("trims the subject but leaves the body untouched", () => {
    const fields = draftToFields(draft({ subject: "  Net  ", body: "  spaced  " }), "2026-01-01T00:00:00Z");

    assert.equal(fields["subject"], "Net");
    assert.equal(fields["body"], "  spaced  ", "body whitespace can be meaningful in Winlink traffic");
  });
});

describe("draftFromQueued", () => {
  it("restores the message as queued, adding and quoting nothing", () => {
    const draft = draftFromQueued("d1", {
      box: "out",
      mid: "Q1",
      date: "2026-08-24T14:32:00.000Z",
      from: "N1CALL",
      to: ["W1AW", "someone@example.org"],
      cc: [],
      subject: "Net report",
      unread: false,
      p2pOnly: false,
      attachments: [{ name: "log.txt", sizeBytes: 5 }],
      body: "Twelve check-ins.",
    });
    assert.deepEqual(draft, {
      id: "d1",
      to: "W1AW, someone@example.org",
      cc: "",
      subject: "Net report",
      body: "Twelve check-ins.",
      p2pOnly: false,
      attachments: [{ name: "log.txt", contentType: "", sizeBytes: 5 }],
    });
    // Round-trips through the same parser the send path uses.
    assert.deepEqual(parseAddresses(draft.to), ["W1AW", "someone@example.org"]);
  });
});
