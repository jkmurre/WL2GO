import { useCallback, useRef, useState } from "react";
import type { ConnectionState, RadioReadinessView } from "../../shared/ipcContract.ts";
import { isSessionBusy } from "../../shared/sessionStage.ts";
import { useDismissOnOutside } from "../hooks/useDismissOnOutside.ts";

export type AppView = "mailbox" | "diagnostics" | "settings";

export interface ToolbarProps {
  view: AppView;
  onViewChange: (view: AppView) => void;
  connection: ConnectionState | null;
  /** Telnet, over the internet. The default and the primary action. */
  onConnect: () => void;
  /** Opens the station browser; it does NOT dial. */
  onConnectRadio: () => void;
  /** Opens the direct-call dialog (callsign + frequency); it does NOT dial. */
  onConnectDirect: () => void;
  onDisconnect: () => void;
  /** Stops the transmitter immediately. See the button below. */
  onAbort: () => void;
  onNewMessage: () => void;
  /** Null while unknown; drives whether the radio entry is selectable. */
  radio: RadioReadinessView | null;
  /** RF sessions go out Radio-Only. Said on the radio entries so it is never a surprise. */
  radioOnly: boolean;
}

/**
 * Buttons whose feature has not landed yet are rendered disabled and say which
 * module enables them, rather than being hidden or faked. That keeps the shell
 * honest about what actually works while the chrome itself is final.
 */
export function Toolbar({
  view,
  onViewChange,
  connection,
  onConnect,
  onConnectRadio,
  onConnectDirect,
  onDisconnect,
  onAbort,
  onNewMessage,
  radio,
  radioOnly,
}: ToolbarProps) {
  // Shared with the StatusBar rather than re-derived: both used to switch over
  // the session state for themselves, and the RF stages would have made those
  // two definitions disagree.
  const busy = isSessionBusy(connection ?? null);

  // Connecting before the event stream is attached would hang: Pat asks about
  // the account before it parses the transport, and with nothing answering that
  // prompt the session blocks for its full two-minute timeout.
  const attached = connection?.eventsAttached === true;
  const connectTitle = busy
    ? "Stop the current Winlink session"
    : attached
      ? "Connect to Winlink over the internet (Telnet)"
      : "Waiting for the protocol engine…";

  return (
    <header className="toolbar">
      <div className="toolbar__brand">
        <span className="toolbar__brand-name">WL2GO</span>
      </div>

      {busy ? (
        <>
          {/* btn--collapsible: below the narrow breakpoint these shed their
              text and keep the glyph; the title carries the name. See the
              responsive section of global.css. */}
          <button
            type="button"
            className="btn btn--primary btn--collapsible"
            onClick={onDisconnect}
            title={connectTitle}
          >
            <span className="btn__glyph" aria-hidden="true">
              ◼
            </span>
            <span className="btn__label">Disconnect</span>
          </button>
          {/*
            A SEPARATE control from Disconnect, not a louder version of it.
            Disconnect is polite: Pat asks the remote station and keeps
            transmitting DISC frames until it answers or gives up, which was
            fifteen seconds in the log that prompted this. This one unkeys the
            radio first and abandons the session. An operator who needs the
            transmitter off -- interference, a stuck PTT, someone calling on the
            frequency -- has no time for a handshake.
          */}
          <button
            type="button"
            className="btn btn--danger btn--collapsible"
            onClick={onAbort}
            title="Stop transmitting immediately and abandon the session"
          >
            <span className="btn__glyph" aria-hidden="true">
              ⨯
            </span>
            <span className="btn__label">Stop transmitting</span>
          </button>
        </>
      ) : (
        <ConnectSplitButton
          disabled={!attached}
          title={connectTitle}
          onConnect={onConnect}
          onConnectRadio={onConnectRadio}
          onConnectDirect={onConnectDirect}
          radio={radio}
          radioOnly={radioOnly}
        />
      )}
      {/* Connect already exchanges in both directions -- Pat sends whatever is
          in the outbox during the same session -- so a separate Send/Receive
          button would be a second name for the same action. */}
      <button type="button" className="btn btn--collapsible" onClick={onNewMessage} title="Write a new message">
        <span className="btn__glyph" aria-hidden="true">
          ✎
        </span>
        <span className="btn__label">New Message</span>
      </button>

      <div className="toolbar__spacer" />

      <button
        type="button"
        className={`btn${view === "mailbox" ? " btn--active" : ""}`}
        onClick={() => onViewChange("mailbox")}
      >
        Mailbox
      </button>
      <button
        type="button"
        className={`btn${view === "diagnostics" ? " btn--active" : ""}`}
        onClick={() => onViewChange("diagnostics")}
      >
        System Check
      </button>
      <button
        type="button"
        className={`btn${view === "settings" ? " btn--active" : ""}`}
        onClick={() => onViewChange("settings")}
        title="Settings"
        aria-label="Settings"
      >
        <span className="btn__glyph" aria-hidden="true">
          ⚙
        </span>
      </button>
    </header>
  );
}

/**
 * Connect, with a dropdown for where to connect TO.
 *
 * Telnet stays the primary action because it is the one that always works and
 * needs no decisions. The radio is an alternative rather than a mode: there is
 * deliberately no new "enabled" flag on a profile -- being the active profile
 * already carries that -- and the entry is greyed with the REASON when the
 * saved devices do not resolve, using the same resolver the modem itself uses.
 *
 * Choosing the radio opens the station browser rather than dialling. An RF
 * session needs a station and a frequency, and neither has a default worth
 * guessing.
 */
function ConnectSplitButton({
  disabled,
  title,
  onConnect,
  onConnectRadio,
  onConnectDirect,
  radio,
  radioOnly,
}: {
  disabled: boolean;
  title: string;
  onConnect: () => void;
  onConnectRadio: () => void;
  onConnectDirect: () => void;
  radio: RadioReadinessView | null;
  radioOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  // Closes on a click anywhere else, which is what every other menu does --
  // shared with the reading pane's action menu so the two cannot diverge.
  useDismissOnOutside(open, wrapper, useCallback(() => setOpen(false), []));

  const radioLabel = radio?.profileName ?? "No radio profile";
  const radioReady = radio?.ok === true;
  const radioOnlyNote = radioOnly ? " · Radio-Only" : "";

  return (
    <div className="split-button" ref={wrapper}>
      <button
        type="button"
        className="btn btn--primary btn--collapsible"
        onClick={onConnect}
        disabled={disabled}
        title={title}
      >
        <span className="btn__glyph" aria-hidden="true">
          ⇄
        </span>
        <span className="btn__label">Connect</span>
      </button>
      <button
        type="button"
        className="btn btn--primary split-button__toggle"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Choose how to connect"
        title="Choose how to connect"
      >
        ▾
      </button>

      {open ? (
        <div className="split-button__menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="split-button__item"
            onClick={() => {
              setOpen(false);
              onConnect();
            }}
          >
            <span className="split-button__item-name">Telnet (internet)</span>
            <span className="split-button__item-note">Always available when you are online</span>
          </button>

          <button
            type="button"
            role="menuitem"
            className="split-button__item"
            disabled={!radioReady}
            onClick={() => {
              setOpen(false);
              onConnectRadio();
            }}
            // The REASON, not just a disabled control. A greyed entry that does
            // not say why is the worst of both.
            title={radio?.reason ?? "Choose a station to call over the air"}
          >
            <span className="split-button__item-name">{radioLabel}</span>
            <span className="split-button__item-note">
              {radioReady ? `Pick a station to call over the air${radioOnlyNote}` : (radio?.reason ?? "Checking…")}
            </span>
          </button>

          {/* Same readiness gate as the station browser: the dialog only
              changes WHERE the callsign and frequency come from, not what a
              radio session needs to run. */}
          <button
            type="button"
            role="menuitem"
            className="split-button__item"
            disabled={!radioReady}
            onClick={() => {
              setOpen(false);
              onConnectDirect();
            }}
            title={radio?.reason ?? "Call a station by callsign and frequency"}
          >
            <span className="split-button__item-name">Call a station directly…</span>
            <span className="split-button__item-note">
              {radioReady
                ? `Peer-to-peer or any station not in the list${radioOnlyNote}`
                : (radio?.reason ?? "Checking…")}
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
