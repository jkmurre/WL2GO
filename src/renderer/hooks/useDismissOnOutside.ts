import { useEffect, type RefObject } from "react";

/**
 * Closes an open menu on a click anywhere else, or on Escape.
 *
 * Extracted from the toolbar's Connect split button so the reading pane's
 * action menu behaves identically rather than growing a second, subtly
 * different copy of the same effect. Both menus are transient overlays over
 * the same chrome; an operator should not have to learn which one dismisses
 * how.
 *
 * `mousedown` rather than `click`: a click that starts inside the menu and
 * ends outside it (a drag over a menu item, which happens on a trackpad more
 * often than it sounds) should not count as dismissing it.
 */
export function useDismissOnOutside(
  open: boolean,
  wrapper: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onDocumentClick = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) close();
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onDocumentClick);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open, wrapper, close]);
}
