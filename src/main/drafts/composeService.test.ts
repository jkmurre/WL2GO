import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { ComposeService, type ComposeApi } from "./composeService.ts";
import { DraftStore } from "./draftStore.ts";
import { emptyDraft, type ComposeDraft } from "../../shared/composeModel.ts";
import type { MailBox, MailMessage } from "../../shared/ipcContract.ts";
import type { MultipartFile } from "../util/multipart.ts";

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

class FakePat implements ComposeApi {
  posted: { fields: Record<string, string>; files: MultipartFile[] }[] = [];
  attachments: Record<string, Buffer> = {};
  failPostWith: Error | null = null;

  postMessage(fields: Record<string, string>, files: readonly MultipartFile[]): Promise<void> {
    if (this.failPostWith) return Promise.reject(this.failPostWith);
    this.posted.push({ fields, files: [...files] });
    return Promise.resolve();
  }

  getAttachment(_box: string, _mid: string, name: string) {
    const bytes = this.attachments[name];
    if (!bytes) return Promise.reject(new Error("not found"));
    return Promise.resolve({ name, contentType: "application/octet-stream", bytes });
  }
}

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    box: "in",
    mid: "E88DNN8D4ONK",
    date: "2026-08-24T14:32:00.000Z",
    from: "W1AW",
    to: ["N1CALL"],
    cc: [],
    subject: "Sunday net check-in",
    unread: false,
    p2pOnly: false,
    attachments: [],
    body: "All stations please acknowledge.",
    ...overrides,
  };
}

interface Harness {
  store: DraftStore;
  pat: FakePat;
  service: ComposeService;
  queued: number;
  draftsAnnounced: number;
  setMessage: (value: MailMessage | null) => void;
}

function harness(options: { callsign?: string } = {}): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), "wl2go-compose-"));
  dirs.push(dir);

  const store = new DraftStore(path.join(dir, "drafts.db"));
  const pat = new FakePat();
  let current: MailMessage | null = message();

  const state = { queued: 0, draftsAnnounced: 0 };

  const service = new ComposeService({
    store,
    getApi: () => pat,
    getCallsign: () => options.callsign ?? "N1CALL",
    getMessage: (_box: MailBox, _mid: string) => current,
    onQueued: () => (state.queued += 1),
    onDraftsChanged: () => (state.draftsAnnounced += 1),
    now: () => new Date("2026-08-24T14:32:00.000Z"),
  });

  return {
    store,
    pat,
    service,
    get queued() {
      return state.queued;
    },
    get draftsAnnounced() {
      return state.draftsAnnounced;
    },
    setMessage: (value) => (current = value),
  } as Harness;
}

function draft(overrides: Partial<ComposeDraft> = {}): ComposeDraft {
  return { ...emptyDraft("d1"), to: "W1AW", subject: "Net", body: "See you at 1900.", ...overrides };
}

describe("ComposeService.send", () => {
  it("posts the draft and removes it", async () => {
    const h = harness();
    h.service.save(draft());

    const result = await h.service.send(draft());

    assert.deepEqual(result, { sent: true, problems: [] });
    assert.equal(h.pat.posted.length, 1);
    assert.equal(h.pat.posted[0]?.fields["to"], "W1AW");
    assert.equal(h.service.get("d1"), null, "the draft should be gone once Pat has it");
  });

  it("triggers a mailbox sync so the message appears in the Outbox", async () => {
    const h = harness();
    await h.service.send(draft());
    assert.equal(h.queued, 1);
  });

  it("refuses an invalid draft without contacting Pat", async () => {
    // Pat's own UI substitutes placeholder text here; we tell the operator.
    const h = harness();
    const result = await h.service.send(draft({ body: "" }));

    assert.equal(result.sent, false);
    assert.equal(result.problems.length, 1);
    assert.equal(h.pat.posted.length, 0, "nothing should have been sent");
  });

  it("reports every problem at once", async () => {
    const h = harness();
    const result = await h.service.send(emptyDraft("d1"));

    assert.equal(result.problems.length, 3);
  });

  it("keeps the draft when Pat rejects the post", async () => {
    // The draft is the only copy until Pat has it; losing it here would lose
    // the operator's message.
    const h = harness();
    h.pat.failPostWith = new Error("Pat API returned status 500");

    await assert.rejects(h.service.send(draft({ body: "important traffic" })));

    assert.equal(h.service.get("d1")?.body, "important traffic", "the draft was lost on a failed send");
  });

  it("sends a draft that was never explicitly saved", async () => {
    const h = harness();
    const result = await h.service.send(draft());

    assert.equal(result.sent, true);
  });

  it("carries stored attachments into the post", async () => {
    const h = harness();
    h.service.save(draft());
    h.service.attach("d1", [{ name: "photo.jpg", contentType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8]) }]);

    await h.service.send(h.service.get("d1")!);

    const files = h.pat.posted[0]?.files ?? [];
    assert.equal(files.length, 1);
    assert.equal(files[0]?.field, "files");
    assert.equal(files[0]?.filename, "photo.jpg");
    assert.ok(files[0]?.bytes.equals(Buffer.from([0xff, 0xd8])));
  });

  it("refuses to send before a callsign is set", async () => {
    const h = harness({ callsign: "" });
    await assert.rejects(h.service.send(draft()), /Finish setup/);
  });
});

describe("ComposeService drafts", () => {
  it("saves and lists a draft", () => {
    const h = harness();
    h.service.save(draft({ subject: "half-written" }));

    assert.deepEqual(
      h.service.list().map((d) => d.subject),
      ["half-written"],
    );
  });

  it("announces a change so the Drafts folder refreshes", () => {
    const h = harness();
    h.service.save(draft());
    assert.ok(h.draftsAnnounced > 0);
  });

  it("keeps attachments across a text-only save", () => {
    // Compose saves text on close; it must not have to carry megabytes of
    // attachment back over IPC to avoid losing them.
    const h = harness();
    h.service.save(draft());
    h.service.attach("d1", [{ name: "photo.jpg", contentType: "image/jpeg", bytes: Buffer.from([1, 2]) }]);

    const reloaded = h.service.get("d1")!;
    h.service.save({ ...reloaded, body: "edited" });

    assert.deepEqual(
      h.service.get("d1")?.attachments.map((f) => f.name),
      ["photo.jpg"],
    );
  });

  it("removes an attachment the draft no longer lists", () => {
    const h = harness();
    h.service.save(draft());
    h.service.attach("d1", [{ name: "photo.jpg", contentType: "image/jpeg", bytes: Buffer.from([1, 2]) }]);

    h.service.save({ ...h.service.get("d1")!, attachments: [] });

    assert.deepEqual(h.service.get("d1")?.attachments, []);
  });

  it("replaces rather than duplicates an attachment with the same name", () => {
    const h = harness();
    h.service.save(draft());
    h.service.attach("d1", [{ name: "a.txt", contentType: "text/plain", bytes: Buffer.from("one") }]);
    h.service.attach("d1", [{ name: "a.txt", contentType: "text/plain", bytes: Buffer.from("two") }]);

    assert.equal(h.service.get("d1")?.attachments.length, 1);
  });

  it("deletes a draft", () => {
    const h = harness();
    h.service.save(draft());
    h.service.delete("d1");

    assert.equal(h.service.get("d1"), null);
  });
});

describe("ComposeService.carryAttachments", () => {
  it("copies a message's attachments onto a draft for forwarding", async () => {
    const h = harness();
    h.setMessage(message({ attachments: [{ name: "photo.jpg", sizeBytes: 2 }] }));
    h.pat.attachments["photo.jpg"] = Buffer.from([0xff, 0xd8]);
    h.service.save(draft());

    await h.service.carryAttachments("in", "E88DNN8D4ONK", "d1");

    const stored = h.store.get("N1CALL", "d1");
    assert.equal(stored?.attachments.length, 1);
    assert.ok(stored?.attachments[0]?.bytes.equals(Buffer.from([0xff, 0xd8])));
  });

  it("does nothing for a message with no attachments", async () => {
    const h = harness();
    h.service.save(draft());

    assert.deepEqual(await h.service.carryAttachments("in", "E88DNN8D4ONK", "d1"), []);
  });
});

describe("ComposeService.acknowledge", () => {
  it("queues the acknowledgement straight to the outbox", async () => {
    // One click, no compose window: this is what Winlink Express does.
    const h = harness();

    await h.service.acknowledge("in", "E88DNN8D4ONK");

    assert.equal(h.pat.posted.length, 1);
    const fields = h.pat.posted[0]!.fields;
    assert.equal(fields["to"], "W1AW");
    assert.equal(fields["subject"], "ACK: Sunday net check-in");
    assert.equal(
      fields["body"],
      "The following message was received by N1CALL.\n\n" +
        "Message ID:   E88DNN8D4ONK\n" +
        "Acknowledged: 2026/08/24 14:32 UTC\n",
    );
  });

  it("never leaves a draft behind", async () => {
    const h = harness();
    await h.service.acknowledge("in", "E88DNN8D4ONK");

    assert.deepEqual(h.service.list(), []);
  });

  it("triggers a mailbox sync", async () => {
    const h = harness();
    await h.service.acknowledge("in", "E88DNN8D4ONK");
    assert.equal(h.queued, 1);
  });

  it("says so when the message is gone rather than sending nonsense", async () => {
    const h = harness();
    h.setMessage(null);

    await assert.rejects(h.service.acknowledge("in", "GONE"), /no longer in the mailbox/);
  });
});

describe("ComposeService attachment integrity", () => {
  it("refuses to send when a listed attachment has no stored bytes", async () => {
    // The failure this guards: a forward lists the original's attachment NAMES
    // straight away, while the BYTES are fetched from Pat afterwards. If that
    // fetch failed, the draft claims files the store does not have -- and
    // sending would quietly drop them while the operator watched the names sit
    // in the compose window.
    // Sent as compose holds it in memory, which is what the renderer does --
    // the draft object carries the names before the bytes have arrived.
    const h = harness();
    const pending = { ...draft(), attachments: [{ name: "photo.jpg", contentType: "image/jpeg", sizeBytes: 40213 }] };
    h.service.save(pending);

    const result = await h.service.send(pending);

    assert.equal(result.sent, false);
    assert.match(result.problems[0] ?? "", /photo\.jpg/);
    assert.equal(h.pat.posted.length, 0, "an incomplete message must not be sent");
  });

  it("names every missing attachment, not just the first", async () => {
    const h = harness();
    const pending = {
      ...draft(),
      attachments: [
        { name: "a.jpg", contentType: "image/jpeg", sizeBytes: 1 },
        { name: "b.jpg", contentType: "image/jpeg", sizeBytes: 1 },
      ],
    };
    h.service.save(pending);

    const result = await h.service.send(pending);

    assert.match(result.problems[0] ?? "", /a\.jpg/);
    assert.match(result.problems[0] ?? "", /b\.jpg/);
  });

  it("sends once the bytes are actually there", async () => {
    const h = harness();
    h.service.save(draft());
    h.service.attach("d1", [{ name: "photo.jpg", contentType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8]) }]);

    const result = await h.service.send(h.service.get("d1")!);

    assert.equal(result.sent, true);
    assert.equal(h.pat.posted[0]?.files.length, 1);
  });

  it("leaves a message with no attachments alone", async () => {
    const h = harness();
    assert.equal((await h.service.send(draft())).sent, true);
  });

  it("a forward that fetched its attachments can be sent", async () => {
    const h = harness();
    h.setMessage(message({ attachments: [{ name: "photo.jpg", sizeBytes: 2 }] }));
    h.pat.attachments["photo.jpg"] = Buffer.from([0xff, 0xd8]);

    const pending = { ...draft(), attachments: [{ name: "photo.jpg", contentType: "", sizeBytes: 2 }] };
    h.service.save(pending);
    await h.service.carryAttachments("in", "E88DNN8D4ONK", "d1");

    // Sent as compose holds it: the names were there all along, and the bytes
    // have now caught up.
    const result = await h.service.send(pending);
    assert.equal(result.sent, true);
  });
});

describe("ComposeService.editQueued", () => {
  function editHarness(options: { busy?: boolean; removes?: boolean | Error; message?: MailMessage | null } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "wl2go-edit-"));
    dirs.push(dir);
    const store = new DraftStore(path.join(dir, "drafts.db"));
    const pat = new FakePat();
    const removed: string[] = [];
    /** How many drafts existed at the moment removal was asked for. */
    const draftsAtRemoval: number[] = [];
    const queued =
      options.message === undefined
        ? message({
            box: "out",
            mid: "QUEUED1",
            from: "N1CALL",
            to: ["W1AW", "someone@example.org"],
            cc: ["N0CALL"],
            subject: "Net report",
            body: "Twelve check-ins.",
            p2pOnly: true,
            attachments: [{ name: "log.txt", sizeBytes: 5 }],
          })
        : options.message;
    pat.attachments["log.txt"] = Buffer.from("hello");

    const service = new ComposeService({
      store,
      getApi: () => pat,
      getCallsign: () => "N1CALL",
      getMessage: () => null,
      loadMessage: async () => queued,
      removeQueued: async (mid) => {
        draftsAtRemoval.push(store.list("N1CALL").length);
        if (options.removes instanceof Error) throw options.removes;
        if (options.removes === false) return false;
        removed.push(mid);
        return true;
      },
      sessionBusy: () => options.busy ?? false,
      onQueued: () => {},
      onDraftsChanged: () => {},
      now: () => new Date("2026-08-24T14:32:00.000Z"),
    });
    return { store, pat, service, removed, draftsAtRemoval };
  }

  it("turns the queued message into a draft, attachments and all, and takes it out of the outbox", async () => {
    const h = editHarness();

    const draft = await h.service.editQueued("QUEUED1");

    assert.equal(draft.to, "W1AW, someone@example.org");
    assert.equal(draft.cc, "N0CALL");
    assert.equal(draft.subject, "Net report");
    assert.equal(draft.body, "Twelve check-ins.");
    assert.equal(draft.p2pOnly, true);
    assert.deepEqual(h.removed, ["QUEUED1"]);

    const stored = h.store.get("N1CALL", draft.id);
    assert.equal(stored?.attachments[0]?.bytes.toString(), "hello", "the attachment bytes travel with the draft");
    assert.equal(stored?.draft.attachments[0]?.sizeBytes, 5);
  });

  it("stores the draft before removing the queued copy", async () => {
    const h = editHarness();
    await h.service.editQueued("QUEUED1");
    assert.deepEqual(h.draftsAtRemoval, [1]);
  });

  it("drops the draft again when Pat will not remove the queued copy", async () => {
    const h = editHarness({ removes: false });
    await assert.rejects(h.service.editQueued("QUEUED1"), /left there unchanged/);
    assert.equal(h.store.list("N1CALL").length, 0, "no second copy may be left to send");
  });

  it("drops the draft again when removal throws", async () => {
    const h = editHarness({ removes: new Error("Pat is down") });
    await assert.rejects(h.service.editQueued("QUEUED1"), /Pat is down/);
    assert.equal(h.store.list("N1CALL").length, 0);
  });

  it("leaves everything alone when an attachment cannot be fetched", async () => {
    const h = editHarness();
    delete h.pat.attachments["log.txt"];
    await assert.rejects(h.service.editQueued("QUEUED1"));
    assert.equal(h.store.list("N1CALL").length, 0);
    assert.deepEqual(h.removed, []);
  });

  it("refuses during a session and touches nothing", async () => {
    const h = editHarness({ busy: true });
    await assert.rejects(h.service.editQueued("QUEUED1"), /session is in progress/);
    assert.deepEqual(h.removed, []);
    assert.equal(h.store.list("N1CALL").length, 0);
  });

  it("says so when the message has already left the outbox", async () => {
    const h = editHarness({ message: null });
    await assert.rejects(h.service.editQueued("QUEUED1"), /no longer in the Outbox/);
  });
});
