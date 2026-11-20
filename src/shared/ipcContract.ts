// Single source of truth for main <-> renderer IPC.
// Every module extends this file rather than adding ad hoc ipcMain.handle calls.

import type {
  AppConfig,
  AudioDeviceSelection,
  HamlibConfig,
  PttConfig,
  RadioProfileInput,
  TxMode,
} from "./configSchema.ts";
import type { ComposeDraft } from "./composeModel.ts";
import type { PatFrequency } from "./ardopUrl.ts";

/** Shape of Pat's GET /api/status. Verified against api/types/types.go @ v1.0.0. */
export interface PatStatus {
  active_listeners: string[];
  connected: boolean;
  dialing: boolean;
  remote_addr: string;
  http_clients: string[];
  config_hash: string;
}

export type ExecutableFormat = "macho" | "elf" | "pe" | "unknown";
export type ExecutableArch = "arm64" | "x64" | "x86" | "unknown";

/**
 * What a vendored binary actually is on disk. Exists because a binary built for
 * the wrong OS/arch fails at spawn time with an opaque error; naming the
 * mismatch up front is far more useful than "spawn ENOENT".
 */
export interface BinaryInfo {
  path: string;
  exists: boolean;
  format: ExecutableFormat;
  arch: ExecutableArch;
  sizeBytes: number | null;
  /** Whether format and arch match the host this app is running on. */
  matchesHost: boolean;
}

export type SubprocessState = "idle" | "starting" | "running" | "failed" | "stopped";

export interface PatProcessState {
  state: SubprocessState;
  pid: number | null;
  binaryPath: string;
  binary: BinaryInfo | null;
  httpPort: number;
  lastError: string | null;
}

export interface ArdopProcessState {
  state: SubprocessState;
  pid: number | null;
  binaryPath: string;
  binary: BinaryInfo | null;
  /** TCP command port; the data port is always this plus one. */
  hostPort: number;
  lastError: string | null;
}

/**
 * The receive half of the status-bar activity lights.
 *
 * "receiving" means the demodulator has locked onto a leader and is working on
 * a frame; "good"/"bad" is how the most recent frame ended, and holds until the
 * next leader arrives so the operator can read the outcome after the fact.
 */
export type RxIndicator = "idle" | "receiving" | "good" | "bad";

/** What the session modem is doing on the air, derived from its console log. */
export interface ModemActivity {
  transmitting: boolean;
  rx: RxIndicator;
}

export interface RigctldProcessState {
  state: SubprocessState;
  pid: number | null;
  binaryPath: string;
  binary: BinaryInfo | null;
  port: number;
  /** Hamlib rig model number; 1 is the hardware-free dummy backend. */
  model: number;
  lastError: string | null;
}

/** An audio device as ardopcf sees it. The index is what the modem is given. */
export interface AudioDevice {
  direction: "capture" | "playback";
  /**
   * PortAudio's device index. This is what ardopcf is handed, but it is NOT
   * stable: plugging or unplugging anything renumbers the list. The name is the
   * part that persists -- see AudioDeviceSelection in configSchema.ts.
   */
  index: number;
  name: string;
  /** PortAudio host API, e.g. "Core Audio". */
  hostApi: string;
  /** Channels available in this direction. */
  maxChannels: number;
  /** The system default device for this direction. */
  isDefault: boolean;
  /**
   * Whether PortAudio predicts the device can be opened the way the modem opens
   * it (12000 Hz, mono, int16).
   *
   * ADVISORY ONLY. ardopcf never asks this question -- it just calls
   * Pa_OpenStream -- and CoreAudio resamples transparently, so a "false" here
   * can still open fine. Show it as a warning; never refuse a device for it.
   */
  supports12k: boolean;
}

export interface SerialPortInfo {
  /**
   * The path to hand to rigctld and ardopcf. On macOS this is the callout node
   * (/dev/cu.*), which is not always what the OS enumerated -- see systemPath.
   */
  path: string;
  /** The path as the OS reported it, kept for diagnostics. */
  systemPath: string;
  manufacturer: string | null;
  serialNumber: string | null;
  vendorId: string | null;
  productId: string | null;
  /**
   * Whether this looks like a USB interface a radio could be on. False for
   * things like a Bluetooth serial profile or a debug console. Used to order
   * and label the list -- never to hide an entry.
   */
  likelyRadioInterface: boolean;
}

/**
 * A propagation forecast for one station.
 *
 * NULLABLE in Pat's own struct (app/rmslist.go:57), and "no prediction" is an
 * ordinary state rather than an error: the operator may be offline, or the
 * model may have nothing to say about that path.
 */
export interface RmsPrediction {
  /** Pat's VOACAP link quality. Advisory -- never used to filter or refuse. */
  link_quality: number;
}

/**
 * One RMS gateway, exactly as Pat serialises it (app/rmslist.go:50-60).
 *
 * Two shapes here are easy to get wrong and neither would be caught by tsc:
 * `freq`/`dial` are OBJECTS, not numbers (Frequency has a custom MarshalJSON
 * emitting {hz, khz, desc} -- app/freq.go:52-63), and `distance`/`azimuth` are
 * null rather than absent when the operator has no grid square set, because
 * JSONFloat64 marshals NaN as null.
 */
export interface RmsStation {
  callsign: string;
  gridsquare: string;
  /** Great-circle kilometres, or null when our own grid square is unknown. */
  distance: number | null;
  /** Bearing in degrees, or null for the same reason. */
  azimuth: number | null;
  /** A free-text mode list, e.g. "ARDOP 2000 / VARA". */
  modes: string;
  freq: PatFrequency | null;
  dial: PatFrequency | null;
  /** The connect URL Pat built. Sanitised before use -- see shared/ardopUrl.ts. */
  url: string | null;
  prediction: RmsPrediction | null;
}

export interface RmsListRequest {
  /** Filters server-side, e.g. "ardop". */
  mode?: string;
  band?: string;
  prefix?: string;
  /** Bypasses Pat's cache. Needs the internet; the cache does not. */
  forceDownload?: boolean;
}

/** Whether the active radio profile could hold a session right now. */
export interface RadioReadinessView {
  ok: boolean;
  /** Why not, fit to show as the reason a menu entry is greyed out. */
  reason: string | null;
  /** Worth saying even when ok; never a reason to refuse. */
  warnings: string[];
  /** The active profile's name, so the menu entry can be labelled. */
  profileName: string | null;
}

/** One radio Hamlib can drive, as `rigctld -l` reports it. */
export interface RigModel {
  /** Hamlib's rig model number, e.g. 3094 for an IC-7300 MkII. */
  model: number;
  make: string;
  name: string;
  /** Hamlib's own maturity rating. Only Stable and Beta are offered. */
  status: string;
}

/** Which station to call over the air. */
/** A hybrid RMS gateway: one that forwards mail over RF when the CMS is unreachable. */
export interface HybridStation {
  callsign: string;
  automaticForwarding: boolean;
  manualForwarding: boolean;
}

/** One of the stations that hold the operator's mail on the hybrid network. */
export interface PickupStation {
  callsign: string;
  /** When it was added, as the CMS reports it, in UTC ISO form. */
  addedAt: string;
}

/**
 * The hybrid station list as last fetched.
 *
 * Fetched over the internet only, and kept locally so it is still there when
 * the internet is not. `error` says why a refresh failed; the stations are then
 * the last ones seen, and `fetchedAt` says when that was.
 */
export interface HybridNetworkView {
  stations: HybridStation[];
  /** Null when the list has never been fetched. */
  fetchedAt: string | null;
  error: string | null;
}

/** The operator's pickup stations as last seen, on the same terms as HybridNetworkView. */
export interface PickupStationsView {
  stations: PickupStation[];
  fetchedAt: string | null;
  error: string | null;
  /** Changing the list needs the Winlink password; reading it does not. */
  passwordStored: boolean;
}

export interface RefreshRequest {
  /** Fetch from the CMS now rather than serving the local copy. */
  refresh?: boolean;
}

export interface PickupStationRequest {
  callsign: string;
}

export interface ArdopConnectRequest {
  /** The RMS gateway callsign. */
  target: string;
  /** ARQ bandwidth, or null to leave the modem's configured default alone. */
  bandwidth?: string | null;
  /**
   * The dial frequency in kHz of the row the operator chose.
   *
   * Carried as DATA, alongside the bandwidth and for the same reason: a gateway
   * appears once per frequency it keeps, so the frequency is a property of the
   * chosen row rather than of the callsign. It is used only when the active
   * profile has rig control -- see shared/ardopUrl.ts.
   */
  dialKhz?: number | null;
  /**
   * Winlink hybrid Radio-Only mode: mail stays on the RF network, no internet
   * at the far station. Per call, from the direct-call dialog. Incompatible
   * with a callsign carrying an SSID -- validated before anything transmits.
   */
  radioOnly?: boolean;
}

/** The outcome of force-killing a wedged modem. */
export interface ResetModemResult {
  ok: boolean;
  message: string;
}

/** Which two devices to try opening. Either may be null, meaning "system default". */
export interface TestAudioDevicesRequest {
  input: AudioDeviceSelection | null;
  output: AudioDeviceSelection | null;
}

/** The outcome of resolving a saved device selection against what is present now. */
export interface AudioDeviceTestResult {
  ok: boolean;
  /** One sentence fit to show the operator, whether it worked or not. */
  message: string;
  /** Non-fatal things worth saying even when ok is true. */
  warnings: string[];
}

/** A prompt Pat is waiting on. Kinds are from Pat's api/types/prompt.go. */
export type PatPromptKind =
  | "password"
  | "multi-select"
  | "busy-channel"
  | "pre-account-activation"
  | "account-activation";

export interface PatPromptOption {
  value: string;
  desc?: string;
  checked: boolean;
}

export interface PatPrompt {
  id: string;
  kind: PatPromptKind;
  message: string;
  options?: PatPromptOption[];
}

/**
 * The pre-dial clear-channel check, as the status bar and hold dialog see it.
 *
 * "monitoring" is the 10-second countdown towards a clear verdict; "holding"
 * means a signal was heard and transmission is on hold until the channel has
 * been clear for the full window again; "done" is pushed once when the check
 * ends, however it ends, so stale state cannot outlive it.
 */
export type ChannelCheckPhase = "monitoring" | "holding" | "done";

export interface ChannelCheckEvent {
  phase: ChannelCheckPhase;
  /** Whole seconds left in the clear window while monitoring; null otherwise. */
  secondsRemaining: number | null;
  /** True exactly once, on the first transition to holding: show the dialog. */
  promptOperator: boolean;
}

/** The operator's answer to the hold dialog. "wait" keeps waiting for clear. */
export type ChannelHoldDecision = "force" | "wait" | "abort";

export interface ChannelDecisionRequest {
  decision: ChannelHoldDecision;
}

/** Transfer progress for one message, as Pat reports it during a session. */
export interface PatProgress {
  bytes_transferred: number;
  bytes_total: number;
  mid: string;
  subject: string;
  receiving: boolean;
  sending: boolean;
  done: boolean;
}

/**
 * How far a Winlink session has got. ONE vocabulary for every transport.
 *
 * An RF session has stages Telnet does not, and an operator watching a slow
 * ARDOP connect needs to see which one is stalling. The temptation is a second
 * enum for RF -- which would be two things to keep in step, disagreeing the
 * first time either changed. So Telnet simply never enters the RF-only stages.
 *
 * What is deliberately ABSENT is as load-bearing as what is here. There is no
 * ptt-keyed and no negotiating-bandwidth: that telemetry lives on ardopcf's
 * WebGui socket, which nothing reads yet. Inferring them from the shape of
 * Pat's log lines would be guessing, and a status display that quietly guesses
 * is worse than one that admits it cannot see. Every stage below is reported by
 * something we actually observe -- our own actions, or a specific line Pat logs.
 *
 * There is also no "transferring": ConnectionState.progress already carries
 * that, and a second source for one fact is how the two drift apart.
 */
export type SessionStage =
  | "idle"
  /** RF only: our own ardopcf is starting. We are doing it, so we can see it. */
  | "starting-modem"
  /** RF only: the modem is listening for a clear channel before dialling. */
  | "checking-channel"
  /** Pat is dialling. Telnet reaches this immediately; ARDOP after the modem. */
  | "dialing"
  /** The link is up and the FBB handshake is running (Pat: "Connected to ..."). */
  | "handshaking"
  /** Pat's own status says connected; mail is moving. */
  | "connected"
  /**
   * RF only: mail is done and the disconnect is going out. Reported by a
   * specific ardopcf console line, not inferred -- see main/ardop/
   * modemActivity.ts for the exact match. Says NOTHING about the station ID:
   * claiming the ID here is how the status bar once reported an ID that a
   * teardown race kept off the air.
   */
  | "signing-off"
  /**
   * RF only: the final IDFrame and CW ID are actually being transmitted --
   * ardopcf's own "SendID" / "Sending CW ID of" lines, nothing inferred. The
   * teardown holds the modem alive through this stage (finalIdWatcher.ts).
   */
  | "sending-id"
  | "finished"
  | "failed";

/** Which way a session went out. Decides which stages can be entered. */
export type SessionTransport = "telnet" | "ardop";

/** What the UI needs to show about the current or last session. */
export interface ConnectionState {
  stage: SessionStage;
  /** How the last or current session was dialled. */
  transport: SessionTransport;
  /** Null until a session has finished. */
  messagesReceived: number | null;
  progress: PatProgress | null;
  /** A named reason, never Pat's bare "Session failure". */
  error: string | null;
  /** Whether the event stream is attached; connecting is refused without it. */
  eventsAttached: boolean;
}

export type CheckStatus = "pass" | "warn" | "fail" | "pending";

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Shown to the operator when the check is not passing. */
  hint?: string;
}

export interface DiagnosticsReport {
  generatedAt: string;
  overall: CheckStatus;
  checks: DiagnosticCheck[];
  patStatus: PatStatus | null;
}

/**
 * The config as the renderer sees it.
 *
 * This is AppConfig plus two facts about secrets -- never the secrets. Passwords
 * live in a separate store and have no field in AppConfig at all, so there is
 * nothing here to accidentally widen into a leak.
 */
export interface AppConfigView extends AppConfig {
  hasWinlinkPassword: boolean;
  /** Profile ids with a network radio password in the keychain. Never the values. */
  profilesWithLanPassword: string[];
  /** False on systems with no keyring; the UI must then refuse to collect one. */
  secureStorageAvailable: boolean;
  /** Anything the config file needed repaired on load. */
  warnings: string[];
}

export interface SetStationRequest {
  callsign: string;
  gridSquare: string;
  shareWithWinlink: boolean;
}

export interface SetDiagnosticsRequest {
  /** Applies from the NEXT session; a running modem's flags are already set. */
  recordRxAudio: boolean;
}

/** An empty password clears the stored one. */
export interface SetPasswordRequest {
  password: string;
}

export interface ProfileIdRequest {
  id: string;
}

/** A networked radio's login password. An empty string clears it. */
export interface SetLanPasswordRequest {
  profileId: string;
  password: string;
}

export interface SetActiveProfileRequest {
  id: string | null;
}

/** An operator's answer to a prompt Pat raised mid-session. */
export interface AnswerPromptRequest {
  id: string;
  value: string;
}

/**
 * A Winlink-assigned password WL2GO caught out of Pat's output.
 *
 * Pat only ever prints it, so this is shown once and prominently -- an operator
 * who misses it cannot connect again.
 */
export interface ActivationPasswordEvent {
  password: string;
  stored: boolean;
}

/**
 * Pat's four mailbox folders. There are exactly these and no others: the
 * listing handler switches on them exhaustively and 404s anything else
 * (api/mailbox.go:37-49). No drafts, no trash, no user-defined folders.
 */
export type MailBox = "in" | "out" | "sent" | "archive";

export const MAIL_BOXES: readonly MailBox[] = ["in", "out", "sent", "archive"];

/**
 * A folder in the sidebar, which is Pat's four plus our own Drafts.
 *
 * Deliberately a WIDER type than MailBox rather than an extension of it.
 * MailBox is what reaches Pat's URL paths, so "drafts" must never be assignable
 * to it -- Pat has no such folder and would 404, or worse, be handed it as a
 * move target. Keeping them separate makes that a compile error.
 */
export type MailFolderId = MailBox | "drafts" | UserFolderId;

/**
 * One of the operator's own folders, as the sidebar selects it.
 *
 * Prefixed so it can never collide with a MailBox or "drafts", and never be
 * mistaken for one: a user folder is a label over Pat's Archive, not a folder
 * Pat knows (see main/folders/folderStore.ts).
 */
export type UserFolderId = `folder:${string}`;

/** An operator-defined folder, with the counts the sidebar shows. */
export interface UserFolder {
  id: string;
  name: string;
  total: number;
  unread: number;
}

/**
 * Where a message can be moved to. Never the Outbox: a message there is one
 * Pat will transmit, and Pat refuses the move anyway (api/mailbox.go:233).
 */
export type MoveTarget = { box: "in" | "sent" | "archive" } | { folderId: string };

export interface MoveMessageRequest {
  box: MailBox;
  mid: string;
  target: MoveTarget;
}

export interface CreateFolderRequest {
  name: string;
}

export interface RenameFolderRequest {
  id: string;
  name: string;
}

export interface FolderIdRequest {
  id: string;
}

/**
 * One entry in a native popup menu the renderer asks main to show.
 *
 * Described rather than built: the renderer cannot reach Electron's Menu, and
 * a native menu is what a right-click should look like on every platform.
 */
export interface PopupMenuItem {
  /** Returned when chosen. Omitted on separators and submenu parents. */
  id?: string;
  label?: string;
  type?: "separator";
  enabled?: boolean;
  submenu?: PopupMenuItem[];
}

export interface PopupMenuRequest {
  items: PopupMenuItem[];
  /** Window coordinates to open at; the cursor position when omitted. */
  x?: number;
  y?: number;
}

export const DRAFTS_FOLDER = "drafts";

/**
 * One attachment, as Pat describes it.
 *
 * Never its content: fbb.File.MarshalJSON emits only these two fields and
 * structurally cannot emit the bytes (fbb/message.go:511-518), which are
 * fetched separately and never cached.
 */
export interface MailAttachment {
  name: string;
  sizeBytes: number;
}

/** A message as the list needs it: everything except the body. */
export interface MailMessageSummary {
  box: MailBox;
  /**
   * Pat's Mid header. Stable across folder moves -- it is the filename stem --
   * but NOT unique on its own: the same message can exist in `sent` and `in`.
   */
  mid: string;
  /** Normalised to UTC ISO 8601, so string ordering is chronological ordering. */
  date: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  unread: boolean;
  p2pOnly: boolean;
  attachments: MailAttachment[];
}

/** A message with its body, which only the single-message endpoint returns. */
export interface MailMessage extends MailMessageSummary {
  /** Null when the body has not been fetched yet. */
  body: string | null;
}

/** A search hit: a summary plus why it matched. */
export interface MailSearchResult extends MailMessageSummary {
  /** The user folder an archived hit is filed in, so the list can say where it is. */
  folderName?: string;
  /**
   * A fragment of the body around the match, empty when the hit was on the
   * subject or sender alone. Shows the operator WHY a message came back.
   */
  snippet: string;
}

/**
 * Someone the operator has exchanged traffic with, derived from the mailbox
 * cache. Offered as a suggestion in the compose address fields.
 */
export interface RecentContact {
  /** As most recently written -- the case of an email local part can matter. */
  address: string;
  /** The date of the newest message with them, in the cache's UTC ISO form. */
  lastUsed: string;
  /** How many cached messages they appear in. Breaks ties in ordering. */
  count: number;
}

export interface MailFolderCount {
  total: number;
  unread: number;
}

export type MailFolderCounts = Record<MailBox, MailFolderCount>;

export interface ListFolderRequest {
  box: MailBox;
}

export interface GetMessageRequest {
  box: MailBox;
  mid: string;
}

export interface SearchRequest {
  query: string;
}

export interface SaveAttachmentRequest {
  box: MailBox;
  mid: string;
  /** The attachment's exact name; Pat matches on it verbatim. */
  name: string;
}

/** Cancelling the save dialog is an ordinary outcome, not a failure. */
export interface SaveAttachmentResult {
  saved: boolean;
  path: string | null;
}

export interface OpenExternalRequest {
  url: string;
}

export interface MarkReadRequest {
  box: MailBox;
  mid: string;
  read: boolean;
}

/** Pushed whenever the cache changes, so views refresh without polling. */
export interface MailboxChangedEvent {
  counts: MailFolderCounts;
  /** Which folders actually changed, so an unaffected list need not re-fetch. */
  boxes: MailBox[];
}

/** A draft as the message list needs it. */
export interface DraftSummaryView {
  id: string;
  updatedAt: string;
  to: string;
  subject: string;
  /** The start of the body, so an untitled draft is still recognisable. */
  preview: string;
  attachmentCount: number;
}

export interface DraftIdRequest {
  id: string;
}

export interface SaveDraftRequest {
  draft: ComposeDraft;
}

/** What a pop-out compose window opens on. */
export interface ComposeWindowInit {
  draft: ComposeDraft;
  /** Forward Without Changes edits nothing but the recipients. */
  recipientsOnly: boolean;
}

/**
 * A composing renderer's current draft, kept in main so closing or quitting
 * cannot lose it. Null once there is nothing left to keep.
 */
export interface StashDraftRequest {
  draft: ComposeDraft | null;
  /** Edited since it was opened. An untouched inline reply is not kept. */
  dirty: boolean;
}

/** A file the operator picked, as compose knows it before it is sent. */
export interface PickedAttachment {
  name: string;
  contentType: string;
  sizeBytes: number;
}

/** A message waiting in the outbox, by MID. */
export interface EditQueuedRequest {
  mid: string;
}

/** Which message an action is derived from. */
export interface MessageActionRequest {
  box: MailBox;
  mid: string;
}

export interface SendResult {
  /** False when the draft failed our validation; problems says why. */
  sent: boolean;
  problems: string[];
}

export interface AppPaths {
  userData: string;
  logs: string;
  config: string;
  secrets: string;
  patConfig: string;
  patMailbox: string;
  patPrehooks: string;
  patLog: string;
  patEventLog: string;
  patForms: string;
  mailboxDb: string;
  draftsDb: string;
  foldersDb: string;
  /** The last hybrid station list and pickup stations seen. Copies only. */
  winlinkNetwork: string;
  resourcesBin: string;
}

export interface AppInfo {
  appVersion: string;
  electron: string;
  node: string;
  chrome: string;
  platform: string;
  arch: string;
  isPackaged: boolean;
  paths: AppPaths;
  patVersion: string | null;
  ardopcfVersion: string | null;
  rigctldVersion: string | null;
}

/** What a CI-V probe found, or what it tried. See main/serial/civProbe.ts. */
export interface DetectRadioResult {
  found: {
    port: string;
    baud: number;
    civAddress: number;
    /** The matching preset id, or null for a radio on a non-default address. */
    presetId: string | null;
    summary: string;
  } | null;
  /** Ports and speeds actually tried, so "nothing found" is actionable. */
  attempts: string[];
  message: string;
}

/**
 * The keying to test.
 *
 * The whole PttConfig travels rather than a profile id, because this runs on
 * the DRAFT in the editor -- the point is to try a setting before saving it.
 */
export interface TestPttRequest {
  ptt: PttConfig;
}

export interface PttTestResult {
  ok: boolean;
  message: string;
}

/**
 * The tuning window's live state.
 *
 * receiveLevel is the RECEIVE audio peak, not ALC. WL2GO cannot read the
 * radio's ALC meter: doing so needs a CAT read while transmitting, and during a
 * two-tone test ardopcf owns the CAT port exclusively. That arrives with rig
 * control; until then the ALC reading is the one on the radio's front panel.
 */
export interface TuningState {
  phase: "idle" | "starting" | "ready";
  /** Transmit drive, 0-100. Echoed back by the modem, not merely assumed. */
  driveLevel: number;
  /** Receive audio peak, 0 to receiveLevelFullScale. */
  receiveLevel: number;
  receiveLevelFullScale: number;
  transmitting: boolean;
  error: string | null;
  /** Why the meter is off, when it is. Never a reason to block tuning. */
  meterUnavailable: string | null;
}

/**
 * What to tune, taken from the DRAFT rather than from the active profile.
 *
 * Same reasoning as TestPttRequest and TestAudioDevicesRequest: this runs while
 * a profile is being edited or created, so the active profile is the wrong
 * radio (a second profile being edited) or no radio at all (the wizard, where
 * the profile does not exist yet). The callsign is not here because it is
 * station-level and genuinely global.
 */
export interface TuningOpenRequest {
  audioInput: AudioDeviceSelection | null;
  audioOutput: AudioDeviceSelection | null;
  ptt: PttConfig;
  driveLevel: number;
  /**
   * The draft's rig control, or null for none.
   *
   * Carried for two separate reasons, both of which the tuning window is
   * useless without. It is what KEYS the radio when ptt.method is "rigctld":
   * ardopcf is given no PTT arguments then and reports PTT to its host, which
   * here is WL2GO rather than Pat. And it is what puts the radio into a data
   * mode, without which the two-tone test modulates nothing and the drive
   * level being set has no visible effect on the ALC at all.
   */
  hamlib: HamlibConfig | null;
  txMode: TxMode;
}

export interface SetDriveLevelRequest {
  level: number;
}

export interface TuningTransmitRequest {
  /** Two tones for five seconds, or one short identifying frame. */
  kind: "twoTone" | "id";
}

/** Renderer -> main request/response channels. */
export interface IpcApi {
  "pat:getStatus": { request: void; response: PatStatus };
  "pat:getProcessState": { request: void; response: PatProcessState };
  "ardop:getProcessState": { request: void; response: ArdopProcessState };
  "rigctl:getProcessState": { request: void; response: RigctldProcessState };
  "audio:listDevices": { request: void; response: AudioDevice[] };
  "serial:listPorts": { request: void; response: SerialPortInfo[] };
  /** Asks every serial port who is there. Read-only; cannot key a transmitter. */
  "serial:detectRadio": { request: void; response: DetectRadioResult };
  /** Keys the radio for about a second so the operator can see whether it works. */
  "serial:testPtt": { request: TestPttRequest; response: PttTestResult };
  /** Starts the tuning modem. Opens the sound card, so refused during a session. */
  "tuning:open": { request: TuningOpenRequest; response: TuningState };
  "tuning:close": { request: void; response: TuningState };
  "tuning:setDriveLevel": { request: SetDriveLevelRequest; response: TuningState };
  /** TRANSMITS. Confirm with the operator before calling. */
  "tuning:transmit": { request: TuningTransmitRequest; response: TuningState };
  /** Actually opens the chosen devices with the modem, briefly, and reports back. */
  "audio:testDevices": { request: TestAudioDevicesRequest; response: AudioDeviceTestResult };
  /** Can the active radio profile hold a session? Spawns nothing. */
  "ardop:readiness": { request: void; response: RadioReadinessView };
  /** Force-kills a wedged modem and reports whether the port came free. */
  "ardop:resetModem": { request: void; response: ResetModemResult };
  /** The operator's answer to the clear-channel hold dialog. */
  "ardop:channelDecision": { request: ChannelDecisionRequest; response: void };
  /** The radio models this build of Hamlib can drive. Runs rigctld -l. */
  "rigctl:listModels": { request: void; response: RigModel[] };
  "diagnostics:run": { request: void; response: DiagnosticsReport };
  "app:getInfo": { request: void; response: AppInfo };
  "app:openLogs": { request: void; response: void };
  /** Opens a link in the operator's browser. http/https only, checked in main. */
  "app:openExternal": { request: OpenExternalRequest; response: void };
  "config:get": { request: void; response: AppConfigView };
  "config:setStation": { request: SetStationRequest; response: AppConfigView };
  "config:setDiagnostics": { request: SetDiagnosticsRequest; response: AppConfigView };
  "config:setWinlinkPassword": { request: SetPasswordRequest; response: AppConfigView };
  "profiles:save": { request: RadioProfileInput; response: AppConfigView };
  "profiles:delete": { request: ProfileIdRequest; response: AppConfigView };
  "profiles:setActive": { request: SetActiveProfileRequest; response: AppConfigView };
  /** Stores a networked radio's password in the keychain, never in config.json. */
  "profiles:setLanPassword": { request: SetLanPasswordRequest; response: AppConfigView };
  /** Runs a whole Winlink session; resolves only when it is over. */
  "pat:connect": { request: void; response: ConnectionState };
  /** Runs a whole session over the air; resolves only when it is over. */
  "pat:connectRadio": { request: ArdopConnectRequest; response: ConnectionState };
  "pat:disconnect": { request: void; response: ConnectionState };
  /** Stops transmitting NOW, without the polite handshake. See pat.abort(). */
  "pat:abort": { request: void; response: ConnectionState };
  "pat:getConnection": { request: void; response: ConnectionState };
  /** The RMS gateway list. Served from Pat's cache when offline. */
  "pat:rmsList": { request: RmsListRequest; response: RmsStation[] };
  "pat:answerPrompt": { request: AnswerPromptRequest; response: void };
  "winlink:hybridStations": { request: RefreshRequest; response: HybridNetworkView };
  "winlink:pickupStations": { request: RefreshRequest; response: PickupStationsView };
  "winlink:addPickupStation": { request: PickupStationRequest; response: PickupStationsView };
  "winlink:removePickupStation": { request: PickupStationRequest; response: PickupStationsView };
  "winlink:clearPickupStations": { request: void; response: PickupStationsView };
  "mailbox:listFolder": { request: ListFolderRequest; response: MailMessageSummary[] };
  "mailbox:getMessage": { request: GetMessageRequest; response: MailMessage | null };
  "mailbox:getCounts": { request: void; response: MailFolderCounts };
  "mailbox:markRead": { request: MarkReadRequest; response: void };
  /** Discards the cache and re-reads every folder from Pat. */
  "mailbox:rebuild": { request: void; response: void };
  "mailbox:search": { request: SearchRequest; response: MailSearchResult[] };
  "mailbox:recentContacts": { request: void; response: RecentContact[] };
  /** Moves a message to Archive. Reversible; this is what Delete means. */
  "mailbox:archive": { request: GetMessageRequest; response: void };
  /** Destroys a message. Pat has no trash -- only ever call this on Archive. */
  "mailbox:delete": { request: GetMessageRequest; response: void };
  "mailbox:saveAttachment": { request: SaveAttachmentRequest; response: SaveAttachmentResult };
  /** Moves a message between Inbox, Sent, Archive and the operator's folders. */
  "mailbox:move": { request: MoveMessageRequest; response: void };
  "folders:list": { request: void; response: UserFolder[] };
  "folders:create": { request: CreateFolderRequest; response: UserFolder };
  "folders:rename": { request: RenameFolderRequest; response: void };
  /** Deletes the folder only; its messages return to Archive. */
  "folders:delete": { request: FolderIdRequest; response: void };
  "folders:listMessages": { request: FolderIdRequest; response: MailMessageSummary[] };
  /** Shows a native popup menu; resolves with the chosen id, or null if dismissed. */
  "menu:popup": { request: PopupMenuRequest; response: string | null };
  "drafts:list": { request: void; response: DraftSummaryView[] };
  "drafts:get": { request: DraftIdRequest; response: ComposeDraft | null };
  "drafts:save": { request: SaveDraftRequest; response: void };
  "drafts:delete": { request: DraftIdRequest; response: void };
  /** Validates, posts to Pat's outbox, and discards the draft. */
  "compose:send": { request: SaveDraftRequest; response: SendResult };
  /** Takes a queued message out of the outbox and returns it as a draft. */
  "compose:editQueued": { request: EditQueuedRequest; response: ComposeDraft };
  /** One click: builds the acknowledgement and queues it, with no editing. */
  "compose:acknowledge": { request: MessageActionRequest; response: void };
  /** Opens a file picker and attaches the chosen files to a draft. */
  "compose:pickAttachment": { request: DraftIdRequest; response: PickedAttachment[] };
  /** Copies an existing message's attachments onto a draft, for forwarding. */
  "compose:carryAttachments": { request: MessageActionRequest & DraftIdRequest; response: PickedAttachment[] };
  /** Opens a draft in its own window, or focuses the window already holding it. */
  "compose:openWindow": { request: ComposeWindowInit; response: void };
  /** The draft the calling compose window opens on; null from any other window. */
  "compose:windowInit": { request: void; response: ComposeWindowInit | null };
  "compose:stash": { request: StashDraftRequest; response: void };
  /** Closes the calling compose window without keeping its draft. */
  "compose:closeWindow": { request: void; response: void };
  /** Focuses the window holding a draft. Resolves false if none does. */
  "compose:focusWindow": { request: DraftIdRequest; response: boolean };
}

export type IpcChannel = keyof IpcApi;

export const IPC_CHANNELS: readonly IpcChannel[] = [
  "pat:getStatus",
  "pat:getProcessState",
  "ardop:getProcessState",
  "rigctl:getProcessState",
  "audio:listDevices",
  "serial:listPorts",
  "serial:detectRadio",
  "serial:testPtt",
  "tuning:open",
  "tuning:close",
  "tuning:setDriveLevel",
  "tuning:transmit",
  "audio:testDevices",
  "ardop:readiness",
  "ardop:resetModem",
  "ardop:channelDecision",
  "rigctl:listModels",
  "diagnostics:run",
  "app:getInfo",
  "app:openLogs",
  "config:get",
  "config:setStation",
  "config:setDiagnostics",
  "config:setWinlinkPassword",
  "profiles:save",
  "profiles:delete",
  "profiles:setActive",
  "profiles:setLanPassword",
  "pat:connect",
  "pat:connectRadio",
  "pat:disconnect",
  "pat:abort",
  "pat:getConnection",
  "pat:rmsList",
  "pat:answerPrompt",
  "winlink:hybridStations",
  "winlink:pickupStations",
  "winlink:addPickupStation",
  "winlink:removePickupStation",
  "winlink:clearPickupStations",
  "mailbox:listFolder",
  "mailbox:getMessage",
  "mailbox:getCounts",
  "mailbox:markRead",
  "mailbox:rebuild",
  "mailbox:search",
  "mailbox:recentContacts",
  "mailbox:archive",
  "mailbox:delete",
  "mailbox:saveAttachment",
  "mailbox:move",
  "folders:list",
  "folders:create",
  "folders:rename",
  "folders:delete",
  "folders:listMessages",
  "menu:popup",
  "app:openExternal",
  "drafts:list",
  "drafts:get",
  "drafts:save",
  "drafts:delete",
  "compose:send",
  "compose:editQueued",
  "compose:acknowledge",
  "compose:pickAttachment",
  "compose:carryAttachments",
  "compose:openWindow",
  "compose:windowInit",
  "compose:stash",
  "compose:closeWindow",
  "compose:focusWindow",
];

/** Main -> renderer push events. */
export interface IpcEvents {
  "pat:stateChanged": PatProcessState;
  "ardop:stateChanged": ArdopProcessState;
  /** Pushed on every change while the session modem runs; resets when it stops. */
  "ardop:activity": ModemActivity;
  /** The pre-dial clear-channel check; ends with a phase of "done". */
  "ardop:channelCheck": ChannelCheckEvent;
  "tuning:stateChanged": TuningState;
  "rigctl:stateChanged": RigctldProcessState;
  /** Pushed after every config mutation so views update without re-fetching. */
  "config:changed": AppConfigView;
  "pat:connectionChanged": ConnectionState;
  /** Pat is waiting on the operator; the session is blocked until answered. */
  "pat:prompt": PatPrompt;
  "pat:activationPassword": ActivationPasswordEvent;
  /** The cache changed; folder counts and any affected list should refresh. */
  "mailbox:changed": MailboxChangedEvent;
  /** A draft was saved or removed; the Drafts folder should refresh. */
  "drafts:changed": DraftSummaryView[];
  /** A folder was created, renamed or deleted, or its contents changed. */
  "folders:changed": UserFolder[];
}

export type IpcEventChannel = keyof IpcEvents;

export const IPC_EVENT_CHANNELS: readonly IpcEventChannel[] = [
  "pat:stateChanged",
  "ardop:stateChanged",
  "ardop:activity",
  "ardop:channelCheck",
  "tuning:stateChanged",
  "rigctl:stateChanged",
  "config:changed",
  "pat:connectionChanged",
  "pat:prompt",
  "pat:activationPassword",
  "mailbox:changed",
  "drafts:changed",
  "folders:changed",
];

/** The API surface exposed on window.wl2go by the preload bridge. */
export interface Wl2goApi {
  pat: {
    getStatus(): Promise<PatStatus>;
    getProcessState(): Promise<PatProcessState>;
    /** Resolves when the session ends, which may be minutes. */
    connect(): Promise<ConnectionState>;
    /** Calls a station over the air. Resolves when the session ends. */
    connectRadio(input: ArdopConnectRequest): Promise<ConnectionState>;
    disconnect(): Promise<ConnectionState>;
    /**
     * Stops the transmitter immediately, abandoning the session.
     *
     * Different from disconnect() in kind, not degree: disconnect asks the
     * remote station politely and Pat keeps transmitting DISC frames for as
     * long as that takes -- fifteen seconds, in the log that prompted this.
     * abort() unkeys the radio first and asks questions afterwards.
     */
    abort(): Promise<ConnectionState>;
    getConnection(): Promise<ConnectionState>;
    /** RMS gateways to call. Works offline from Pat's cache. */
    rmsList(input: RmsListRequest): Promise<RmsStation[]>;
    answerPrompt(input: AnswerPromptRequest): Promise<void>;
  };
  /**
   * The hybrid network, through Winlink's CMS. Every read serves the last copy
   * seen when the internet is down; every change needs the internet.
   */
  winlink: {
    hybridStations(input: RefreshRequest): Promise<HybridNetworkView>;
    pickupStations(input: RefreshRequest): Promise<PickupStationsView>;
    /** Rejects with a message fit to show: offline, no password, or refused. */
    addPickupStation(input: PickupStationRequest): Promise<PickupStationsView>;
    /** Clears and re-adds the rest, since the CMS has no single delete. */
    removePickupStation(input: PickupStationRequest): Promise<PickupStationsView>;
    clearPickupStations(): Promise<PickupStationsView>;
  };
  ardop: {
    getProcessState(): Promise<ArdopProcessState>;
    /** Whether the active profile could hold a session. Spawns nothing. */
    readiness(): Promise<RadioReadinessView>;
    /** Force-kills a wedged modem so the next connect can start one. */
    resetModem(): Promise<ResetModemResult>;
    /** Answers the clear-channel hold dialog. No-op when no check is running. */
    channelDecision(input: ChannelDecisionRequest): Promise<void>;
  };
  rigctl: {
    getProcessState(): Promise<RigctldProcessState>;
    /** The radio models this build of Hamlib can drive. */
    listModels(): Promise<RigModel[]>;
  };
  audio: {
    listDevices(): Promise<AudioDevice[]>;
    testDevices(input: TestAudioDevicesRequest): Promise<AudioDeviceTestResult>;
  };
  tuning: {
    /** Starts the tuning modem with the DRAFT's devices and keying. */
    open(input: TuningOpenRequest): Promise<TuningState>;
    close(): Promise<TuningState>;
    setDriveLevel(input: SetDriveLevelRequest): Promise<TuningState>;
    /** Puts a signal on the air. Ask the operator first. */
    transmit(input: TuningTransmitRequest): Promise<TuningState>;
  };
  serial: {
    listPorts(): Promise<SerialPortInfo[]>;
    /** Finds the radio's port, speed and CI-V address. Takes a few seconds. */
    detectRadio(): Promise<DetectRadioResult>;
    /** Keys the transmitter briefly. Confirm with the operator before calling. */
    testPtt(input: TestPttRequest): Promise<PttTestResult>;
  };
  diagnostics: {
    run(): Promise<DiagnosticsReport>;
  };
  app: {
    getInfo(): Promise<AppInfo>;
    /** Reveals the log directory in the OS file manager. */
    openLogs(): Promise<void>;
    /** Opens a link outside WL2GO. Refused for anything but http/https. */
    openExternal(input: OpenExternalRequest): Promise<void>;
  };
  config: {
    get(): Promise<AppConfigView>;
    setStation(input: SetStationRequest): Promise<AppConfigView>;
    /** Applies from the next session; the running modem's flags are set. */
    setDiagnostics(input: SetDiagnosticsRequest): Promise<AppConfigView>;
    /** Pass an empty string to clear the stored password. */
    setWinlinkPassword(input: SetPasswordRequest): Promise<AppConfigView>;
  };
  profiles: {
    /** Omit the id to create a profile; supply it to update one. */
    save(input: RadioProfileInput): Promise<AppConfigView>;
    delete(input: ProfileIdRequest): Promise<AppConfigView>;
    setActive(input: SetActiveProfileRequest): Promise<AppConfigView>;
    /** Pass an empty string to clear the stored password. */
    setLanPassword(input: SetLanPasswordRequest): Promise<AppConfigView>;
  };
  mailbox: {
    /** Served from the local cache, so this does not wait on Pat. */
    listFolder(input: ListFolderRequest): Promise<MailMessageSummary[]>;
    /** Fetches the body from Pat on first open, then serves it from the cache. */
    getMessage(input: GetMessageRequest): Promise<MailMessage | null>;
    getCounts(): Promise<MailFolderCounts>;
    markRead(input: MarkReadRequest): Promise<void>;
    rebuild(): Promise<void>;
    /** Full-text search across every folder, served from the cache. */
    search(input: SearchRequest): Promise<MailSearchResult[]>;
    /** Everyone the operator has sent to or heard from, newest first. Cache only. */
    recentContacts(): Promise<RecentContact[]>;
    /** Moves a message to Archive. This is what the Delete action does. */
    archive(input: GetMessageRequest): Promise<void>;
    /** Destroys a message. Confirm with the operator first -- there is no undo. */
    delete(input: GetMessageRequest): Promise<void>;
    saveAttachment(input: SaveAttachmentRequest): Promise<SaveAttachmentResult>;
    /** Moves a message. Filing into a folder archives it first. */
    move(input: MoveMessageRequest): Promise<void>;
  };
  folders: {
    list(): Promise<UserFolder[]>;
    /** Rejects with a message fit to show when the name is empty or taken. */
    create(input: CreateFolderRequest): Promise<UserFolder>;
    rename(input: RenameFolderRequest): Promise<void>;
    /** Never deletes mail: the folder's messages return to Archive. */
    delete(input: FolderIdRequest): Promise<void>;
    listMessages(input: FolderIdRequest): Promise<MailMessageSummary[]>;
  };
  menu: {
    popup(input: PopupMenuRequest): Promise<string | null>;
  };
  drafts: {
    list(): Promise<DraftSummaryView[]>;
    get(input: DraftIdRequest): Promise<ComposeDraft | null>;
    save(input: SaveDraftRequest): Promise<void>;
    delete(input: DraftIdRequest): Promise<void>;
  };
  compose: {
    /** Resolves with sent:false and the reasons when the draft is not valid. */
    send(input: SaveDraftRequest): Promise<SendResult>;
    /**
     * Pulls a queued message back into Drafts for editing; it leaves the
     * outbox, so it goes out only when sent again. Refused during a session.
     */
    editQueued(input: EditQueuedRequest): Promise<ComposeDraft>;
    /** Queues an acknowledgement for a message. Never opens for editing. */
    acknowledge(input: MessageActionRequest): Promise<void>;
    pickAttachment(input: DraftIdRequest): Promise<PickedAttachment[]>;
    carryAttachments(input: MessageActionRequest & DraftIdRequest): Promise<PickedAttachment[]>;
    openWindow(input: ComposeWindowInit): Promise<void>;
    windowInit(): Promise<ComposeWindowInit | null>;
    stash(input: StashDraftRequest): Promise<void>;
    closeWindow(): Promise<void>;
    focusWindow(input: DraftIdRequest): Promise<boolean>;
  };
  /** Subscribe to a push event. Returns an unsubscribe function. */
  on<K extends IpcEventChannel>(channel: K, listener: (payload: IpcEvents[K]) => void): () => void;
}
