import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useDismissOnOutside } from "../hooks/useDismissOnOutside.ts";

/** One header action, rendered either as a button in the row or as a menu item. */
export interface MessageAction {
  key: string;
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  /** Destructive, and coloured as such in both presentations. */
  danger?: boolean;
}

export interface MessageActionsProps {
  /** The pane title, owned here so the row can be measured against it. */
  title: string;
  actions: MessageAction[];
}

/**
 * A pane header whose actions fold into one menu when they stop fitting.
 *
 * MEASURED, not a media query, which is a deliberate departure from the
 * progressive collapse in the responsive section of global.css. Two reasons
 * that pattern does not reach this header:
 *
 *   1. The reading pane is the third grid column, so its width is the window
 *      minus the sidebar and list columns. Eight buttons already exceed it at
 *      the shipped 1180px default, so a viewport breakpoint would have to be
 *      guessed against real font metrics on three platforms.
 *   2. Two labels change length at runtime -- Acknowledge becomes
 *      "Acknowledging…", and Delete becomes "Delete permanently" in Archive.
 *      A fixed pixel breakpoint cannot see either.
 *
 * The row stays in the DOM in both states at its intrinsic width, so the fit
 * test never depends on the answer it produced last time. That is what keeps
 * it from oscillating: the naive version collapses, observes the now-narrow
 * container, decides it fits, expands, and flaps forever at one window width.
 */
export function MessageActions({ title, actions }: MessageActionsProps) {
  const headerRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);
  useDismissOnOutside(open, wrapperRef, close);

  // No dependency array on purpose: a changing label ("Acknowledging…") is a
  // re-render with the same props, and it changes the width that matters.
  // React bails out when the state is unchanged, so re-measuring every render
  // costs a measurement, not a render loop.
  useLayoutEffect(() => {
    const header = headerRef.current;
    const row = rowRef.current;
    const titleEl = titleRef.current;
    if (!header || !row || !titleEl) return;

    const measure = () => {
      const style = getComputedStyle(header);
      const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const gap = Number.parseFloat(style.columnGap) || 0;
      // clientWidth includes padding and excludes the border, hence the one
      // subtraction. The title keeps its space in both states.
      const available = header.clientWidth - padding - titleEl.offsetWidth - gap;
      setCollapsed(row.offsetWidth > available);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  });

  return (
    <header className="pane__header" ref={headerRef}>
      {/* msg-actions__title pins it at its natural width. A shrinking title
          would report a squeezed offsetWidth while the row is overflowing,
          which inflates the space the test thinks is available and leaves the
          row expanded and clipped -- the exact state this exists to avoid. */}
      <span className="pane__title msg-actions__title" ref={titleRef}>
        {title}
      </span>
      <div className="pane__actions msg-actions" ref={wrapperRef}>
        {/* Always rendered. When collapsed it is taken out of flow and hidden,
            which also drops it out of the tab order, but it keeps its natural
            width so the next measurement is still the real one. */}
        <div
          className={collapsed ? "msg-actions__row msg-actions__row--hidden" : "msg-actions__row"}
          ref={rowRef}
          aria-hidden={collapsed || undefined}
        >
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              className={action.danger ? "btn btn--small btn--danger" : "btn btn--small"}
              onClick={action.onClick}
              disabled={action.disabled}
              title={action.title}
              tabIndex={collapsed ? -1 : undefined}
            >
              {action.label}
            </button>
          ))}
        </div>

        {collapsed ? (
          <>
            <button
              type="button"
              className="btn btn--small msg-actions__toggle"
              onClick={() => setOpen((value) => !value)}
              aria-haspopup="menu"
              aria-expanded={open}
              title="Actions for this message"
            >
              Actions ▾
            </button>

            {open ? (
              <div className="msg-actions__menu" role="menu">
                {actions.map((action) => (
                  <button
                    key={action.key}
                    type="button"
                    role="menuitem"
                    className={
                      action.danger ? "msg-actions__item msg-actions__item--danger" : "msg-actions__item"
                    }
                    onClick={() => {
                      setOpen(false);
                      action.onClick();
                    }}
                    disabled={action.disabled}
                    title={action.title}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </header>
  );
}
