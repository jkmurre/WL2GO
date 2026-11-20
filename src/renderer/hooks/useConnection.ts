import { useCallback, useEffect, useState } from "react";
import type {
  ActivationPasswordEvent,
  ChannelCheckEvent,
  ChannelHoldDecision,
  ConnectionState,
  PatPrompt,
} from "../../shared/ipcContract.ts";
import { isTerminalStage } from "../../shared/sessionStage.ts";

export interface UseConnectionResult {
  state: ConnectionState | null;
  /** Pat is blocked until this is answered. */
  prompt: PatPrompt | null;
  /** The pre-dial clear-channel check; null when none is running. */
  channelCheck: ChannelCheckEvent | null;
  /** A Winlink-assigned password Pat printed; shown until dismissed. */
  activationPassword: ActivationPasswordEvent | null;
  connect: () => void;
  /** Calls a station over the air. Like connect, this resolves only at the end. */
  connectRadio: (target: string, bandwidth?: string | null, dialKhz?: number | null, radioOnly?: boolean) => void;
  disconnect: () => void;
  /** Stops the transmitter now, without waiting for the remote station. */
  abort: () => void;
  answerPrompt: (value: string) => void;
  /** Dismisses the prompt and aborts the session it was blocking. */
  cancelPrompt: () => void;
  /** Answers the clear-channel hold dialog. */
  channelDecision: (decision: ChannelHoldDecision) => void;
  dismissActivationPassword: () => void;
}

/**
 * The live Winlink session.
 *
 * `pat:connect` does not resolve until the session is over -- it can run for
 * minutes -- so nothing here awaits it for state. Progress arrives on
 * `pat:connectionChanged`, pushed from Pat's event stream.
 */
export function useConnection(): UseConnectionResult {
  const [state, setState] = useState<ConnectionState | null>(null);
  const [prompt, setPrompt] = useState<PatPrompt | null>(null);
  const [channelCheck, setChannelCheck] = useState<ChannelCheckEvent | null>(null);
  const [activationPassword, setActivationPassword] = useState<ActivationPasswordEvent | null>(null);

  useEffect(() => {
    let mounted = true;

    window.wl2go.pat
      .getConnection()
      .then((initial) => {
        if (mounted) setState(initial);
      })
      .catch(() => {
        /* main pushes an update once it knows more */
      });

    const offState = window.wl2go.on("pat:connectionChanged", (next) => {
      if (!mounted) return;
      setState(next);
      // Belt and braces: the check itself pushes "done", but a session that
      // ends abruptly must not leave a stale hold behind.
      if (isTerminalStage(next.stage)) setChannelCheck(null);
    });
    const offPrompt = window.wl2go.on("pat:prompt", (next) => {
      if (mounted) setPrompt(next);
    });
    const offChannelCheck = window.wl2go.on("ardop:channelCheck", (next) => {
      if (mounted) setChannelCheck(next.phase === "done" ? null : next);
    });
    const offPassword = window.wl2go.on("pat:activationPassword", (next) => {
      if (mounted) setActivationPassword(next);
    });

    return () => {
      mounted = false;
      offState();
      offPrompt();
      offChannelCheck();
      offPassword();
    };
  }, []);

  const connect = useCallback(() => {
    // Not awaited: this promise settles only when the session ends. The button
    // follows the pushed state instead.
    void window.wl2go.pat.connect().catch((err: unknown) => {
      setState((current) =>
        current
          ? { ...current, stage: "failed", error: err instanceof Error ? err.message : String(err) }
          : current,
      );
    });
  }, []);

  const connectRadio = useCallback(
    (
      target: string,
      bandwidth: string | null = null,
      dialKhz: number | null = null,
      radioOnly = false,
    ) => {
    // Not awaited, for the same reason as connect: an RF session can run for
    // many minutes and the UI follows the pushed stage instead.
    void window.wl2go.pat.connectRadio({ target, bandwidth, dialKhz, radioOnly }).catch((err: unknown) => {
      setState((current) =>
        current
          ? { ...current, stage: "failed", error: err instanceof Error ? err.message : String(err) }
          : current,
      );
    });
    },
    [],
  );

  const disconnect = useCallback(() => {
    void window.wl2go.pat.disconnect().catch(() => {
      /* the session ends on its own; a failed abort changes nothing here */
    });
  }, []);

  const abort = useCallback(() => {
    // Swallowing the rejection is right here and only here. The main process
    // already logs a partial abort and reports it through the connection state;
    // what must not happen is the click appearing to do nothing because an IPC
    // call rejected after it had already unkeyed the radio.
    void window.wl2go.pat.abort().catch(() => {});
  }, []);

  const answerPrompt = useCallback(
    (value: string) => {
      if (!prompt) return;
      void window.wl2go.pat.answerPrompt({ id: prompt.id, value });
      setPrompt(null);
    },
    [prompt],
  );

  const cancelPrompt = useCallback(() => {
    // Deliberately does not answer: Pat would treat an empty password as an
    // answer and attempt the login anyway. Aborting is what "cancel" means.
    setPrompt(null);
    void window.wl2go.pat.disconnect().catch(() => {
      /* the session ends on its own regardless */
    });
  }, []);

  const channelDecision = useCallback((decision: ChannelHoldDecision) => {
    // Fire and forget, like abort: main treats a stale decision as a no-op,
    // and the hold state follows the pushed events either way.
    void window.wl2go.ardop.channelDecision({ decision }).catch(() => {});
  }, []);

  const dismissActivationPassword = useCallback(() => setActivationPassword(null), []);

  return {
    state,
    prompt,
    channelCheck,
    activationPassword,
    connect,
    connectRadio,
    disconnect,
    abort,
    answerPrompt,
    cancelPrompt,
    channelDecision,
    dismissActivationPassword,
  };
}
