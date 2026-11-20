import type { ReactNode } from "react";

export interface AppShellProps {
  toolbar: ReactNode;
  /**
   * Mailbox folder navigation. Omitted entirely by full-page views such as
   * System Check, which are not part of the mailbox and should not appear to
   * live inside a folder.
   */
  sidebar?: ReactNode;
  content: ReactNode;
  /** A message spanning the width, above the content. Errors that have no
   *  pane of their own -- a failed acknowledgement, say. */
  banner?: ReactNode;
  statusBar: ReactNode;
  /** Modal layer: prompts that block the Winlink session until answered. */
  overlay?: ReactNode;
}

/**
 * The permanent frame: toolbar across the top, content in the middle, status
 * bar along the bottom.
 */
export function AppShell({ toolbar, sidebar, content, banner, statusBar, overlay }: AppShellProps) {
  return (
    <div className="shell">
      {toolbar}
      {/* ALWAYS rendered, even when there is no banner.
          .shell is a four-row grid and auto-placement assigns rows by child
          ORDER, so a conditionally-rendered banner used to shift the body down
          a row: the banner took the 1fr row and the mailbox was squeezed into
          the status bar's, which is how one failed session covered the whole
          window in red. An empty div keeps child count and row count in step. */}
      <div className="shell__banner">{banner}</div>
      <div className={`shell__body${sidebar ? "" : " shell__body--full"}`}>
        {sidebar}
        {content}
      </div>
      {statusBar}
      {overlay}
    </div>
  );
}
