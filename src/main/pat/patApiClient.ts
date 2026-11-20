import * as http from "node:http";
import type { PatStatus } from "../../shared/ipcContract.ts";
import { encodeMultipart, type MultipartFile } from "../util/multipart.ts";

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * For the calls Pat forwards to api.winlink.org. Long enough for a slow link,
 * short enough that an operator who has lost the internet is told so rather
 * than left watching a spinner.
 */
const CMS_TIMEOUT_MS = 30_000;

/** Carries the per-launch token patched Pat requires (vendor/pat/patches/0001). */
export const PAT_TOKEN_HEADER = "X-WL2GO-Token";

/**
 * Deliberate absence of a deadline, for the calls that cannot have one.
 *
 * Named rather than a bare `null` at each call site so the reason travels with
 * it: these requests are bounded by work Pat is doing, not by a wire delay, and
 * a timeout here would abort a healthy operation.
 */
const NO_TIMEOUT = null;

/** One attachment's bytes, exactly as Pat served them. */
export interface PatAttachmentData {
  name: string;
  contentType: string;
  bytes: Buffer;
}

interface SendOptions {
  method: string;
  path: string;
  /** Null waits as long as Pat takes. See NO_TIMEOUT. */
  timeoutMs: number | null;
  /** Serialised as JSON when present. */
  body?: unknown;
  /** A pre-encoded body, for the one endpoint that is not JSON. */
  rawBody?: { contentType: string; bytes: Buffer };
  /** Extra request headers. Pat's move endpoint is driven entirely by one. */
  headers?: Record<string, string>;
}

/** A non-2xx answer from Pat, with what is needed to tell one failure from another. */
export class PatApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(apiPath: string, status: number, body: string) {
    super(`Pat API ${apiPath} returned status ${status}: ${body}`);
    this.name = "PatApiError";
    this.status = status;
    this.body = body;
  }
}

export class PatApiClient {
  private readonly port: number;
  private readonly token: string | null;
  private readonly host: string;

  constructor(port: number, token: string | null = null, host = "127.0.0.1") {
    this.port = port;
    this.token = token;
    this.host = host;
  }

  getStatus(timeoutMs: number | null = DEFAULT_TIMEOUT_MS): Promise<PatStatus> {
    return this.json<PatStatus>({ method: "GET", path: "/api/status", timeoutMs });
  }

  /**
   * Runs a whole Winlink session and resolves when it is over.
   *
   * Pat's ConnectHandler is synchronous (api/api.go:359-371): it dials, exchanges
   * and disconnects inline, then returns how many messages arrived. A session can
   * take minutes, so this deliberately has NO timeout -- everything that happens
   * meanwhile is reported over the event stream, not here.
   *
   * `url` is usually the alias "telnet", which Pat expands from connect_aliases
   * and substitutes {mycall} into (connect.go:38-43), so the CMS address stays
   * Pat's business rather than ours.
   */
  connect(url: string): Promise<{ NumReceived: number }> {
    return this.json<{ NumReceived: number }>({
      method: "POST",
      path: `/api/connect?url=${encodeURIComponent(url)}`,
      timeoutMs: NO_TIMEOUT,
    });
  }

  /**
   * Aborts the session a connect() call is still waiting on.
   *
   * Issued out of band while that request is open; the connect promise resolves
   * afterwards. "dirty" skips the polite disconnect handshake.
   */
  disconnect(dirty = false): Promise<void> {
    return this.json<unknown>({
      method: "POST",
      path: `/api/disconnect?dirty=${dirty}`,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    }).then(() => undefined);
  }

  /**
   * The RMS gateway list, with distance, bearing and a propagation forecast.
   *
   * Pat computes all of it (app/rmslist.go:140-196) and caches the underlying
   * gateway data locally with a 48-hour window, so this keeps working offline --
   * which is the realistic field case, since the list is fetched over the
   * INTERNET only. There is no over-radio path; Winlink Express's channel
   * update is a SYSTEM message Pat does not implement.
   *
   * No timeout: the first call of the day fetches from api.winlink.org and then
   * runs a VOACAP prediction per station.
   */
  getRmsList(
    params: { mode?: string; band?: string; prefix?: string; forceDownload?: boolean } = {},
  ): Promise<unknown[]> {
    const query = new URLSearchParams();
    if (params.mode) query.set("mode", params.mode);
    if (params.band) query.set("band", params.band);
    if (params.prefix) query.set("prefix", params.prefix);
    // Only sent when true: Pat parses it with strconv.ParseBool, and "false"
    // would be a pointless round trip past its cache either way.
    if (params.forceDownload) query.set("force-download", "true");

    const suffix = query.toString();
    return this.json<unknown[]>({
      method: "GET",
      path: `/api/rmslist${suffix ? `?${suffix}` : ""}`,
      timeoutMs: NO_TIMEOUT,
    }).then((list) => (Array.isArray(list) ? list : []));
  }

  /**
   * Every message in a folder, without bodies.
   *
   * NO timeout, and that is not caution -- it is arithmetic. Pat's listing
   * handler runs LoadMessageDir -> OpenMessage -> readSection over EVERY
   * attachment of EVERY message in the folder (fbb/message.go:352), reading the
   * bytes into memory only to discard them: the response is metadata, but
   * producing it is O(bytes on disk in the folder), not O(message count). A
   * mailbox holding a few photos blows any fixed deadline that small test
   * fixtures would never come close to.
   *
   * Bodies are absent here because JSONMessage gates them behind an unexported
   * inclBody the listing path leaves false (api/mailbox.go:58-62). Use
   * getMessage for one.
   */
  getMailbox(box: string): Promise<unknown[]> {
    return this.json<unknown[]>({
      method: "GET",
      path: `/api/mailbox/${encodeURIComponent(box)}`,
      timeoutMs: NO_TIMEOUT,
    });
  }

  /** One message, this time including Body and BodyHTML (api/mailbox.go:137). */
  getMessage(box: string, mid: string): Promise<unknown> {
    return this.json<unknown>({
      method: "GET",
      path: `/api/mailbox/${encodeURIComponent(box)}/${encodeURIComponent(mid)}`,
      timeoutMs: NO_TIMEOUT,
    });
  }

  /**
   * Marks a message read or unread.
   *
   * Two quirks of Pat's readHandler the caller has to live with. It replies with
   * an empty 200 -- nothing is written to the response -- so there is no body to
   * parse. And it omits the os.IsNotExist check its neighbours have
   * (api/mailbox.go:220-223), so a message that has moved or been deleted comes
   * back as a 500 rather than a 404.
   */
  setRead(box: string, mid: string, read: boolean): Promise<void> {
    return this.json<unknown>({
      method: "POST",
      path: `/api/mailbox/${encodeURIComponent(box)}/${encodeURIComponent(mid)}/read`,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      body: { read },
    }).then(() => undefined);
  }

  /**
   * One attachment's raw bytes.
   *
   * Addressed by filename, not index: Pat matches on File.Name() exactly
   * (api/mailbox.go:171-181). `rendertohtml` is deliberately never sent -- it
   * would return Pat's rendered form HTML instead of the operator's actual file.
   */
  getAttachment(box: string, mid: string, name: string): Promise<PatAttachmentData> {
    const path =
      `/api/mailbox/${encodeURIComponent(box)}` +
      `/${encodeURIComponent(mid)}/${encodeURIComponent(name)}`;
    return this.raw({ method: "GET", path, timeoutMs: NO_TIMEOUT }).then((result) => ({
      name,
      contentType: result.contentType,
      bytes: result.bytes,
    }));
  }

  /**
   * Queues a message for sending by writing it to Pat's outbox.
   *
   * Multipart because attachments require it: Pat's handler calls
   * ParseMultipartForm (api/mailbox.go:266). The accepted fields are exactly
   * to, cc, subject, body, p2ponly, date and the file parts -- nothing else is
   * read. `date` is REQUIRED and its absence is a 400, not a default
   * (api/mailbox.go:325-337).
   *
   * Pat's own web UI also sends an `in_reply_to` field. Nothing in Pat's Go
   * source reads it, so it is not sent here.
   *
   * Returns nothing useful, and deliberately does not go through the JSON path:
   * Pat answers 201 with the PLAIN STRING "Message posted (0.42 kB)"
   * (api/mailbox.go:352-354), which is not JSON and would fail to parse. The
   * message surfaces through the ordinary mailbox sync instead, and the MID Pat
   * assigned comes with it.
   */
  postMessage(fields: Record<string, string>, files: readonly MultipartFile[] = []): Promise<void> {
    const encoded = encodeMultipart(fields, files);
    return this.raw({
      method: "POST",
      path: "/api/mailbox/out",
      // No timeout: the body carries attachments, and Pat re-encodes images
      // while it parses them (app/attachment.go:23-33).
      timeoutMs: NO_TIMEOUT,
      rawBody: { contentType: encoded.contentType, bytes: encoded.body },
    }).then(() => undefined);
  }

  /**
   * Moves a message between folders.
   *
   * There is no move route. Pat overloads the compose endpoint: POST to the
   * TARGET box with an X-Pat-SourcePath header naming the source, and an empty
   * body (api/mailbox.go:238-262). It strips the /api/mailbox/ prefix from that
   * header, appends .b2f, and does an os.Rename -- so the MID is preserved.
   *
   * `out` is rejected here rather than attempted: Pat branches to the compose
   * path whenever the target is `out` (api/mailbox.go:232-236), so a move there
   * would silently be read as a malformed new message instead of failing.
   * Pat also does not validate the target box at all, so this is the only check.
   */
  moveMessage(fromBox: string, mid: string, toBox: string): Promise<void> {
    if (toBox === "out") {
      throw new Error("Messages cannot be moved into the Outbox.");
    }
    return this.json<unknown>({
      method: "POST",
      path: `/api/mailbox/${encodeURIComponent(toBox)}`,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      headers: {
        "X-Pat-SourcePath": `/api/mailbox/${encodeURIComponent(fromBox)}/${encodeURIComponent(mid)}`,
      },
    }).then(() => undefined);
  }

  /**
   * Removes a message for good.
   *
   * os.Remove, with no trash folder anywhere in Pat (api/mailbox.go:103-122).
   * Nothing above this may call it without the operator having confirmed.
   */
  deleteMessage(box: string, mid: string): Promise<void> {
    return this.json<unknown>({
      method: "DELETE",
      path: `/api/mailbox/${encodeURIComponent(box)}/${encodeURIComponent(mid)}`,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    }).then(() => undefined);
  }

  /**
   * The hybrid RMS gateways, from the CMS through Pat (vendor/pat/patches/0003).
   * Needs the internet; the caller keeps the last answer for when there is none.
   */
  getHybridStations(): Promise<unknown[]> {
    return this.json<unknown[]>({ method: "GET", path: "/api/wl2go/hybrid_stations", timeoutMs: CMS_TIMEOUT_MS }).then(
      (list) => (Array.isArray(list) ? list : []),
    );
  }

  /** The operator's Message Pickup Stations, as the CMS holds them. */
  getPickupStations(): Promise<unknown[]> {
    return this.json<unknown[]>({ method: "GET", path: "/api/wl2go/mps", timeoutMs: CMS_TIMEOUT_MS }).then((list) =>
      Array.isArray(list) ? list : [],
    );
  }

  /** Adds one, and answers with the list as it now stands. Pat enforces the limit of three. */
  addPickupStation(callsign: string): Promise<unknown[]> {
    return this.json<unknown[]>({
      method: "POST",
      path: "/api/wl2go/mps",
      timeoutMs: CMS_TIMEOUT_MS,
      body: { callsign },
    }).then((list) => (Array.isArray(list) ? list : []));
  }

  /** Removes every pickup station. The CMS offers nothing narrower. */
  clearPickupStations(): Promise<void> {
    return this.json<unknown>({ method: "DELETE", path: "/api/wl2go/mps", timeoutMs: CMS_TIMEOUT_MS }).then(
      () => undefined,
    );
  }

  /** A request whose response is JSON, or empty. */
  private json<T>(options: SendOptions): Promise<T> {
    return this.raw(options).then((result) => {
      const text = result.bytes.toString("utf8");
      try {
        // Pat answers some calls with an empty 200 and no body at all.
        return (text.trim() ? JSON.parse(text) : null) as T;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to parse Pat API response from ${options.path}: ${reason}`);
      }
    });
  }

  /** The single HTTP primitive. Collects bytes; interpreting them is the caller's. */
  private raw(options: SendOptions): Promise<{ bytes: Buffer; contentType: string }> {
    const { method, path: apiPath, timeoutMs, body, rawBody, headers } = options;
    const payload = rawBody ? rawBody.bytes : body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");

    const requestHeaders: Record<string, string | number> = { ...headers };
    if (this.token) requestHeaders[PAT_TOKEN_HEADER] = this.token;
    if (payload) {
      requestHeaders["content-type"] = rawBody ? rawBody.contentType : "application/json";
      requestHeaders["content-length"] = payload.length;
    }

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: this.host,
          port: this.port,
          path: apiPath,
          method,
          ...(timeoutMs === null ? {} : { timeout: timeoutMs }),
          ...(Object.keys(requestHeaders).length ? { headers: requestHeaders } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const bytes = Buffer.concat(chunks);
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new PatApiError(apiPath, status, bytes.toString("utf8").trim()));
              return;
            }
            resolve({ bytes, contentType: res.headers["content-type"] ?? "application/octet-stream" });
          });
        },
      );

      req.on("error", reject);
      if (timeoutMs !== null) {
        req.on("timeout", () => {
          req.destroy();
          reject(new Error(`Pat API request to ${apiPath} timed out after ${timeoutMs}ms`));
        });
      }

      if (payload) req.write(payload);
      req.end();
    });
  }
}
