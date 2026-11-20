// Deciding whether an IPC message came from WL2GO's own renderer.
//
// Every window loads the same page, and navigation and window.open are
// refused, so in practice nothing else can reach ipcMain. This is the check
// that keeps it that way if one of those guards ever fails: a frame that is
// not our top-level page gets no handler, whatever channel it names.
//
// No Electron import, so it runs under `node --test`.

import { fileURLToPath } from "node:url";
import * as path from "node:path";

/** Where the renderer is loaded from: the packaged file, or the dev server. */
export type RendererOrigin = { file: string } | { devUrl: string };

/** The parts of Electron's WebFrameMain this check reads. */
export interface SenderFrame {
  url: string;
  parent: unknown;
}

/**
 * True when `frame` is the top-level WL2GO page. The query string and hash
 * are ignored -- compose windows carry their draft id in the query -- but the
 * page itself must match exactly.
 */
export function isTrustedSender(frame: SenderFrame | null | undefined, origin: RendererOrigin): boolean {
  if (!frame || frame.parent) return false;

  let url: URL;
  try {
    url = new URL(frame.url);
  } catch {
    return false;
  }

  if ("file" in origin) {
    if (url.protocol !== "file:" || url.host) return false;
    let filePath: string;
    try {
      filePath = fileURLToPath(url);
    } catch {
      return false;
    }
    return path.resolve(filePath) === path.resolve(origin.file);
  }

  let expected: URL;
  try {
    expected = new URL(origin.devUrl);
  } catch {
    return false;
  }
  return url.origin === expected.origin;
}
