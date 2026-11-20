// All ipcMain.handle registration lives here, keyed off the channel names in
// src/shared/ipcContract.ts. Modules add handlers here rather than scattering
// ipcMain calls through main.

import { app, BrowserWindow, dialog, ipcMain, Menu, shell, systemPreferences } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type {
  AnswerPromptRequest,
  AppConfigView,
  AppInfo,
  ChannelDecisionRequest,
  ConnectionState,
  ArdopConnectRequest,
  ArdopProcessState,
  AudioDevice,
  AudioDeviceTestResult,
  DetectRadioResult,
  PttTestResult,
  TestPttRequest,
  SetDriveLevelRequest,
  TuningOpenRequest,
  TuningState,
  TuningTransmitRequest,
  RadioReadinessView,
  ResetModemResult,
  RmsListRequest,
  RmsStation,
  DiagnosticsReport,
  GetMessageRequest,
  ListFolderRequest,
  MailBox,
  MailFolderCounts,
  MailMessage,
  MailMessageSummary,
  ComposeWindowInit,
  DraftIdRequest,
  DraftSummaryView,
  MailSearchResult,
  RecentContact,
  HybridNetworkView,
  PickupStationRequest,
  PickupStationsView,
  RefreshRequest,
  MarkReadRequest,
  MessageActionRequest,
  CreateFolderRequest,
  EditQueuedRequest,
  FolderIdRequest,
  MoveMessageRequest,
  MoveTarget,
  PopupMenuRequest,
  RenameFolderRequest,
  UserFolder,
  PickedAttachment,
  SaveDraftRequest,
  StashDraftRequest,
  SendResult,
  OpenExternalRequest,
  PatProcessState,
  PatStatus,
  ProfileIdRequest,
  RigctldProcessState,
  RigModel,
  SaveAttachmentRequest,
  SaveAttachmentResult,
  SearchRequest,
  SerialPortInfo,
  TestAudioDevicesRequest,
  SetActiveProfileRequest,
  SetLanPasswordRequest,
  SetDiagnosticsRequest,
  SetPasswordRequest,
  SetStationRequest,
} from "../../shared/ipcContract.ts";
import type { RadioProfileInput } from "../../shared/configSchema.ts";
import type { ComposeDraft } from "../../shared/composeModel.ts";
import type { ConfigService } from "../config/configService.ts";
import type { PatConnectionManager } from "../pat/patConnectionManager.ts";
import type { PatEventStream } from "../pat/patEventStream.ts";
import type { PatApiClient } from "../pat/patApiClient.ts";
import type { PatProcessManager } from "../pat/patProcessManager.ts";
import type { MailboxSync } from "../mailbox/mailboxSync.ts";
import type { HybridNetworkService } from "../winlink/hybridNetworkService.ts";
import type { ComposeService } from "../drafts/composeService.ts";
import type { ComposeWindows } from "../drafts/composeWindows.ts";
import { isMailBox } from "../mailbox/patMessageMapper.ts";
import { buildPopupTemplate } from "../contextMenu.ts";
import type { ArdopProcessManager } from "../ardop/ardopProcessManager.ts";
import type { ArdopConnectionManager } from "../ardop/ardopConnectionManager.ts";
import type { RigctldProcessManager } from "../rigctl/rigctldProcessManager.ts";
import { listAudioDevices } from "../audio/audioDeviceService.ts";
import { testAudioDevices } from "../audio/audioDeviceTest.ts";
import { listSerialPorts } from "../serial/serialPortService.ts";
import { listRigModels } from "../rigctl/rigModelService.ts";
import { detectRadio } from "../serial/civProbe.ts";
import { testPtt } from "../serial/pttTester.ts";
import type { TuningSession } from "../ardop/tuningSession.ts";
import { runSystemCheck } from "../diagnostics/systemCheck.ts";
import { isSessionBusy } from "../../shared/sessionStage.ts";
import { toExternalUrl } from "../util/externalLink.ts";
import { readPatConfig } from "../pat/patConfigFile.ts";
import { appPaths } from "../paths.ts";
import { logFilePath, logger } from "../logging/logger.ts";
import { isTrustedSender, type RendererOrigin } from "./senderGuard.ts";

export interface IpcContext {
  getPatManager: () => PatProcessManager | null;
  getPatClient: () => PatApiClient | null;
  getArdopManager: () => ArdopProcessManager | null;
  getArdopConnection: () => ArdopConnectionManager | null;
  getRigctldManager: () => RigctldProcessManager | null;
  getConfigService: () => ConfigService;
  getConnectionManager: () => PatConnectionManager | null;
  getTuningSession: () => TuningSession | null;
  getEventStream: () => PatEventStream | null;
  getMailboxSync: () => MailboxSync | null;
  getComposeService: () => ComposeService | null;
  getComposeWindows: () => ComposeWindows;
  getHybridNetwork: () => HybridNetworkService | null;
  isShutdownArmed: () => boolean;
  /** Where the renderer is loaded from; IPC from any other frame is refused. */
  rendererOrigin: RendererOrigin;
}

/** Pat's live callsign, or "" when it has no config or no callsign yet. */
function readPatCallsign(configPath: string): string {
  const value = readPatConfig(configPath)?.["mycall"];
  return typeof value === "string" ? value : "";
}

async function readVersionFile(resourcesBin: string, name: string): Promise<string | null> {
  try {
    return (await readFile(path.join(resourcesBin, name), "utf8")).trim();
  } catch {
    return null;
  }
}

function idleArdopState(): ArdopProcessState {
  return {
    state: "idle",
    pid: null,
    binaryPath: "",
    binary: null,
    hostPort: 0,
    lastError: "ARDOP manager not initialised",
  };
}

function idleRigctldState(): RigctldProcessState {
  return {
    state: "idle",
    pid: null,
    binaryPath: "",
    binary: null,
    port: 0,
    model: 0,
    lastError: "Rig control manager not initialised",
  };
}

const IDLE_CONNECTION: ConnectionState = {
  stage: "idle",
  transport: "telnet",
  messagesReceived: null,
  progress: null,
  error: null,
  eventsAttached: false,
};

function idleState(): PatProcessState {
  return {
    state: "idle",
    pid: null,
    binaryPath: "",
    binary: null,
    httpPort: 0,
    lastError: "Pat manager not initialised",
  };
}

/**
 * Writes one attachment wherever the operator chooses.
 *
 * Extracted from the registration below only so the ipcMain.handle call fits on
 * a single line; see the note at its call site.
 */
async function saveAttachment(ctx: IpcContext, input: SaveAttachmentRequest): Promise<SaveAttachmentResult> {
  const client = ctx.getPatClient();
  if (!client) throw new Error("The protocol engine is not running.");

  const box = input?.box;
  if (!isMailBox(box)) throw new Error(`Unknown mailbox folder: ${String(box)}`);

  const mid = String(input?.mid ?? "");
  const name = String(input?.name ?? "");
  if (!name) throw new Error("That attachment has no name.");

  // basename strips any directory component the attachment's own name carries,
  // so a crafted filename cannot steer where the dialog opens or what it writes.
  const suggested = path.basename(name);

  // Asked BEFORE fetching: no point pulling the bytes down from Pat only for the
  // operator to decline to save them.
  const chosen = await dialog.showSaveDialog({ defaultPath: suggested, title: `Save ${suggested}` });
  // Cancelling is an ordinary outcome, not a failure.
  if (chosen.canceled || !chosen.filePath) return { saved: false, path: null };

  const file = await client.getAttachment(box, mid, name);
  // Plain write, not the atomic write used for our own config files. Atomic
  // writing means write-then-rename, and the operator's chosen destination can
  // be on a different filesystem from any temp file we'd stage -- where rename
  // fails. This is their file going to their path; a partial write on a full
  // disk is visible to them and retryable.
  await writeFile(chosen.filePath, file.bytes);
  logger.info("mailbox", `Saved attachment ${suggested} (${file.bytes.length} bytes)`);

  return { saved: true, path: chosen.filePath };
}

/**
 * Attaches files the operator picks to a draft.
 *
 * Extracted only so the ipcMain.handle call fits on one line, like every other
 * channel; the contract test greps for that form.
 */
async function pickAttachment(ctx: IpcContext, input: DraftIdRequest): Promise<PickedAttachment[]> {
  const compose = ctx.getComposeService();
  if (!compose) throw new Error("Compose is not ready yet.");

  const chosen = await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"], title: "Attach files" });
  if (chosen.canceled || chosen.filePaths.length === 0) return [];

  const files = [];
  for (const filePath of chosen.filePaths) {
    files.push({
      name: path.basename(filePath),
      contentType: contentTypeFor(filePath),
      bytes: await readFile(filePath),
    });
  }

  compose.attach(String(input?.id ?? ""), files);
  return files.map((file) => ({ name: file.name, contentType: file.contentType, sizeBytes: file.bytes.length }));
}

async function carryAttachments(
  ctx: IpcContext,
  input: MessageActionRequest & DraftIdRequest,
): Promise<PickedAttachment[]> {
  const compose = ctx.getComposeService();
  if (!compose) throw new Error("Compose is not ready yet.");
  if (!isMailBox(input?.box)) throw new Error(`Unknown mailbox folder: ${String(input?.box)}`);

  const files = await compose.carryAttachments(input.box, String(input?.mid ?? ""), String(input?.id ?? ""));
  return files.map((file) => ({ name: file.name, contentType: file.contentType, sizeBytes: file.bytes.length }));
}

/**
 * A content type from the filename.
 *
 * Only needs to be good enough for Pat, which uses it to decide whether an
 * attachment is a convertible image (app/attachment.go:38-53). Pat falls back
 * to the extension itself when this is empty, so a wrong guess here is not
 * load-bearing.
 */
function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".webp": "image/webp",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".xml": "text/xml",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
  };
  return types[extension] ?? "application/octet-stream";
}

export function registerIpcHandlers(ctx: IpcContext): void {
  /**
   * ipcMain.handle, refusing any sender that is not WL2GO's own top-level page.
   * Navigation and window.open are already refused in hardenWebContents; this
   * holds even if one of those guards fails.
   */
  const handle = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedSender(event.senderFrame, ctx.rendererOrigin)) {
        logger.warn("ipc", `Refused ${channel} from an untrusted frame: ${event.senderFrame?.url ?? "(gone)"}`);
        throw new Error("Refused: this request did not come from WL2GO.");
      }
      return listener(event, ...args);
    });
  };

  handle("pat:getStatus", async (): Promise<PatStatus> => {
    const client = ctx.getPatClient();
    if (!client) throw new Error("Pat is not running");
    return client.getStatus();
  });

  handle("pat:getProcessState", async (): Promise<PatProcessState> => {
    return ctx.getPatManager()?.getState() ?? idleState();
  });

  handle("ardop:getProcessState", async (): Promise<ArdopProcessState> => {
    const manager = ctx.getArdopManager();
    if (!manager) return idleArdopState();
    // Refresh the on-disk view so a rebuilt or removed binary is noticed.
    await manager.inspect();
    return manager.getState();
  });

  /**
   * The radio picker's options, straight out of the binary that will use them.
   *
   * Not cached: it costs one short subprocess and is asked for only when the
   * profile editor opens, and a cached list is one more thing to go stale
   * against a rebuilt Hamlib.
   */
  handle("rigctl:listModels", async (): Promise<RigModel[]> => {
    return listRigModels(appPaths().resourcesBin);
  });

  handle("rigctl:getProcessState", async (): Promise<RigctldProcessState> => {
    const manager = ctx.getRigctldManager();
    if (!manager) return idleRigctldState();
    await manager.inspect();
    return manager.getState();
  });

  handle("audio:listDevices", async (): Promise<AudioDevice[]> => {
    return listAudioDevices(appPaths().resourcesBin);
  });

  handle("serial:listPorts", async (): Promise<SerialPortInfo[]> => {
    return listSerialPorts();
  });

  /** The one reason all three hardware tests are refused. Null when free. */
  function sessionInProgress(): string | null {
    const session = ctx.getConnectionManager();
    if (session && isSessionBusy(session.getState())) {
      return "A Winlink session is in progress. Disconnect before testing the radio.";
    }
    return null;
  }

  handle("serial:detectRadio", async (): Promise<DetectRadioResult> => {
    // Refused during a session for the same reason the sound-card test is: the
    // modem holds the radio's serial port, so every probe would come back
    // silent and read as "no radio" at the worst possible moment.
    const busy = sessionInProgress();
    if (busy) return { found: null, attempts: [], message: busy };
    return detectRadio();
  });

  handle("serial:testPtt", async (_event, request: TestPttRequest): Promise<PttTestResult> => {
    // This one keys a transmitter, so the refusal matters more than most: the
    // modem owns the port mid-session and a second opener would either fail or
    // interleave bytes into ardopcf's own keying.
    const busy = sessionInProgress();
    if (busy) return { ok: false, message: busy };
    return testPtt(request.ptt);
  });

  /**
   * The tuning window.
   *
   * Everything here goes through the one TuningSession, which owns its own
   * modem on a scratch port. tuning:transmit puts a signal on the air; the
   * renderer is responsible for having asked the operator first, and the
   * refusals live in the session itself so that no caller can skip them.
   */
  function tuning(): TuningSession {
    const session = ctx.getTuningSession();
    if (!session) throw new Error("Tuning is not available yet.");
    return session;
  }

  handle("tuning:open", async (_event, request: TuningOpenRequest): Promise<TuningState> => {
    return tuning().open(request);
  });
  handle("tuning:close", async (): Promise<TuningState> => tuning().close());
  handle("tuning:setDriveLevel", async (_event, request: SetDriveLevelRequest): Promise<TuningState> => {
    return tuning().setDriveLevel(request.level);
  });
  handle("tuning:transmit", async (_event, request: TuningTransmitRequest): Promise<TuningState> => {
    return tuning().transmit(request.kind);
  });

  handle("audio:testDevices", async (_event, request: TestAudioDevicesRequest): Promise<AudioDeviceTestResult> => {
    // Refused during a session rather than attempted. The test spawns a SECOND
    // modem, and the sound card is held exclusively -- so it would fail on the
    // device and read as broken hardware, in the middle of the one moment the
    // operator is least able to tell the difference.
    const session = ctx.getConnectionManager();
    if (session && isSessionBusy(session.getState())) {
      return {
        ok: false,
        message: "A Winlink session is in progress. Disconnect before testing the sound card.",
        warnings: [],
      };
    }
    return testAudioDevices(appPaths().resourcesBin, request);
  });

  handle("ardop:readiness", async (): Promise<RadioReadinessView> => {
    const profile = ctx.getConfigService().activeProfile();
    const radio = ctx.getArdopConnection();
    if (!radio) {
      return { ok: false, reason: "The modem is not available.", warnings: [], profileName: profile?.name ?? null };
    }
    const readiness = await radio.readiness();
    return { ...readiness, profileName: profile?.name ?? null };
  });

  handle("ardop:resetModem", async (): Promise<ResetModemResult> => {
    const manager = ctx.getArdopManager();
    if (!manager) throw new Error("The modem is not available.");
    return manager.resetModem();
  });

  handle("ardop:channelDecision", async (_event, input: ChannelDecisionRequest): Promise<void> => {
    // A decision with no check running is a stale click; dropping it is right.
    const decision = input?.decision;
    if (decision === "force" || decision === "wait" || decision === "abort") {
      ctx.getArdopConnection()?.channelDecision(decision);
    }
  });

  handle("diagnostics:run", async (): Promise<DiagnosticsReport> => {
    const manager = ctx.getPatManager();
    const client = ctx.getPatClient();
    const ardop = ctx.getArdopManager();
    const rigctld = ctx.getRigctldManager();

    if (ardop) await ardop.inspect();
    if (rigctld) await rigctld.inspect();

    return runSystemCheck({
      paths: appPaths(),
      patState: manager?.getState() ?? idleState(),
      getPatStatus: async () => {
        if (!client) throw new Error("Pat API client not initialised");
        return client.getStatus();
      },
      ardopState: ardop?.getState() ?? idleArdopState(),
      // Same guard as audio:testDevices, for the same reason: starting a second
      // modem during a session cannot work, and reporting that as a failure
      // would put a red row on the health screen for a healthy busy modem.
      modemInUse: ardop?.isRunning() === true,
      runModemSelfTest: async () => {
        if (!ardop) throw new Error("ARDOP manager not initialised");
        await ardop.selfTest();
      },
      rigctldState: rigctld?.getState() ?? idleRigctldState(),
      runRigctldSelfTest: async () => {
        if (!rigctld) throw new Error("Rig control manager not initialised");
        await rigctld.selfTest();
      },
      listAudioDevices: () => listAudioDevices(appPaths().resourcesBin),
      // Reports for WL2GO itself, not for the ardopcf process it spawns. See
      // the field's note in systemCheck.ts for why that distinction is useful.
      microphoneAccess:
        process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("microphone") : null,
      listSerialPorts: () => listSerialPorts(),
      configView: ctx.getConfigService().view(),
      // From Pat's own config file rather than ours. Note the limit: Pat has no
      // endpoint exposing its live in-memory callsign (GET /api/config re-reads
      // the same file), so if a write succeeded but the restart did not, this
      // reads green while Pat still runs under the old callsign. Still worth
      // showing -- it catches the far more common case of the write not landing.
      patCallsign: readPatCallsign(appPaths().patConfig),
      eventStreamAttached: ctx.getEventStream()?.isAttached() ?? false,
      resourcesRoot: app.isPackaged ? process.resourcesPath : null,
      isPackaged: app.isPackaged,
      appVersion: app.getVersion(),
      logFile: logFilePath(),
      shutdownArmed: ctx.isShutdownArmed(),
    });
  });

  handle("app:getInfo", async (): Promise<AppInfo> => {
    const paths = appPaths();
    return {
      appVersion: app.getVersion(),
      electron: process.versions.electron ?? "unknown",
      node: process.versions.node,
      chrome: process.versions.chrome ?? "unknown",
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      paths,
      patVersion: await readVersionFile(paths.resourcesBin, "PAT_VERSION"),
      ardopcfVersion: await readVersionFile(paths.resourcesBin, "ARDOPCF_VERSION"),
      rigctldVersion: await readVersionFile(paths.resourcesBin, "RIGCTLD_VERSION"),
    };
  });

  // The health screen deliberately shows no filesystem paths, so this is how an
  // operator reaches their logs when reporting a problem.
  handle("app:openLogs", async (): Promise<void> => {
    const dir = appPaths().logs;
    await mkdir(dir, { recursive: true });
    const error = await shell.openPath(dir);
    if (error) throw new Error(`Could not open the logs folder: ${error}`);
  });

  /**
   * Opens a link from a message body in the operator's browser.
   *
   * The scheme is checked HERE, not only in the renderer. shell.openExternal
   * will happily act on file:, and on Windows the shell will act on a good deal
   * more than that -- so a message body must never be able to reach it with
   * anything but http or https, however the renderer was persuaded to ask.
   */
  handle("app:openExternal", async (_event, input: OpenExternalRequest): Promise<void> => {
    const result = toExternalUrl(input?.url);
    if ("error" in result) {
      logger.warn("ipc", `Refused to open a link from a message body: ${result.error}`);
      throw new Error(result.error);
    }

    await shell.openExternal(result.url);
  });

  handle("config:get", async (): Promise<AppConfigView> => {
    return ctx.getConfigService().view();
  });

  handle("config:setStation", async (_event, input: SetStationRequest): Promise<AppConfigView> => {
    return ctx.getConfigService().setStation({
      callsign: input.callsign,
      gridSquare: input.gridSquare,
      shareWithWinlink: input.shareWithWinlink,
    });
  });

  handle("config:setDiagnostics", async (_event, input: SetDiagnosticsRequest): Promise<AppConfigView> => {
    // Anything but an explicit true means off, same as the schema's parse.
    return ctx.getConfigService().setDiagnostics({ recordRxAudio: input.recordRxAudio === true });
  });

  handle("config:setWinlinkPassword", async (_event, input: SetPasswordRequest): Promise<AppConfigView> => {
    return ctx.getConfigService().setWinlinkPassword(input.password);
  });

  handle("profiles:save", async (_event, input: RadioProfileInput): Promise<AppConfigView> => {
    return ctx.getConfigService().saveProfile(input);
  });

  handle("profiles:delete", async (_event, input: ProfileIdRequest): Promise<AppConfigView> => {
    return ctx.getConfigService().deleteProfile(input.id);
  });

  handle("profiles:setActive", async (_event, input: SetActiveProfileRequest): Promise<AppConfigView> => {
    return ctx.getConfigService().setActiveProfile(input.id);
  });

  handle("profiles:setLanPassword", async (_event, input: SetLanPasswordRequest): Promise<AppConfigView> => {
    return ctx.getConfigService().setLanPassword(String(input?.profileId ?? ""), String(input?.password ?? ""));
  });

  // Deliberately no timeout: Pat's ConnectHandler runs the entire session inline
  // and can take minutes. Everything that happens meanwhile arrives on
  // pat:connectionChanged, not here.
  handle("pat:connect", async (): Promise<ConnectionState> => {
    const manager = ctx.getConnectionManager();
    if (!manager) throw new Error("The protocol engine is not running.");
    return manager.connect();
  });

  // Deliberately no timeout, for the same reason as pat:connect -- and more so:
  // an RF session is slower than a Telnet one by a wide margin.
  handle("pat:connectRadio", async (_event, input: ArdopConnectRequest): Promise<ConnectionState> => {
    const radio = ctx.getArdopConnection();
    if (!radio) throw new Error("The modem is not available.");
    return radio.connect({
      target: String(input?.target ?? ""),
      bandwidth: input?.bandwidth ?? null,
      dialKhz: input?.dialKhz ?? null,
      radioOnly: input?.radioOnly === true,
    });
  });

  handle("pat:disconnect", async (): Promise<ConnectionState> => {
    const manager = ctx.getConnectionManager();
    if (!manager) throw new Error("The protocol engine is not running.");
    return manager.disconnect();
  });

  /**
   * The stop button. Never throws, and that is deliberate: this is the control
   * an operator reaches for when the radio is transmitting and should not be,
   * and an exception here would surface as a failed IPC call having done only
   * part of the work, with nothing said about which part.
   */
  handle("pat:abort", async (): Promise<ConnectionState> => {
    const radio = ctx.getArdopConnection();
    const manager = ctx.getConnectionManager();

    if (radio) {
      const result = await radio.abort();
      if (!result.ok) logger.error("ardop", result.message);
    } else {
      // No radio session to tear down, so this is a Telnet session: a dirty
      // disconnect is the whole of the abort.
      await manager?.abort();
    }
    return manager?.getState() ?? IDLE_CONNECTION;
  });

  handle("pat:getConnection", async (): Promise<ConnectionState> => {
    return ctx.getConnectionManager()?.getState() ?? IDLE_CONNECTION;
  });

  handle("pat:rmsList", async (_event, input: RmsListRequest): Promise<RmsStation[]> => {
    const client = ctx.getPatClient();
    if (!client) throw new Error("The protocol engine is not running.");
    // Passed through as Pat serialises it; the renderer maps it with
    // shared/stationList.ts, which is where the awkward shapes are handled.
    return (await client.getRmsList({
      ...(input?.mode ? { mode: input.mode } : {}),
      ...(input?.band ? { band: input.band } : {}),
      ...(input?.prefix ? { prefix: input.prefix } : {}),
      ...(input?.forceDownload ? { forceDownload: true } : {}),
    })) as RmsStation[];
  });

  const requireHybridNetwork = (): HybridNetworkService => {
    const service = ctx.getHybridNetwork();
    if (!service) throw new Error("The hybrid network service is not ready yet.");
    return service;
  };

  // Validated here because it is sent on to the CMS as the operator's account
  // change; Pat checks the same shape again.
  const requirePickupCallsign = (value: unknown): string => {
    const callsign = String(value ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{3,}(-\d{1,2})?$/.test(callsign)) throw new Error("That is not a valid callsign.");
    return callsign;
  };

  // Reads never throw for being offline: they answer with the last copy and
  // the reason it could not be refreshed. Changes reject with a message fit
  // to show, since a change that did not happen must not look like one that did.
  handle("winlink:hybridStations", async (_event, input: RefreshRequest): Promise<HybridNetworkView> => {
    return requireHybridNetwork().hybridStations({ refresh: input?.refresh === true });
  });

  handle("winlink:pickupStations", async (_event, input: RefreshRequest): Promise<PickupStationsView> => {
    return requireHybridNetwork().pickupStations({ refresh: input?.refresh === true });
  });

  handle("winlink:addPickupStation", async (_event, input: PickupStationRequest): Promise<PickupStationsView> => {
    return requireHybridNetwork().addPickupStation(requirePickupCallsign(input?.callsign));
  });

  handle("winlink:removePickupStation", async (_event, input: PickupStationRequest): Promise<PickupStationsView> => {
    return requireHybridNetwork().removePickupStation(requirePickupCallsign(input?.callsign));
  });

  handle("winlink:clearPickupStations", async (): Promise<PickupStationsView> => {
    return requireHybridNetwork().clearPickupStations();
  });

  handle("pat:answerPrompt", async (_event, input: AnswerPromptRequest): Promise<void> => {
    const stream = ctx.getEventStream();
    if (!stream) throw new Error("Not attached to the protocol engine's event stream.");
    stream.respond(input.id, input.value);
  });

  // The renderer is trusted, but the box name reaches Pat's URL path and,
  // through it, a filesystem path. Validating against the four Pat actually
  // has costs nothing and means a malformed value is rejected here rather than
  // becoming a traversal attempt one layer down.
  const requireBox = (value: unknown): MailBox => {
    if (!isMailBox(value)) throw new Error(`Unknown mailbox folder: ${String(value)}`);
    return value;
  };

  const requireMoveTarget = (value: unknown): MoveTarget => {
    const target = (value ?? {}) as Record<string, unknown>;
    if (typeof target["folderId"] === "string" && target["folderId"]) return { folderId: target["folderId"] };
    const box = target["box"];
    if (box === "in" || box === "sent" || box === "archive") return { box };
    throw new Error("Messages can only be moved to Inbox, Sent, Archive or a folder.");
  };

  const requireMailbox = (): MailboxSync => {
    const sync = ctx.getMailboxSync();
    if (!sync) throw new Error("The mailbox is not ready yet.");
    return sync;
  };

  // Served straight from the local cache: the list must render instantly and
  // must keep working when Pat is down or the operator is off-grid.
  handle("mailbox:listFolder", async (_event, input: ListFolderRequest): Promise<MailMessageSummary[]> => {
    return requireMailbox().listFolder(requireBox(input?.box));
  });

  // The one mailbox read that can reach Pat: bodies are fetched on first open,
  // because the folder listing never carries them.
  handle("mailbox:getMessage", async (_event, input: GetMessageRequest): Promise<MailMessage | null> => {
    return requireMailbox().loadBody(requireBox(input?.box), String(input?.mid ?? ""));
  });

  handle("mailbox:getCounts", async (): Promise<MailFolderCounts> => {
    return requireMailbox().counts();
  });

  handle("mailbox:markRead", async (_event, input: MarkReadRequest): Promise<void> => {
    await requireMailbox().markRead(requireBox(input?.box), String(input?.mid ?? ""), input?.read === true);
  });

  handle("mailbox:rebuild", async (): Promise<void> => {
    await requireMailbox().rebuild();
  });

  handle("mailbox:search", async (_event, input: SearchRequest): Promise<MailSearchResult[]> => {
    return requireMailbox().search(String(input?.query ?? ""));
  });

  // For the compose address fields. Cache only, like search, so suggestions
  // still come up when Pat is down or the operator is off-grid.
  handle("mailbox:recentContacts", async (): Promise<RecentContact[]> => {
    return requireMailbox().recentContacts();
  });

  // What the Delete action does everywhere except Archive: a move, which is
  // reversible, rather than the unrecoverable os.Remove below.
  handle("mailbox:archive", async (_event, input: GetMessageRequest): Promise<void> => {
    await requireMailbox().archiveMessage(requireBox(input?.box), String(input?.mid ?? ""));
  });

  // Final. Pat has no trash folder, so the confirmation in front of this is the
  // only thing between the operator and losing the message.
  handle("mailbox:delete", async (_event, input: GetMessageRequest): Promise<void> => {
    await requireMailbox().deleteMessage(requireBox(input?.box), String(input?.mid ?? ""));
  });

  // Registered on one line, like every other channel: the contract test greps
  // for exactly this form, which is what keeps the three files in step.
  handle("mailbox:saveAttachment", (_event, input: SaveAttachmentRequest) => saveAttachment(ctx, input));

  handle("mailbox:move", async (_event, input: MoveMessageRequest): Promise<void> => {
    await requireMailbox().move(requireBox(input?.box), String(input?.mid ?? ""), requireMoveTarget(input?.target));
  });

  handle("folders:list", async (): Promise<UserFolder[]> => {
    return ctx.getMailboxSync()?.userFolders() ?? [];
  });

  handle("folders:create", async (_event, input: CreateFolderRequest): Promise<UserFolder> => {
    return requireMailbox().createFolder(String(input?.name ?? ""));
  });

  handle("folders:rename", async (_event, input: RenameFolderRequest): Promise<void> => {
    requireMailbox().renameFolder(String(input?.id ?? ""), String(input?.name ?? ""));
  });

  handle("folders:delete", async (_event, input: FolderIdRequest): Promise<void> => {
    requireMailbox().deleteFolder(String(input?.id ?? ""));
  });

  handle("folders:listMessages", async (_event, input: FolderIdRequest): Promise<MailMessageSummary[]> => {
    return requireMailbox().listUserFolder(String(input?.id ?? ""));
  });

  // A native menu, described by the renderer. Resolves with the chosen id, or
  // null when dismissed. The click is given a moment to land before the close
  // callback resolves null: on macOS the menu reports itself closed before the
  // chosen item's click handler runs.
  handle("menu:popup", (event, input: PopupMenuRequest) => {
    return new Promise<string | null>((resolve) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const template = buildPopupTemplate(input?.items ?? [], (id) => resolve(id));
      if (!win || template.length === 0) {
        resolve(null);
        return;
      }
      const at = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined);
      const x = at(input?.x);
      const y = at(input?.y);
      Menu.buildFromTemplate(template).popup({
        window: win,
        ...(x !== undefined && y !== undefined ? { x, y } : {}),
        callback: () => setTimeout(() => resolve(null), 100),
      });
    });
  });

  const requireCompose = (): ComposeService => {
    const compose = ctx.getComposeService();
    if (!compose) throw new Error("Compose is not ready yet.");
    return compose;
  };

  handle("drafts:list", async (): Promise<DraftSummaryView[]> => {
    return requireCompose().list();
  });

  handle("drafts:get", async (_event, input: DraftIdRequest): Promise<ComposeDraft | null> => {
    return requireCompose().get(String(input?.id ?? ""));
  });

  handle("drafts:save", async (_event, input: SaveDraftRequest): Promise<void> => {
    requireCompose().save(input.draft);
  });

  handle("drafts:delete", async (_event, input: DraftIdRequest): Promise<void> => {
    requireCompose().delete(String(input?.id ?? ""));
  });

  handle("compose:send", async (_event, input: SaveDraftRequest): Promise<SendResult> => {
    return requireCompose().send(input.draft);
  });

  handle("compose:editQueued", async (_event, input: EditQueuedRequest): Promise<ComposeDraft> => {
    return requireCompose().editQueued(String(input?.mid ?? ""));
  });

  handle("compose:acknowledge", async (_event, input: MessageActionRequest): Promise<void> => {
    await requireCompose().acknowledge(requireBox(input?.box), String(input?.mid ?? ""));
  });

  handle("compose:pickAttachment", (_event, input: DraftIdRequest) => pickAttachment(ctx, input));

  handle("compose:carryAttachments", (_event, input: MessageActionRequest & DraftIdRequest) =>
    carryAttachments(ctx, input),
  );

  // Pop-out compose windows. Each is addressed by the window that asks, so a
  // renderer can only ever read or close its own.
  handle("compose:openWindow", async (_event, input: ComposeWindowInit): Promise<void> => {
    if (!input?.draft?.id) throw new Error("No draft to open.");
    ctx.getComposeWindows().open({ draft: input.draft, recipientsOnly: input.recipientsOnly === true });
  });

  handle("compose:windowInit", async (event): Promise<ComposeWindowInit | null> => {
    return ctx.getComposeWindows().init(event.sender.id);
  });

  handle("compose:stash", async (event, input: StashDraftRequest): Promise<void> => {
    ctx.getComposeWindows().stash(event.sender.id, input?.draft ?? null, input?.dirty === true);
  });

  handle("compose:closeWindow", async (event): Promise<void> => {
    ctx.getComposeWindows().closeQuietly(event.sender.id);
  });

  handle("compose:focusWindow", async (_event, input: DraftIdRequest): Promise<boolean> => {
    return ctx.getComposeWindows().focus(String(input?.id ?? ""));
  });

  logger.info("ipc", "Registered IPC handlers");
}
