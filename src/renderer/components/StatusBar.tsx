import type {
  AppInfo,
  ChannelCheckEvent,
  CheckStatus,
  ConnectionState,
  ModemActivity,
  PatProcessState,
  PatStatus,
} from "../../shared/ipcContract.ts";
import { describeStage } from "../../shared/sessionStage.ts";
import { StatusDot, type DotStatus } from "./StatusDot.tsx";

export interface StatusBarProps {
  patState: PatProcessState | null;
  patStatus: PatStatus | null;
  appInfo: AppInfo | null;
  callsign: string;
  /** Null until the operator has created a radio profile (Module 1). */
  activeProfileName: string | null;
  connection: ConnectionState | null;
  /** Live TX/RX lights; { transmitting: false, rx: "idle" } when no modem runs. */
  activity: ModemActivity;
  /** The pre-dial clear-channel check; null when none is running. */
  channelCheck: ChannelCheckEvent | null;
  /** RF sessions go out Radio-Only. Shown for as long as it is on. */
  radioOnly: boolean;
}

function engineStatus(state: PatProcessState | null): { status: CheckStatus; label: string } {
  if (!state) return { status: "pending", label: "Engine starting" };
  switch (state.state) {
    case "running":
      return { status: "pass", label: "Engine ready" };
    case "starting":
    case "idle":
      return { status: "pending", label: "Engine starting" };
    case "stopped":
      return { status: "warn", label: "Engine stopped" };
    case "failed":
      return { status: "fail", label: "Engine failed" };
  }
}

/**
 * The operator's permanent at-a-glance health strip. Every subsystem that can
 * fail during an on-air session reports here, so later modules add indicators
 * rather than replacing this.
 */
/** The RX light: yellow while decoding, then how the last frame ended. */
const RX_DOT: Record<ModemActivity["rx"], { status: DotStatus; title: string }> = {
  idle: { status: "idle", title: "RX: nothing heard yet" },
  receiving: { status: "warn", title: "RX: signal detected, decoding" },
  good: { status: "pass", title: "RX: last frame decoded" },
  bad: { status: "fail", title: "RX: last frame failed to decode" },
};

export function StatusBar({
  patState,
  patStatus,
  appInfo,
  callsign,
  activeProfileName,
  connection,
  activity,
  channelCheck,
  radioOnly,
}: StatusBarProps) {
  const engine = engineStatus(patState);
  const rx = RX_DOT[activity.rx];

  // The TX light is three-valued: red while the radio is keyed, amber while a
  // call is on hold because the frequency is in use, green otherwise. The hold
  // comes from the channel-check events, not from ModemActivity -- the two ride
  // different feeds (host socket vs console) and merging them would invent an
  // ordering neither has.
  const txHolding = !activity.transmitting && channelCheck?.phase === "holding";
  const tx: { status: DotStatus; title: string } = activity.transmitting
    ? { status: "fail", title: "TX: transmitting" }
    : txHolding
      ? { status: "warn", title: "TX: on hold — the frequency is in use" }
      : { status: "pass", title: "TX: not transmitting" };

  // The session's own view wins over Pat's polled status: it knows about
  // failures, about progress, and about the RF stages before a link exists,
  // none of which /api/status reports.
  //
  // The wording and the dot come from shared/sessionStage.ts rather than from a
  // switch here. This component and the Toolbar each used to derive "what is
  // the session doing" for themselves, which was two definitions that happened
  // to agree; adding the RF stages would have made it two that did not.
  const session = describeStage(connection);

  // Pat's polled status still has one thing to add: who we are connected to,
  // which the session state does not carry.
  const remote = patStatus?.connected && patStatus.remote_addr ? ` to ${patStatus.remote_addr}` : "";
  const link: { status: DotStatus; label: string } = {
    status: session.tone,
    label: session.label === "Connected" ? `Connected${remote}` : session.label,
  };

  return (
    <footer className="statusbar">
      <span className="statusbar__item" title={patState?.lastError ?? undefined}>
        <StatusDot status={engine.status} />
        {engine.label}
      </span>

      <span className="statusbar__item" title={connection?.error ?? undefined}>
        <StatusDot status={link.status} />
        {link.label}
      </span>

      {/* --optional: shed below the narrow breakpoint; the session line, the
          lights and the callsign always stay. See global.css. */}
      <span
        className="statusbar__item statusbar__item--optional"
        title={activeProfileName ? `Active radio profile: ${activeProfileName}` : "Add a radio profile in Settings"}
      >
        <StatusDot status={activeProfileName ? "pass" : "idle"} />
        {activeProfileName ?? "No radio profile"}
      </span>

      <span className="statusbar__spacer" />

      {/* The on-air lights. TX is red exactly while the radio is keyed, amber
          while a call is held for a busy frequency; RX reads yellow ->
          green/red as each received frame is decoded, and holds the outcome so
          a failure is still visible after the fact. */}
      <span className="statusbar__item statusbar__light" title={tx.title}>
        <StatusDot status={tx.status} />
        TX
      </span>

      <span className="statusbar__item statusbar__light" title={rx.title}>
        <StatusDot status={rx.status} />
        RX
      </span>

      {/* Remembered across sessions on purpose, so it has to be impossible to
          forget it is on: a normal session dialled Radio-Only is refused. */}
      {radioOnly ? (
        <span
          className="statusbar__item statusbar__pill"
          title="Radio sessions use Winlink's hybrid network. Turn this off in the station browser."
        >
          Radio-Only
        </span>
      ) : null}

      <span className="statusbar__item statusbar__callsign" title="Your callsign, set in Settings">
        {callsign}
      </span>

      {appInfo ? <span className="statusbar__item statusbar__item--optional">v{appInfo.appVersion}</span> : null}
    </footer>
  );
}
