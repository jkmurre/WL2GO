import { app, BrowserWindow, clipboard, Menu, session } from "electron";
import * as path from "node:path";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { PatApiClient } from "./pat/patApiClient.ts";
import { PatProcessManager } from "./pat/patProcessManager.ts";
import { PatIdentitySync, type DesiredIdentity } from "./pat/patIdentitySync.ts";
import { PatEventStream } from "./pat/patEventStream.ts";
import { PatConnectionManager } from "./pat/patConnectionManager.ts";
import { MailboxDb } from "./mailbox/mailboxDb.ts";
import { MailboxSync } from "./mailbox/mailboxSync.ts";
import { DraftStore } from "./drafts/draftStore.ts";
import { FolderStore } from "./folders/folderStore.ts";
import { ComposeService } from "./drafts/composeService.ts";
import { ComposeWindows, type ComposeWindowHandle } from "./drafts/composeWindows.ts";
import { loopbackAddr } from "./util/loopback.ts";
import { ArdopProcessManager } from "./ardop/ardopProcessManager.ts";
import { ModemActivityTracker } from "./ardop/modemActivity.ts";
import { FinalIdWatcher } from "./ardop/finalIdWatcher.ts";
import { ArdopConnectionManager } from "./ardop/ardopConnectionManager.ts";
import { TuningSession } from "./ardop/tuningSession.ts";
import { listAudioDevices } from "./audio/audioDeviceService.ts";
import { isSessionBusy } from "../shared/sessionStage.ts";
import { RigctldProcessManager } from "./rigctl/rigctldProcessManager.ts";
import { RigControl } from "./rigctl/rigControl.ts";
import { releasePtt } from "./serial/pttTester.ts";
import { ConfigService } from "./config/configService.ts";
import { registerIpcHandlers } from "./ipc/handlers.ts";
import type { RendererOrigin } from "./ipc/senderGuard.ts";
import { appPaths } from "./paths.ts";
import { HybridNetworkService } from "./winlink/hybridNetworkService.ts";
import { closeLogger, initLogger, logger, subprocessLogStream } from "./logging/logger.ts";
import { reapOrphans } from "./process/orphanReaper.ts";
import { buildContextMenuTemplate } from "./contextMenu.ts";
import type {
  ActivationPasswordEvent,
  AppConfigView,
  ConnectionState,
  DraftSummaryView,
  MailBox,
  MailFolderCounts,
  PatPrompt,
  TuningState,
  ArdopProcessState,
  PatProcessState,
  RigctldProcessState,
} from "../shared/ipcContract.ts";

/**
 * The secret every request to Pat's API must carry, new on every launch.
 *
 * Pat's port is reachable from any web page the operator has open, so loopback
 * alone would let a page start a session and key the transmitter. Patched Pat
 * refuses anything without this token or with a foreign Host header. The port
 * itself is chosen by PatProcessManager and read back from it.
 */
const PAT_API_TOKEN = randomBytes(32).toString("hex");
/** ardopcf's default TCP command port; the data port is one higher. */
const ARDOP_HOST_PORT = 8515;

/**
 * Where the System Check's throwaway rigctld listens.
 *
 * Clear of Hamlib's default 4532, which is where a profile's real rig control
 * runs. See createRigctldManager.
 */
const RIGCTLD_SELFTEST_PORT = 4599;
/** Nothing may block quit for longer than this, however wedged a subprocess is. */
const SHUTDOWN_TIMEOUT_MS = 4000;

let mainWindow: BrowserWindow | null = null;
let patManager: PatProcessManager | null = null;
let patClient: PatApiClient | null = null;
let ardopManager: ArdopProcessManager | null = null;
let ardopConnection: ArdopConnectionManager | null = null;
let rigctldManager: RigctldProcessManager | null = null;
/** The resident rigctld Pat and WL2GO share while a rig profile is active. */
let rigControl: RigControl | null = null;
let tuningSession: TuningSession | null = null;
let configService: ConfigService | null = null;
let identitySync: PatIdentitySync | null = null;
let eventStream: PatEventStream | null = null;
let connectionManager: PatConnectionManager | null = null;
let mailboxDb: MailboxDb | null = null;
let mailboxSync: MailboxSync | null = null;
let hybridNetwork: HybridNetworkService | null = null;
let draftStore: DraftStore | null = null;
let folderStore: FolderStore | null = null;
let composeService: ComposeService | null = null;
/** Pop-out compose windows, and the unsent text every composing window holds. */
const composeWindows = new ComposeWindows({
  createWindow: () => createComposeWindow(),
  save: (draft) => {
    if (!composeService) throw new Error("Compose is not ready.");
    composeService.save(draft);
  },
  onLog: (message) => logger.error("compose", message),
});
/** Resolves once leftover subprocesses from an earlier run are gone. */
let reaped: Promise<number[]> = Promise.resolve([]);

let shutdownArmed = false;
let shuttingDown = false;

/**
 * Everything that must be torn down before quit. Managers register here as they
 * are created, so the shutdown path does not grow a new condition per
 * subprocess -- Module 10a's rig-state restore hangs off this same list.
 */
interface ManagedSubprocess {
  isRunning(): boolean;
  stop(): Promise<void>;
}

const subprocesses: ManagedSubprocess[] = [];

function broadcastPatState(state: PatProcessState): void {
  // Keyed off state rather than the first successful start: Pat is restarted on
  // every identity change, and if the FIRST start failed a one-time .then()
  // would never run again -- leaving the API client and event stream absent for
  // the rest of the session, with Connect permanently disabled.
  if (state.state === "running") onPatReady();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("pat:stateChanged", state);
  }
}

/** Idempotent: safe on every restart, and on a first start that follows a failure. */
function onPatReady(): void {
  if (!patClient && patManager) {
    patClient = new PatApiClient(patManager.httpPort, PAT_API_TOKEN);
    logger.info("pat", `Pat is ready on port ${patManager.httpPort}`);
  }
  startEventStream();

  // Unconditional, and deliberately out here rather than inside
  // startEventStream, which returns early once the stream exists. Pat has just
  // come up, which happens on launch and on every identity change, and either
  // way its mailbox is the thing we have not read yet. This is also what
  // recovers the sync that finishing onboarding kicked off against a Pat that
  // was already restarting underneath it.
  mailboxCallsign = configService?.view().station.callsign ?? "";
  mailboxSync?.syncAll();
}

/**
 * The status bar's TX/RX lights, fed from the session modem's console output.
 * One tracker for the app: only one session modem ever runs, and the tuning
 * modem (which has its own meter) deliberately does not feed it.
 */
/**
 * Holds the session teardown until the modem's final station ID is off the
 * air. Fed from the same console stream as the lights, reset with them, and
 * consulted by ArdopConnectionManager's finally before it SIGTERMs the modem.
 */
const finalIdWatcher = new FinalIdWatcher();

const modemActivity = new ModemActivityTracker({
  onChange: (activity) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("ardop:activity", activity);
    }
  },
  // The modem's console is also where the session sign-off announces itself.
  // The host's DISCONNECT command trace and the ID lines are SEPARATE events
  // on purpose: the first only requests the close, and showing "sending
  // station ID" on its strength once had the status bar claiming an ID that a
  // teardown race kept off the air. Both stage setters gate themselves to a
  // session in the right state, so a stray line advances nothing.
  onSignOff: () => connectionManager?.beginSignOff(),
  onIdStart: () => {
    connectionManager?.beginSendingId();
    finalIdWatcher.noteIdStart();
  },
  onPtt: (on) => finalIdWatcher.noteTransmit(on),
});

function broadcastArdopState(state: ArdopProcessState): void {
  // A modem that is not running is neither keyed nor decoding, whatever its
  // log said last. Without this the lights freeze on their final session state.
  // The sign-off watcher goes with it: a wait pending on a modem that is
  // already gone settles rather than holding the teardown for a dead process.
  if (state.state !== "running") {
    modemActivity.reset();
    finalIdWatcher.reset();
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("ardop:stateChanged", state);
  }
}

function broadcastTuning(state: TuningState): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("tuning:stateChanged", state);
  }
}

/**
 * The tuning modem, its host connection and its meter.
 *
 * Registered in subprocesses[] at construction rather than when it starts one:
 * the quit path has to be able to stop a modem that is halfway through starting,
 * and this is the one part of WL2GO that can leave a transmitter keyed.
 */
function createTuningSession(resourcesBinDir: string): TuningSession {
  const session = new TuningSession({
    resourcesBinDir,
    getCallsign: () => configService?.view().station.callsign ?? "",
    listAudioDevices: () => listAudioDevices(resourcesBinDir),
    // The same file the session modem writes to. The tuning modem is the one
    // an operator starts when the radio is misbehaving, so its output is the
    // output most worth keeping.
    createLogStream: () => subprocessLogStream("ardopcf"),
    getModemVersion: async () => {
      try {
        return (await readFile(path.join(appPaths().resourcesBin, "ARDOPCF_VERSION"), "utf8")).trim();
      } catch {
        return null;
      }
    },
    sessionInProgress: () =>
      connectionManager && isSessionBusy(connectionManager.getState())
        ? "A Winlink session is in progress. Disconnect before tuning."
        : null,
    // The tuning window edits a DRAFT profile, so it needs the CAT port that
    // the resident rigctld holds for the ACTIVE one -- possibly a different
    // radio entirely. sessionInProgress() does not cover this: rig control is
    // resident whether or not a session is running.
    suspendRigControl: async () => {
      await rigControl?.stop();
    },
    resumeRigControl: async () => {
      // sync() compares against what it last applied, so the stop above has to
      // be forgotten before it will start anything.
      await rigControl?.sync(null);
      await syncRigControl();

      // Then RESTART Pat, and this is not optional.
      //
      // Pat opened its rig once, at startup (app/app.go:455-500), against the
      // rigctld that suspendRigControl has just killed. The replacement listens
      // on the same address, so the identity fingerprint is unchanged and a
      // plain reconcile would conclude there is nothing to do -- leaving Pat
      // holding a dead connection and unable to tune or key for the rest of the
      // run. Exactly the case onUnexpectedExit handles; a deliberate stop needs
      // the same treatment, and it costs one restart to remove the doubt.
      identitySync?.forgetApplied();
      syncPatIdentity();
    },
    onState: broadcastTuning,
    onLog: (message) => logger.info("tuning", message),
  });
  subprocesses.push(session);
  return session;
}

function broadcastConnection(state: ConnectionState): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("pat:connectionChanged", state);
  }

  // A session that just ended has written whatever it received. The /ws event
  // usually beats this, but not always -- a session finishing as the socket
  // drops would otherwise leave the new mail invisible until the next launch.
  //
  // "finished" survived the rename from ConnectionPhase to SessionStage. This
  // is the one reader of it that is not UI, so it is the one that would have
  // failed silently -- new mail simply not appearing -- rather than loudly.
  if (state.stage === "finished") mailboxSync?.syncAll();
}

function broadcastPrompt(prompt: PatPrompt): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("pat:prompt", prompt);
  }
}

function broadcastActivationPassword(event: ActivationPasswordEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("pat:activationPassword", event);
  }
}

/**
 * Stores a Winlink-assigned password caught out of Pat's output, and tells the
 * operator. Pat only prints it, so losing it means losing account access.
 */
function captureActivationPassword(password: string): void {
  let stored = false;
  try {
    configService?.setWinlinkPassword(password);
    stored = true;
    logger.info("pat", "Captured the Winlink account password Pat printed and stored it in the keychain");
  } catch (err: unknown) {
    logger.error("pat", `Could not store the Winlink password: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Shown either way: if storing failed the operator MUST write it down, and
  // it exists nowhere else.
  broadcastActivationPassword({ password, stored });
}

function broadcastMailbox(counts: MailFolderCounts, boxes: MailBox[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("mailbox:changed", { counts, boxes });
  }
}

/**
 * Opens the local mailbox cache.
 *
 * Failure is survivable and deliberately not fatal: the cache is a mirror of
 * files Pat owns, so a database that cannot be opened costs the operator their
 * message list, not their mail. Everything else -- connecting, the System Check,
 * settings -- keeps working, and the reason is logged.
 */
function startMailbox(dbPath: string, foldersPath: string): void {
  try {
    mailboxDb = new MailboxDb(dbPath);
  } catch (err: unknown) {
    logger.error("mailbox", `Could not open the message cache: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Survivable on its own: without it the operator's folders are missing, but
  // every message is still in Archive where it actually lives.
  try {
    folderStore = new FolderStore(foldersPath);
  } catch (err: unknown) {
    logger.error("mailbox", `Could not open the folders store: ${err instanceof Error ? err.message : String(err)}`);
  }

  mailboxSync = new MailboxSync({
    db: mailboxDb,
    getApi: () => patClient,
    // Pat serves <mbox>/<MYCALL>, so the cache is keyed by callsign too: a
    // change of operator must neither show nor destroy the previous one's mail.
    getCallsign: () => configService?.view().station.callsign ?? "",
    onChanged: broadcastMailbox,
    folders: folderStore,
    onFoldersChanged: broadcastFolders,
    onLog: (message) => logger.info("mailbox", message),
    onError: (message) => logger.error("mailbox", message),
  });
}

function broadcastFolders(): void {
  if (mainWindow && !mainWindow.isDestroyed() && mailboxSync) {
    mainWindow.webContents.send("folders:changed", mailboxSync.userFolders());
  }
}

function broadcastDrafts(drafts: DraftSummaryView[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("drafts:changed", drafts);
  }
}

/**
 * Opens the draft store and builds compose on top of it.
 *
 * A SEPARATE database from the mailbox cache, deliberately: mailbox.db is
 * derived state that "Rebuild index" clears and a schema change drops, both
 * safe because every row mirrors a file Pat owns. A draft mirrors nothing, so
 * it must not share that fate. Failure is survivable the same way -- the app
 * keeps working, minus the ability to save unfinished messages.
 */
function startCompose(dbPath: string): void {
  try {
    draftStore = new DraftStore(dbPath);
  } catch (err: unknown) {
    logger.error("compose", `Could not open the drafts store: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  composeService = new ComposeService({
    store: draftStore,
    getApi: () => patClient,
    getCallsign: () => configService?.view().station.callsign ?? "",
    getMessage: (box, mid) => {
      const callsign = configService?.view().station.callsign ?? "";
      return callsign && mailboxDb ? mailboxDb.getMessage(callsign, box, mid) : null;
    },
    // Edit on a queued message: the body may not be cached yet, and removing
    // the queued copy goes through the sync so the cache and counts follow.
    loadMessage: async (box, mid) => (mailboxSync ? mailboxSync.loadBody(box, mid) : null),
    removeQueued: async (mid) => (mailboxSync ? mailboxSync.deleteMessage("out", mid) : false),
    // Pat may be transmitting the very message being edited.
    sessionBusy: () => !!connectionManager && isSessionBusy(connectionManager.getState()),
    // A queued message lands in Pat's outbox, which the mailbox sync surfaces.
    onQueued: () => mailboxSync?.syncAll(),
    onDraftsChanged: broadcastDrafts,
    onLog: (message) => logger.info("compose", message),
  });
}

function broadcastConfig(view: AppConfigView): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("config:changed", view);
  }
  // Rig control FIRST, and Pat's identity only once it has settled: the
  // identity carries the rigctld address, and Pat opens its rig once at
  // startup (app/app.go:455-500). Reconciling Pat before rigctld is listening
  // would restart Pat onto a rig that is not there yet, and every later ARDOP
  // connect would fail with "unable to set PTT rig ... Not defined or not
  // loaded" until something else happened to restart it again.
  void syncRigControl().then(() => {
    syncPatIdentity();
    syncMailboxForCallsign();
  });
}

/**
 * Brings the resident rigctld into line with the active profile.
 *
 * Safe to call on every config mutation: RigControl.sync() compares what
 * actually reaches rigctld and does nothing when it is unchanged, so saving an
 * unrelated setting does not drop the radio out from under a working session.
 */
async function syncRigControl(): Promise<void> {
  if (!rigControl || shuttingDown) return;
  try {
    await rigControl.sync(configService?.activeProfile() ?? null);
  } catch (err: unknown) {
    logger.error("rigctl", `Could not apply rig control: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The callsign the cache was last filled for; "" before onboarding finishes. */
let mailboxCallsign: string | null = null;

/**
 * Syncs the mailbox when the operator identity changes.
 *
 * The case Pat becoming ready does not cover: finishing onboarding sets a
 * callsign while Pat is already running, and the operator should not have to
 * wait for the restart to see their mail. Guarded on the callsign because
 * broadcastConfig fires on EVERY config mutation, and saving a radio profile
 * must not cost four folder listings.
 */
function syncMailboxForCallsign(): void {
  const callsign = configService?.view().station.callsign ?? "";
  if (!callsign || callsign === mailboxCallsign) return;

  mailboxCallsign = callsign;
  mailboxSync?.syncAll();
}

/**
 * The modem is created but deliberately NOT started: ardopcf takes exclusive
 * control of a sound card and would trigger a microphone permission prompt on
 * macOS. Module 9 starts it when a connection is actually wanted; until then
 * only the System Check briefly exercises it with audio disabled.
 */
function createArdopManager(resourcesBinDir: string): ArdopProcessManager {
  const manager = new ArdopProcessManager({
    resourcesBinDir,
    hostPort: ARDOP_HOST_PORT,
    createLogStream: () => subprocessLogStream("ardopcf"),
    onStateChange: broadcastArdopState,
    onOutput: (chunk) => modemActivity.ingest(chunk),
  });
  subprocesses.push(manager);
  return manager;
}

function broadcastRigctldState(state: RigctldProcessState): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("rigctl:stateChanged", state);
  }
}

/**
 * A rigctld for the System Check ONLY: Hamlib's dummy backend, on a scratch
 * port, touching no hardware.
 *
 * Deliberately separate from the resident one in RigControl, and the port is
 * why. The self-test starts a daemon and stops it again to prove the binary
 * and its bundled library run; doing that on the port the real rigctld holds
 * would either fail as a port conflict or, worse, be answered by the real one
 * and report a pass for a test that never ran. The dummy backend is also the
 * point -- a health check must not key or retune the operator's radio.
 */
function createRigctldManager(resourcesBinDir: string): RigctldProcessManager {
  const manager = new RigctldProcessManager({
    resourcesBinDir,
    port: RIGCTLD_SELFTEST_PORT,
    createLogStream: () => subprocessLogStream("rigctld"),
    onStateChange: broadcastRigctldState,
  });
  subprocesses.push(manager);
  return manager;
}

/**
 * The rigctld Pat and WL2GO share, created empty and started by syncRigControl
 * once the active profile is known to want one.
 */
function createRigControl(resourcesBinDir: string): RigControl {
  const control = new RigControl({
    resourcesBinDir,
    createLogStream: () => subprocessLogStream("rigctld"),
    onStateChange: broadcastRigctldState,
    onLog: (message) => logger.info("rigctl", message),
    onError: (message) => logger.error("rigctl", message),
    // A rigctld that died takes Pat's ability to key the radio with it, and Pat
    // cannot reopen a rig on its own. Bringing rigctld back is not enough --
    // Pat has to be restarted onto it, which is what marking the identity
    // unapplied and reconciling does.
    onUnexpectedExit: () => {
      if (shuttingDown) return;
      void syncRigControl().then(() => {
        identitySync?.forgetApplied();
        syncPatIdentity();
      });
    },
  });
  subprocesses.push(control);
  return control;
}

/** Every WL2GO window runs the same renderer under the same restrictions. */
const WEB_PREFERENCES = {
  preload: path.join(__dirname, "../preload/index.js"),
  contextIsolation: true,
  nodeIntegration: false,
  // The preload needs nothing but contextBridge and ipcRenderer.
  sandbox: true,
} as const;

function hardenWebContents(win: BrowserWindow): void {
  // The renderer never opens windows or leaves its own page; links go out
  // through app:openExternal, which checks the scheme. Anything else is refused,
  // however a message body might have persuaded the renderer to try. Compose
  // windows are opened by main, never by the renderer.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
  win.webContents.on("context-menu", (_event, params) => {
    const template = buildContextMenuTemplate(params, {
      replaceMisspelling: (word) => win.webContents.replaceMisspelling(word),
      addToDictionary: (word) => win.webContents.session.addWordToSpellCheckerDictionary(word),
      copyText: (text) => clipboard.writeText(text),
    });
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window: win });
  });
}

/**
 * The one page every WL2GO window loads. electron-vite sets
 * ELECTRON_RENDERER_URL when running the dev server. The IPC sender check
 * compares against this same value, so the two cannot drift apart.
 */
const RENDERER_ORIGIN: RendererOrigin = process.env["ELECTRON_RENDERER_URL"]
  ? { devUrl: process.env["ELECTRON_RENDERER_URL"] }
  : { file: path.join(__dirname, "../renderer/index.html") };

function loadRenderer(win: BrowserWindow, query?: Record<string, string>): void {
  if ("devUrl" in RENDERER_ORIGIN) {
    const url = new URL(RENDERER_ORIGIN.devUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(RENDERER_ORIGIN.file, query ? { query } : undefined);
  }
}

/**
 * The renderer needs no browser permission: audio, serial and the clipboard
 * are all handled in main. Electron grants every request by default, so a
 * message body that found a way to script the page could otherwise ask for
 * the microphone, camera, notifications and more. Refuse them all.
 */
function denyAllPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    logger.warn("security", `Refused a renderer permission request: ${permission}`);
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setDevicePermissionHandler(() => false);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    // 680, not 860: macOS half-screen tiling on a 1440-1512pt laptop display
    // asks for 720-756pt, and a floor above that makes the window refuse to
    // tile at all. The layout collapses progressively below 1024/840 CSS px
    // (see the responsive section at the end of global.css) so 680 is usable.
    minWidth: 680,
    minHeight: 560,
    show: false,
    backgroundColor: "#1b1e24",
    title: "WL2GO",
    webPreferences: WEB_PREFERENCES,
  });

  const win = mainWindow;
  hardenWebContents(win);

  // An inline reply being written when the window closes is kept, as a
  // pop-out's would be. Captured now: webContents is gone by "closed".
  const contentsId = win.webContents.id;
  win.on("close", () => composeWindows.closed(contentsId));

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  loadRenderer(win);
}

/**
 * A pop-out compose window.
 *
 * Not a child of the main window: the point is to drag it beside the mailbox
 * and read while writing, and a child would be held above its parent.
 */
function createComposeWindow(): ComposeWindowHandle {
  // Cascaded off whichever window has focus, so a second one does not land
  // exactly on top of the first.
  const anchor = BrowserWindow.getFocusedWindow() ?? mainWindow;
  const bounds = anchor && !anchor.isDestroyed() ? anchor.getBounds() : null;

  const win = new BrowserWindow({
    width: 760,
    height: 700,
    minWidth: 520,
    minHeight: 480,
    ...(bounds ? { x: bounds.x + 48, y: bounds.y + 48 } : {}),
    show: false,
    backgroundColor: "#1b1e24",
    title: "New message",
    webPreferences: WEB_PREFERENCES,
  });
  hardenWebContents(win);

  const contentsId = win.webContents.id;
  // Closing keeps the draft -- the same rule as the modal's close button.
  win.on("close", () => composeWindows.closed(contentsId));
  win.once("ready-to-show", () => win.show());

  loadRenderer(win, { window: "compose" });

  return {
    id: contentsId,
    focus: () => {
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.focus();
    },
    close: () => {
      if (!win.isDestroyed()) win.close();
    },
  };
}

/**
 * The propagation engine WL2GO always asks Pat for.
 *
 * A constant rather than a setting: Pat's default ("auto") tries a LOCAL voacap
 * binary and, failing to find one, leaves its predictor nil rather than falling
 * back to the web service (app/app.go:240-251). Since nothing is bundled, that
 * would mean no link quality on any station, ever. The API engine needs no
 * bundled data directory, so packaging is untouched.
 */
const PREDICTION_ENGINE = "voacap-api";

/** The operator identity Pat should currently be running under. */
function desiredIdentity(): DesiredIdentity {
  const config = configService?.view();
  return {
    mycall: config?.station.callsign ?? "",
    locator: config?.station.gridSquare ?? "",
    // The modem address is fixed for the app rather than taken from the active
    // profile: only one modem runs at a time, and sourcing it from the profile
    // would bounce Pat on every profile switch. A profile that wants a
    // different host port is handled by the fingerprint noticing the change.
    ardopAddr: loopbackAddr(ARDOP_HOST_PORT),
    // Where Pat should drive the radio, or null when the active profile has no
    // rig. Unlike the modem address this DOES come from the profile: it is the
    // profile that decides whether there is a radio to control at all, and the
    // fingerprint restarting Pat on a change is the point rather than a cost --
    // Pat only ever opens its rig at startup.
    rigAddr: rigControl?.address() ?? null,
    predictionEngine: PREDICTION_ENGINE,
    versionReportingDisabled: config?.station.shareWithWinlink === false,
    password: configService?.winlinkPassword() ?? null,
  };
}

/**
 * Started after the window exists and deliberately not awaited: a missing or
 * broken Pat must surface inside the System Check panel, never as a blank
 * screen while the readiness poll times out.
 */
function startPatInBackground(): void {
  const paths = appPaths();
  const identity = desiredIdentity();

  identitySync = new PatIdentitySync({
    patConfigPath: paths.patConfig,
    restart: async () => {
      await patManager?.restart();
    },
    onLog: (message) => logger.info("pat", message),
    onError: (message) => logger.error("pat", `Could not apply the station identity: ${message}`),
  });

  // Pat has not necessarily written a config yet, in which case this is a no-op
  // and the identity is applied on the reconcile after it comes up.
  identitySync.writeConfigOnly(identity);

  const manager = new PatProcessManager({
    resourcesBinDir: paths.resourcesBin,
    configPath: paths.patConfig,
    mailboxDir: paths.patMailbox,
    prehooksDir: paths.patPrehooks,
    logPath: paths.patLog,
    eventLogPath: paths.patEventLog,
    formsDir: paths.patForms,
    apiToken: PAT_API_TOKEN,
    // Never an argument: argv is readable by anyone via `ps`. Pat picks this up
    // from PAT_SECURELOGINPASSWORD in its environment instead.
    winlinkPassword: identity.password,
    onActivationPassword: captureActivationPassword,
    createLogStream: () => subprocessLogStream("pat"),
    onStateChange: broadcastPatState,
  });
  patManager = manager;
  subprocesses.push(manager);

  patManager
    .start()
    .then(async () => {
      patClient = new PatApiClient(manager.httpPort, PAT_API_TOKEN);
      logger.info("pat", `Pat is ready on port ${manager.httpPort}`);

      // Read back what Pat is ACTUALLY running with rather than assuming it got
      // what we intended: on the launch where Pat seeds its config for the first
      // time, the pre-spawn write above was a no-op. Recording the intent here
      // would mark an identity applied that never reached Pat, and the reconcile
      // below would then find nothing to do -- for good.
      startEventStream();
      identitySync?.observeApplied(identity.password);
      // Through the same queue as every other change, so a config edit made
      // while Pat was still starting cannot race this one.
      identitySync?.requestReconcile(desiredIdentity);
    })
    .catch((err: unknown) => {
      logger.error("pat", err instanceof Error ? err.message : String(err));
    });
}

/**
 * Attaches to Pat's event stream, and builds the session manager on top of it.
 *
 * Both are created once Pat is ready and left running: the stream reconnects on
 * its own across the restarts an identity change causes.
 */
function startEventStream(): void {
  if (eventStream || !patManager) return;

  eventStream = new PatEventStream({
    // A query parameter, not a header: the platform WebSocket cannot set
    // headers, and patched Pat accepts the token this way on /ws alone.
    url: `ws://${loopbackAddr(patManager.httpPort)}/ws?token=${PAT_API_TOKEN}`,
    getPassword: () => configService?.winlinkPassword() ?? null,
    onEvent: (event) => {
      if (event.type === "status") connectionManager?.applyStatus(event.status);
      else if (event.type === "progress") connectionManager?.applyProgress(event.progress);
      // Pat's log is the only view of a connect while it is happening:
      // /api/connect returns nothing until the session is over, and
      // /api/status says nothing between dialling and connected.
      else if (event.type === "logLine") connectionManager?.applyLogLine(event.line);
      // Pat says only THAT the mailbox changed, never what -- so this is a
      // request to go and diff, not an update to apply.
      else if (event.type === "updateMailbox") mailboxSync?.notifyExternalChange();
    },
    onPromptUnanswered: broadcastPrompt,
    onAttachedChange: () => connectionManager?.notify(),
    onLog: (message) => logger.info("pat", message),
  });

  connectionManager = new PatConnectionManager({
    getApi: () => patClient,
    getCallsign: () => configService?.view().station.callsign ?? "",
    isEventStreamAttached: () => eventStream?.isAttached() ?? false,
    onStateChange: broadcastConnection,
    onLog: (message) => logger.info("pat", message),
  });

  eventStream.start();
}

/**
 * Applies an identity change to the running Pat.
 *
 * Fired from every config mutation. The queue coalesces a burst -- finishing
 * onboarding saves the callsign and the password as two separate mutations --
 * and restarts only when the callsign, locator or password actually differ, so
 * saving a radio profile does nothing.
 */
function syncPatIdentity(): void {
  if (!identitySync || !patManager) return;
  // A restart spans a stop and a start. Beginning one while the quit path is
  // tearing subprocesses down would spawn a Pat nobody reaps, holding its
  // port and its mailbox against the next launch.
  if (shuttingDown) return;

  identitySync.requestReconcile(desiredIdentity);
}

/** Closes the cache cleanly so WAL state is checkpointed rather than replayed. */
function closeMailbox(): void {
  try {
    mailboxDb?.close();
  } catch (err: unknown) {
    logger.error("mailbox", `Could not close the message cache: ${err instanceof Error ? err.message : String(err)}`);
  }
  mailboxDb = null;
  mailboxSync = null;

  try {
    folderStore?.close();
  } catch (err: unknown) {
    logger.error("mailbox", `Could not close the folders store: ${err instanceof Error ? err.message : String(err)}`);
  }
  folderStore = null;

  try {
    draftStore?.close();
  } catch (err: unknown) {
    logger.error("compose", `Could not close the drafts store: ${err instanceof Error ? err.message : String(err)}`);
  }
  draftStore = null;
  composeService = null;
}

/**
 * Only one WL2GO may run at a time.
 *
 * Two instances would both try to spawn Pat on the same port -- the second
 * failing with an opaque error -- and would both write config.json with no
 * coordination, so whichever saved last would silently discard the other's
 * changes. Acquired before anything is spawned or loaded, because a second
 * instance must do nothing at all before it quits.
 */
const isPrimaryInstance = app.requestSingleInstanceLock();

if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // Someone launched WL2GO again: show them the window they already have.
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

app.whenReady().then(() => {
  // A second instance has already called app.quit(); it must not touch the log
  // files, the config, or the subprocesses on its way out.
  if (!isPrimaryInstance) return;

  // Set explicitly rather than relying on Electron's default menu: the Edit
  // menu's roles are what make Cmd+X/C/V/A/Z work in every text field.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );

  const paths = appPaths();
  initLogger(paths.logs);
  logger.info("app", `WL2GO ${app.getVersion()} starting on ${process.platform}/${process.arch}`);

  // Loaded before anything reads it: Pat is spawned with the stored callsign,
  // and safeStorage is only usable once the app is ready.
  configService = new ConfigService({
    configPath: paths.config,
    secretsPath: paths.secrets,
    onChange: broadcastConfig,
  });
  configService.load();

  startMailbox(paths.mailboxDb, paths.foldersDb);
  startCompose(paths.draftsDb);
  hybridNetwork = new HybridNetworkService({
    cachePath: paths.winlinkNetwork,
    getClient: () => patClient,
    getCallsign: () => configService?.view().station.callsign ?? "",
    hasPassword: () => configService?.winlinkPassword() != null,
  });

  // BEFORE any manager is built, and before rigctld or Pat are spawned below.
  // A modem left over from a crashed or force-quit run still holds the sound
  // card, and under CAT keying the radio's CI-V port as well -- where it eats
  // the replies rigctld is waiting for and the next session fails with "the
  // radio's current mode could not be read". Not awaited at this point because
  // nothing here spawns yet; the subprocess starts are sequenced after
  // createWindow() and await this first.
  reaped = reapOrphans({
    resourcesBinDir: paths.resourcesBin,
    onLog: (message) => logger.info("app", message),
  });

  ardopManager = createArdopManager(paths.resourcesBin);
  rigctldManager = createRigctldManager(paths.resourcesBin);
  rigControl = createRigControl(paths.resourcesBin);
  tuningSession = createTuningSession(paths.resourcesBin);

  // Built over the modem and the session manager rather than beside them: the
  // stage model, the prompts and the /ws plumbing are the same for both
  // transports, and a second copy of any of it would be the two-vocabularies
  // problem the session stage enum exists to avoid.
  ardopConnection = new ArdopConnectionManager({
    getProfile: () => configService?.activeProfile() ?? null,
    listAudioDevices: () => listAudioDevices(paths.resourcesBin),
    getModem: () => ardopManager,
    getSession: () => connectionManager,
    // Null when the active profile has no rig, which is a supported setup and
    // exactly what every session did before rig control existed.
    getRig: () => rigControl?.session ?? null,
    // The same source PatConnectionManager reads; for the radio-only SSID check.
    getCallsign: () => configService?.view().station.callsign ?? "",
    // Runs at the top of every RF connect attempt. Heals a dead rig client in
    // place; when the DAEMON itself had to be (re)started, Pat's rig
    // connection is stale -- it opens its rigs once, at startup -- so it gets
    // the same restart dance an unexpected exit does. This attempt may still
    // lose the race with Pat's restart and fail once with a named error, but
    // the NEXT attempt then works, which beats the old behaviour: rig control
    // never came back at all without relaunching the app.
    ensureRig: async () => {
      if (!rigControl || shuttingDown) return;
      try {
        const daemonRestarted = await rigControl.ensure(configService?.activeProfile() ?? null);
        if (daemonRestarted) {
          identitySync?.forgetApplied();
          syncPatIdentity();
        }
      } catch (err: unknown) {
        logger.error("rigctl", `Could not revive rig control: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    onLog: (message) => logger.info("ardop", message),
    // Read per session, not captured: the operator can toggle recording in
    // Settings between sessions and the next spawn must see it.
    isRxRecordingEnabled: () => configService?.view().diagnostics.recordRxAudio ?? false,
    // The teardown's hold on modem.stop() until the final station ID is out.
    getSignOffWaiter: () => finalIdWatcher,
    // The pre-dial clear-channel check, live: the status bar's amber TX hold
    // and the hold dialog both render from these pushes.
    onChannelCheck: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("ardop:channelCheck", event);
      }
    },
  });

  registerIpcHandlers({
    getPatManager: () => patManager,
    getPatClient: () => patClient,
    getArdopManager: () => ardopManager,
    getArdopConnection: () => ardopConnection,
    getRigctldManager: () => rigctldManager,
    getConfigService: () => {
      if (!configService) throw new Error("Configuration is not loaded yet");
      return configService;
    },
    getConnectionManager: () => connectionManager,
    getTuningSession: () => tuningSession,
    getEventStream: () => eventStream,
    getMailboxSync: () => mailboxSync,
    getComposeService: () => composeService,
    getComposeWindows: () => composeWindows,
    getHybridNetwork: () => hybridNetwork,
    isShutdownArmed: () => shutdownArmed,
    rendererOrigin: RENDERER_ORIGIN,
  });

  denyAllPermissions();
  createWindow();

  // rigctld BEFORE Pat, always. Pat connects to every rig in hamlib_rigs once,
  // as it starts (app/app.go:455-500), and silently skips any that is not
  // listening -- after which every ARDOP connect fails with "unable to set PTT
  // rig ... Not defined or not loaded" (app/connect.go:315) for the life of the
  // process. Awaited for the same reason: starting them concurrently would make
  // the ordering a race.
  // Awaited on the reap: rigctld opens the CI-V port, and starting it while a
  // leftover modem still has that port is the exact collision this reaps.
  void reaped.then(() => syncRigControl()).then(() => startPatInBackground());

  // On the main window, not on any window: with only a compose window left
  // open, the dock icon must still bring the mailbox back.
  app.on("activate", () => {
    if (!mainWindow) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/**
 * Commands the transmitter off, on both keying paths, before quitting.
 *
 * Never throws and never blocks for long: this runs on the way out, and an
 * error here must not stop the app from closing or mask the teardown that
 * follows. Both paths run because each covers a case the other does not --
 * see the same reasoning in ArdopConnectionManager.connect's finally.
 */
async function releaseRadioOnQuit(): Promise<void> {
  try {
    await rigControl?.session.stopTransmitting();
  } catch {
    // Rig control may already be gone; the profile's own unkey still runs.
  }
  try {
    const profile = configService?.activeProfile();
    if (profile) await releasePtt(profile.ptt);
  } catch {
    // Nothing useful to do on the way out. The port may be gone, or held by
    // the modem we are about to kill -- in which case killing it is the unkey.
  }
}

shutdownArmed = true;
app.on("before-quit", (event) => {
  // First, and on every path: the subprocess path below ends in app.exit(),
  // which never asks a window to close -- so a compose window would never get
  // the chance to keep its draft. Synchronous and idempotent; the drafts store
  // is still open here, and closeMailbox() below is what closes it.
  composeWindows.flushAll();

  if (shuttingDown) return;

  // Stopped first, and on every path: it holds a reconnect timer that would
  // otherwise keep firing against a Pat that is being torn down.
  eventStream?.stop();
  eventStream = null;

  if (!subprocesses.some((s) => s.isRunning())) {
    closeMailbox();
    closeLogger();
    return;
  }

  shuttingDown = true;
  event.preventDefault();
  logger.info("app", "Shutting down subprocesses");

  const hardTimeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS));

  // PTT off BEFORE anything is torn down, and independently of whether the
  // teardown then succeeds. Module 10a's rule.
  //
  // Quitting mid-transmission is one of the two ways to walk away from a keyed
  // radio, and under rig-control keying it is the more dangerous one: Pat holds
  // the asserted PTT through rigctld, so killing Pat and killing rigctld both
  // leave the transmitter on. Nothing later in this function would command the
  // unkey, because by then the connection to the rig is gone.
  //
  // Inside the race against the hard timeout, so a wedged rig cannot stop the
  // app from closing -- but ordered first, so it gets its chance.
  const stopAll = releaseRadioOnQuit()
    .then(() => Promise.all(subprocesses.map((s) => s.stop())))
    .then(() => undefined);

  Promise.race([stopAll, hardTimeout])
    .catch((err: unknown) => {
      logger.error("app", `Error stopping subprocesses: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      closeMailbox();
      closeLogger();
      app.exit(0);
    });
});
