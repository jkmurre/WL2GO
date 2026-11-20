import { app } from "electron";
import * as path from "node:path";
import type { AppPaths } from "../shared/ipcContract.ts";

export function userDataPath(...segments: string[]): string {
  return path.join(app.getPath("userData"), ...segments);
}

/**
 * Where vendored subprocess binaries live.
 *
 * Packaged: electron-builder maps resources/bin -> Contents/Resources/bin via
 * extraResources, deliberately outside app.asar because child_process.spawn()
 * cannot exec a path inside an asar archive.
 * Dev: straight off the repo root.
 */
export function resourcesBinDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "bin")
    : path.join(app.getAppPath(), "resources", "bin");
}

export function appPaths(): AppPaths {
  return {
    userData: app.getPath("userData"),
    logs: userDataPath("logs"),
    config: userDataPath("config.json"),
    // Encrypted credential blobs, kept apart from config.json so the config can
    // be inspected, copied or shared without carrying secrets with it.
    secrets: userDataPath("secrets.json"),
    // Pat's mailbox is kept inside userData rather than its default ~/.wl2k so
    // the app stays self-contained and never collides with a standalone Pat.
    patConfig: userDataPath("pat-config", "config.json"),
    patMailbox: userDataPath("pat-mailbox"),
    // Kept empty on purpose. Pat's default prehooks path is outside the app,
    // and a prehook script would inherit Pat's environment -- which carries the
    // Winlink password. Owning the directory and leaving it bare closes both.
    patPrehooks: userDataPath("pat-prehooks"),
    // Pat's own log, event log and forms all default to directories outside the
    // app. The log matters most: on Winlink account activation Pat prints the
    // assigned password into it, and it creates the file 0644. Its directory is
    // kept 0700 and the file pre-created 0600 -- see patProcessManager.
    patLog: userDataPath("pat-logs", "pat.log"),
    patEventLog: userDataPath("pat-logs", "eventlog.json"),
    patForms: userDataPath("pat-forms"),
    // The local mirror of Pat's mailbox. Derived state: it can be discarded
    // and rebuilt from Pat at any time, which is what "Rebuild message index"
    // does.
    mailboxDb: userDataPath("mailbox.db"),
    // Unsent messages. A SEPARATE database from the cache above, because
    // that one is disposable and this one is not: a draft exists nowhere
    // else, so it must not be dropped by a rebuild or a schema change.
    draftsDb: userDataPath("drafts.db"),
    // The operator's own folders and what is filed in them. Durable, like
    // drafts.db: they exist nowhere else, so "Rebuild index" must not touch them.
    foldersDb: userDataPath("folders.db"),
    // The last hybrid station list and pickup stations Winlink reported. Only
    // copies, but the copies are the point: both are fetched over the
    // internet and needed when it is down.
    winlinkNetwork: userDataPath("winlink-network.json"),
    resourcesBin: resourcesBinDir(),
  };
}
