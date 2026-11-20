import type { CheckStatus } from "../../shared/ipcContract.ts";

/**
 * "idle" is a steady, unremarkable state (nothing configured yet) as opposed to
 * "pending", which animates because something is actively in progress.
 */
export type DotStatus = CheckStatus | "idle";

export function StatusDot({ status, title }: { status: DotStatus; title?: string }) {
  return <span className={`dot dot--${status}`} title={title} role="presentation" />;
}
