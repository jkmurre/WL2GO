// multipart/form-data encoding, for the one Pat endpoint that needs it.
//
// Pat's compose handler calls ParseMultipartForm (api/mailbox.go:266), so
// attachments cannot go over the JSON path the rest of PatApiClient uses. This
// is ~50 lines of a well-specified format, so it is written rather than taking
// a dependency for it.
//
// Pure and Electron-free: encoding is exactly the sort of thing that is subtly
// wrong in a way only a real server notices, so it is tested on its own.

/** One file part. `bytes` is the content as it should reach Pat. */
export interface MultipartFile {
  /** The form field name. Pat reads attachments from "files". */
  field: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export interface MultipartBody {
  contentType: string;
  body: Buffer;
}

/**
 * A boundary that cannot appear in the content.
 *
 * Randomness is what makes that true in practice: a fixed boundary that happened
 * to occur inside an attachment would split the message in a way the server
 * reads as valid, which is far worse than an error.
 */
function makeBoundary(): string {
  const random = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join("");
  return `----WL2GOFormBoundary${random}`;
}

/**
 * Escapes a value for a Content-Disposition parameter.
 *
 * RFC 7578 says to use percent-encoding for characters that would break the
 * header. A filename containing a quote or a newline would otherwise let the
 * operator's own choice of filename forge headers -- attachment names come from
 * the filesystem, and on a forward they come from whoever sent the message.
 */
function escapeParameter(value: string): string {
  return value.replace(/["\\\r\n]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/**
 * Builds a multipart/form-data body.
 *
 * Fields are emitted before files, which is not required by the spec but is
 * what Pat's own form does, and keeps a large attachment from sitting between
 * two small text fields in a packet capture.
 */
export function encodeMultipart(fields: Record<string, string>, files: readonly MultipartFile[] = []): MultipartBody {
  const boundary = makeBoundary();
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${escapeParameter(name)}"\r\n\r\n` +
          `${value}\r\n`,
        "utf8",
      ),
    );
  }

  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${escapeParameter(file.field)}"; ` +
          `filename="${escapeParameter(file.filename)}"\r\n` +
          `Content-Type: ${file.contentType || "application/octet-stream"}\r\n\r\n`,
        "utf8",
      ),
    );
    // Appended as bytes, never through a string: an attachment is arbitrary
    // binary, and a UTF-8 round-trip would corrupt anything that is not text.
    parts.push(file.bytes);
    parts.push(Buffer.from("\r\n", "utf8"));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(parts),
  };
}
