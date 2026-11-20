import { useCallback, useEffect, useState, type MouseEvent } from "react";
import type { AppInfo, DiagnosticsReport, MoveTarget, PatStatus, PopupMenuItem } from "../../shared/ipcContract.ts";
import { AppShell } from "./AppShell.tsx";
import { Toolbar, type AppView } from "../components/Toolbar.tsx";
import { FolderSidebar } from "../components/FolderSidebar.tsx";
import { MessageList } from "../components/MessageList.tsx";
import { ReadingPane } from "../components/ReadingPane.tsx";
import { StatusBar } from "../components/StatusBar.tsx";
import { SystemCheckPanel } from "../features/diagnostics/SystemCheckPanel.tsx";
import { SettingsPage } from "../features/settings/SettingsPage.tsx";
import { OnboardingWizard } from "../features/onboarding/OnboardingWizard.tsx";
import { usePatState } from "../hooks/usePatState.ts";
import { useModemActivity } from "../hooks/useModemActivity.ts";
import { useConfig } from "../hooks/useConfig.ts";
import { useConnection } from "../hooks/useConnection.ts";
import { useRadioOnly } from "../hooks/useRadioOnly.ts";
import { useRadio } from "../hooks/useRadio.ts";
import { StationBrowser } from "../features/stations/StationBrowser.tsx";
import { DirectCallDialog } from "../features/connection/DirectCallDialog.tsx";
import { useMailbox, type MailListRow, type MailSelection } from "../hooks/useMailbox.ts";
import { useFolders } from "../hooks/useFolders.ts";
import { ipcMessage } from "../hooks/useConfig.ts";
import { isSessionBusy } from "../../shared/sessionStage.ts";
import { useDrafts } from "../hooks/useDrafts.ts";
import { INLINE_COMPOSE_TITLES, useCompose } from "../hooks/useCompose.ts";
import { ComposeForm } from "../features/compose/ComposeForm.tsx";
import { ActivationPasswordDialog, ChannelHoldDialog, PromptDialog } from "../features/connection/ConnectionDialogs.tsx";
import { asMailBox, moveSubmenu, parseMoveChoice, userFolderOf, type MailFolderId } from "../features/mailbox/folders.ts";

export function App() {
  // Onboarding now vouches for the app's health on first run, so the mailbox is
  // the landing view. System Check remains one click away in the toolbar.
  const [view, setView] = useState<AppView>("mailbox");
  const [folder, setFolder] = useState<MailFolderId>("in");
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [patStatus, setPatStatus] = useState<PatStatus | null>(null);

  const patState = usePatState();
  const modemActivity = useModemActivity();
  const { config, error: configError, clearError, mutate } = useConfig();
  const connection = useConnection();
  const [radioOnly, setRadioOnly] = useRadioOnly();
  const radio = useRadio();
  const [stationsOpen, setStationsOpen] = useState(false);
  const [directCallOpen, setDirectCallOpen] = useState(false);
  // What "Reset modem" reported, shown until the next session starts.
  const [resetNote, setResetNote] = useState<string | null>(null);
  // "Keep waiting" closes the hold dialog locally: main treats "wait" as a
  // no-op and pushes nothing back, so the dismissal has to live here. Reset
  // when the check ends, so the next session's first hold prompts again.
  const [holdDismissed, setHoldDismissed] = useState(false);
  useEffect(() => {
    if (!connection.channelCheck) setHoldDismissed(false);
  }, [connection.channelCheck]);
  const mailbox = useMailbox(folder);
  const userFolders = useFolders();
  // The New Folder field, and the message to file once it exists when it was
  // opened from a Move-to menu.
  const [creatingFolder, setCreatingFolder] = useState<{ pendingMove: MailSelection | null } | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const drafts = useDrafts();
  const compose = useCompose(config?.station.callsign ?? "");

  const openFolderId = userFolderOf(folder);
  const openFolder = userFolders.folders?.find((f) => f.id === openFolderId) ?? null;

  // A folder deleted (or renamed away under another window) while open: its
  // messages went back to Archive, so that is where to look for them.
  useEffect(() => {
    if (openFolderId && userFolders.folders && !openFolder) setFolder("archive");
  }, [openFolderId, openFolder, userFolders.folders]);

  useEffect(() => {
    window.wl2go.app
      .getInfo()
      .then(setAppInfo)
      .catch(() => setAppInfo(null));
  }, []);

  // The diagnostics run already fetches Pat's live status; reuse it for the
  // status bar instead of polling the same endpoint twice.
  const handleReport = useCallback((report: DiagnosticsReport) => {
    setPatStatus(report.patStatus);
  }, []);

  // Setup is unfinished until there is a callsign: everything downstream --
  // connecting, sending, the mailbox itself -- is meaningless without one.
  // Waiting for config to load first avoids flashing the wizard at an operator
  // who is already set up.
  if (config && !config.station.callsign) {
    return <OnboardingWizard config={config} error={configError} mutate={mutate} />;
  }

  const isMailbox = view === "mailbox";
  // Sidebar badges count unread, not total: an operator acts on what they have
  // not read. Sent and Outbox never carry unread state at all, so they show
  // nothing rather than a zero.
  const folderCounts = mailbox.counts
    ? {
        in: mailbox.counts.in.unread || undefined,
        drafts: drafts.count || undefined,
        out: mailbox.counts.out.total || undefined,
        sent: undefined,
        archive: mailbox.counts.archive.unread || undefined,
      }
    : { drafts: drafts.count || undefined };

  // Drafts come from their own store, not from Pat's mailbox.
  const rows = folder === "drafts" ? drafts.rows : mailbox.rows;
  // Only for sessions that actually used the radio: a Telnet failure has
  // nothing to do with the modem and offering to reset it would mislead.
  const radioFailure =
    connection.state?.stage === "failed" && connection.state.transport === "ardop"
      ? connection.state.error
      : null;
  const activeProfile = config?.profiles.find((p) => p.id === config.activeProfileId) ?? null;

  /** Where a message is, as the Move-to menu sees it. */
  const locationOf = (box: MailFolderId): MailFolderId =>
    openFolderId && !mailbox.searching && box === "archive" ? folder : box;

  const applyMove = (target: MailSelection, choice: string | null) => {
    const move = parseMoveChoice(choice);
    if (move === "new") setCreatingFolder({ pendingMove: target });
    else if (move) void mailbox.move(target, move);
  };

  const moveDropped = (target: MailSelection, to: MoveTarget) => void mailbox.move(target, to);

  // Moving to another folder leaves an inline reply, keeping it if it was edited.
  const selectFolder = (next: MailFolderId) => {
    void compose.leaveInline();
    setFolder(next);
  };

  // Pat may be transmitting the outbox during a session, so a queued message
  // is not taken back out from under it. Main refuses too; this explains why.
  const editBlocked = isSessionBusy(connection.state)
    ? "A session is in progress. Edit the message after it ends."
    : null;

  const editQueued = async (mid: string) => {
    // The outbox row is gone once this succeeds, so it must not stay open.
    if (await compose.editQueued(mid)) mailbox.clearSelection();
  };

  const rowMenu = async (row: MailListRow, event: MouseEvent) => {
    // Without this the system Cut/Copy/Paste menu would open as well.
    event.preventDefault();
    const box = asMailBox(row.box);
    if (!box) return;
    const target: MailSelection = { box, mid: row.mid };
    const items: PopupMenuItem[] =
      box === "out"
        ? // Queued messages carry no unread state; what they need is Edit.
          [{ id: "edit", label: "Edit", enabled: editBlocked === null }, { type: "separator" }]
        : [
            row.unread ? { id: "read", label: "Mark as Read" } : { id: "unread", label: "Mark as Unread" },
            { type: "separator" },
          ];
    items.push(
      { label: "Move to", submenu: moveSubmenu(locationOf(box), userFolders.folders ?? []) },
    );
    // Delete means Archive, as in the reading pane. Permanent deletion stays
    // behind the reading pane's confirmation.
    if (box !== "archive") items.push({ type: "separator" }, { id: "delete", label: "Delete" });

    const choice = await window.wl2go.menu.popup({ items });
    if (choice === "edit") void editQueued(row.mid);
    else if (choice === "read" || choice === "unread") void mailbox.setRead(target, choice === "read");
    else if (choice === "delete") void mailbox.move(target, { box: "archive" });
    else applyMove(target, choice);
  };

  const readingPaneMove = async () => {
    const target = mailbox.selection;
    if (!target) return;
    const choice = await window.wl2go.menu.popup({
      items: moveSubmenu(locationOf(target.box), userFolders.folders ?? []),
    });
    applyMove(target, choice);
  };

  function content() {
    if (isMailbox) {
      return (
        <>
          <MessageList
            folder={folder}
            messages={rows}
            selectedMid={
              folder === "drafts" ? (compose.inline?.draft.id ?? null) : (mailbox.selection?.mid ?? null)
            }
            onSelect={(mid, from) => {
              // A draft is not a message to read; it reopens where it was left,
              // in the reading pane. The open compose is left first -- kept if
              // edited -- and only once it has been, so a failed save is not
              // then replaced by the next draft.
              if (from === "drafts") {
                if (compose.inline?.draft.id === mid) return;
                void compose.leaveInline().then((left) => {
                  if (left) void compose.openDraft(mid);
                });
              } else {
                void compose.leaveInline();
                mailbox.select(mid, from);
              }
            }}
            onRebuild={() => void mailbox.rebuild()}
            query={mailbox.query}
            onQueryChange={mailbox.setQuery}
            searching={mailbox.searching}
            searchPending={mailbox.searchPending}
            title={openFolder?.name}
            userFolder={openFolderId !== null}
            onRowContextMenu={(row, event) => void rowMenu(row, event)}
          />
          {/* Replies and forwards are written where the message was read, like
              any modern mail client. Pop out moves one into its own window. */}
          {compose.inline ? (
            <ComposeForm
              draft={compose.inline.draft}
              onChange={compose.update}
              variant="inline"
              title={INLINE_COMPOSE_TITLES[compose.inline.kind]}
              recipientsOnly={compose.inline.recipientsOnly}
              onSave={(draft) => void compose.saveAndClose(draft)}
              onSend={compose.send}
              onAttach={compose.attach}
              onDiscard={(draft) => void compose.discard(draft)}
              onPopOut={() => void compose.popOut()}
              popOutBlocked={
                compose.inline.carrying ? "The attachments are still being copied from the original." : null
              }
            />
          ) : (
            <ReadingPane
              message={mailbox.selected}
              loading={mailbox.loadingMessage}
              error={mailbox.error}
              onArchive={() => void mailbox.archive()}
              onDeletePermanently={() => void mailbox.deletePermanently()}
              onMarkUnread={() => void mailbox.markUnread()}
              onMove={() => void readingPaneMove()}
              onEdit={() => mailbox.selection && void editQueued(mailbox.selection.mid)}
              editBlocked={editBlocked}
              onSaveAttachment={(name) => void mailbox.saveAttachment(name)}
              onReply={() => mailbox.selected && compose.reply(mailbox.selected, false)}
              onReplyAll={() => mailbox.selected && compose.reply(mailbox.selected, true)}
              onForward={() => mailbox.selected && compose.forward(mailbox.selected, false)}
              onForwardUnchanged={() => mailbox.selected && compose.forward(mailbox.selected, true)}
              onAcknowledge={async () =>
                mailbox.selection
                  ? compose.acknowledge(mailbox.selection.box, mailbox.selection.mid)
                  : false
              }
            />
          )}
        </>
      );
    }
    if (view === "settings") {
      return <SettingsPage config={config} error={configError} clearError={clearError} mutate={mutate} />;
    }
    return <SystemCheckPanel appInfo={appInfo} onReport={handleReport} />;
  }

  return (
    <AppShell
      toolbar={
        <Toolbar
          view={view}
          onViewChange={setView}
          connection={connection.state}
          onConnect={connection.connect}
          // Opens the browser rather than dialling: an RF session needs a
          // station and a frequency, and neither has a sensible default.
          onConnectRadio={() => setStationsOpen(true)}
          onConnectDirect={() => setDirectCallOpen(true)}
          onDisconnect={connection.disconnect}
          onAbort={connection.abort}
          onNewMessage={compose.newMessage}
          radio={radio.readiness}
          radioOnly={radioOnly}
        />
      }
      // System Check and Settings are their own pages, so the mailbox sidebar is
      // not rendered at all there -- showing it made them look like part of the
      // Inbox.
      sidebar={
        isMailbox ? (
          <FolderSidebar
            selected={folder}
            onSelect={selectFolder}
            counts={folderCounts}
            folders={userFolders.folders}
            creating={creatingFolder !== null}
            onStartCreate={() => setCreatingFolder({ pendingMove: null })}
            onCancelCreate={() => setCreatingFolder(null)}
            onCreate={async (name) => {
              const created = await userFolders.create(name);
              const pending = creatingFolder?.pendingMove ?? null;
              setCreatingFolder(null);
              if (pending) await mailbox.move(pending, { folderId: created.id });
            }}
            onRename={userFolders.rename}
            onDelete={(id) =>
              userFolders.remove(id).catch((err: unknown) => setFolderError(ipcMessage(err)))
            }
            onDropMessage={moveDropped}
          />
        ) : undefined
      }
      content={content()}
      // Compose failures happen outside the compose form too -- an
      // acknowledgement, or a forward whose attachments could not be fetched --
      // so they need somewhere to appear that does not depend on it being open.
      banner={
        folderError ? (
          <div className="settings__error settings__error--banner">
            <span>{folderError}</span>
            <button type="button" className="btn btn--small" onClick={() => setFolderError(null)}>
              Dismiss
            </button>
          </div>
        ) : compose.error ? (
          <div className="settings__error settings__error--banner">
            <span>{compose.error}</span>
            <button type="button" className="btn btn--small" onClick={compose.clearError}>
              Dismiss
            </button>
          </div>
        ) : radioFailure ? (
          // A failed RF session gets its recovery action next to its reason,
          // rather than buried in Settings. Reset is offered for every radio
          // failure, not only the stale-port one: it is harmless when nothing
          // is wedged (it says so), and string-matching the error to decide
          // would put the fix behind a guess.
          <div className="settings__error settings__error--banner">
            <span>{resetNote ?? radioFailure}</span>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => void radio.resetModem().then(setResetNote)}
            >
              Reset modem
            </button>
          </div>
        ) : undefined
      }
      statusBar={
        <StatusBar
          patState={patState}
          patStatus={patStatus}
          appInfo={appInfo}
          callsign={config?.station.callsign || "No callsign"}
          activeProfileName={activeProfile?.name ?? null}
          connection={connection.state}
          activity={modemActivity}
          channelCheck={connection.channelCheck}
          radioOnly={radioOnly}
        />
      }
      // Both block the session until answered, so they sit above everything.
      overlay={
        <>
          {stationsOpen ? (
            <StationBrowser
              warnings={radio.readiness?.warnings ?? []}
              tunesRadio={activeProfile?.hamlib != null}
              radioOnly={radioOnly}
              onRadioOnlyChange={setRadioOnly}
              myCallsign={config?.station.callsign ?? ""}
              onClose={() => setStationsOpen(false)}
              onCall={(station) => {
                setStationsOpen(false);
                setResetNote(null);
                // The bandwidth AND the frequency go with the callsign, and
                // both are properties of the ROW rather than of the station: a
                // gateway is listed once per frequency it keeps. Dropping the
                // bandwidth dialled every station at Pat's default of 500MAX,
                // which reads as poor propagation rather than a bug; dropping
                // the frequency leaves the radio wherever it happened to be.
                connection.connectRadio(station.callsign, station.bandwidth, station.tuningKhz, radioOnly);
              }}
            />
          ) : null}
          {directCallOpen ? (
            <DirectCallDialog
              tunesRadio={activeProfile?.hamlib != null}
              myCallsign={config?.station.callsign ?? ""}
              radioOnly={radioOnly}
              onRadioOnlyChange={setRadioOnly}
              onClose={() => setDirectCallOpen(false)}
              onCall={(call) => {
                setDirectCallOpen(false);
                setResetNote(null);
                connection.connectRadio(call.target, call.bandwidth, call.dialKhz, call.radioOnly);
              }}
            />
          ) : null}
          {connection.prompt ? (
            <PromptDialog
              prompt={connection.prompt}
              onAnswer={connection.answerPrompt}
              onCancel={connection.cancelPrompt}
            />
          ) : null}
          {connection.channelCheck?.phase === "holding" &&
          connection.channelCheck.promptOperator &&
          !holdDismissed ? (
            <ChannelHoldDialog
              onDecide={(decision) => {
                setHoldDismissed(true);
                connection.channelDecision(decision);
              }}
            />
          ) : null}
          {connection.activationPassword ? (
            <ActivationPasswordDialog
              event={connection.activationPassword}
              onDismiss={connection.dismissActivationPassword}
            />
          ) : null}
        </>
      }
    />
  );
}
