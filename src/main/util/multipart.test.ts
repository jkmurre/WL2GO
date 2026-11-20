import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeMultipart } from "./multipart.ts";

/** Pulls the boundary back out of the Content-Type, as a server would. */
function boundaryOf(contentType: string): string {
  const match = /boundary=(.+)$/.exec(contentType);
  assert.ok(match, `no boundary in ${contentType}`);
  return match[1]!;
}

describe("encodeMultipart fields", () => {
  it("emits each field as its own part", () => {
    const { contentType, body } = encodeMultipart({ to: "W1AW", subject: "Net" });
    const boundary = boundaryOf(contentType);
    const text = body.toString("utf8");

    assert.match(text, new RegExp(`--${boundary}\\r\\nContent-Disposition: form-data; name="to"\\r\\n\\r\\nW1AW\\r\\n`));
    assert.match(text, /name="subject"\r\n\r\nNet\r\n/);
  });

  it("closes with the terminating boundary", () => {
    const { contentType, body } = encodeMultipart({ a: "1" });
    assert.ok(body.toString("utf8").endsWith(`--${boundaryOf(contentType)}--\r\n`));
  });

  it("uses CRLF throughout, as the format requires", () => {
    const text = encodeMultipart({ a: "1" }).body.toString("utf8");
    assert.ok(!/[^\r]\n/.test(text), "found a bare LF");
  });

  it("gives each message a different boundary", () => {
    // A fixed boundary that happened to occur inside an attachment would split
    // the body in a way the server reads as valid.
    const first = boundaryOf(encodeMultipart({ a: "1" }).contentType);
    const second = boundaryOf(encodeMultipart({ a: "1" }).contentType);
    assert.notEqual(first, second);
  });

  it("carries a multi-line field value intact", () => {
    const body = encodeMultipart({ body: "line one\nline two" }).body.toString("utf8");
    assert.match(body, /line one\nline two/);
  });

  it("handles an empty field set", () => {
    const { contentType, body } = encodeMultipart({});
    assert.equal(body.toString("utf8"), `--${boundaryOf(contentType)}--\r\n`);
  });
});

describe("encodeMultipart files", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

  it("declares the filename and content type", () => {
    const text = encodeMultipart({}, [
      { field: "files", filename: "photo.jpg", contentType: "image/jpeg", bytes: jpeg },
    ]).body.toString("latin1");

    assert.match(text, /name="files"; filename="photo\.jpg"/);
    assert.match(text, /Content-Type: image\/jpeg/);
  });

  it("preserves binary content byte for byte", () => {
    // The whole reason attachments are appended as Buffers: a UTF-8 round-trip
    // would corrupt every byte above 0x7F.
    const { body } = encodeMultipart({}, [
      { field: "files", filename: "photo.jpg", contentType: "image/jpeg", bytes: jpeg },
    ]);

    assert.ok(body.includes(jpeg), "the attachment bytes are not in the body verbatim");
  });

  it("preserves every byte value from 0x00 to 0xFF", () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const { body } = encodeMultipart({}, [
      { field: "files", filename: "raw.bin", contentType: "application/octet-stream", bytes: all },
    ]);

    assert.ok(body.includes(all));
  });

  it("falls back to a generic content type", () => {
    const text = encodeMultipart({}, [
      { field: "files", filename: "x", contentType: "", bytes: Buffer.from("hi") },
    ]).body.toString("utf8");

    assert.match(text, /Content-Type: application\/octet-stream/);
  });

  it("neutralises a filename that would otherwise forge headers", () => {
    // Attachment names come from the filesystem, and on a forward they come from
    // whoever sent the message.
    const text = encodeMultipart({}, [
      {
        field: "files",
        filename: 'evil"\r\nContent-Disposition: form-data; name="to"\r\n\r\nVICTIM\r\n',
        contentType: "text/plain",
        bytes: Buffer.from("x"),
      },
    ]).body.toString("utf8");

    // The literal text still appears inside the escaped filename, which is
    // harmless. What matters is that it cannot START A LINE -- that is what
    // would make it a header rather than part of a value.
    assert.equal(text.match(/^Content-Disposition:/gm)?.length, 1, "a forged header line escaped the filename");
    assert.ok(!/name="to"/.test(text), "a forged field escaped the filename");
    // And the quotes that would have closed the filename parameter are encoded.
    assert.match(text, /filename="evil%22%0D%0A/);
  });

  it("sends several attachments under the same field name", () => {
    const text = encodeMultipart({}, [
      { field: "files", filename: "a.txt", contentType: "text/plain", bytes: Buffer.from("a") },
      { field: "files", filename: "b.txt", contentType: "text/plain", bytes: Buffer.from("b") },
    ]).body.toString("utf8");

    assert.equal(text.match(/name="files"/g)?.length, 2);
  });

  it("emits fields before files", () => {
    const text = encodeMultipart({ subject: "Net" }, [
      { field: "files", filename: "a.txt", contentType: "text/plain", bytes: Buffer.from("a") },
    ]).body.toString("utf8");

    assert.ok(text.indexOf('name="subject"') < text.indexOf('name="files"'));
  });
});
