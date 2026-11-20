import { useState } from "react";
import type {
  ActivationPasswordEvent,
  ChannelHoldDecision,
  PatPrompt,
} from "../../../shared/ipcContract.ts";

export interface PromptDialogProps {
  prompt: PatPrompt;
  onAnswer: (value: string) => void;
  /** Aborts the session. See the note on the password branch below. */
  onCancel: () => void;
}

/** Human-readable framing for each thing Pat can stop and ask about. */
function promptTitle(kind: PatPrompt["kind"]): string {
  switch (kind) {
    case "password":
      return "Winlink password required";
    case "pre-account-activation":
      return "Confirm your Winlink account";
    case "account-activation":
      return "Winlink account activation";
    case "busy-channel":
      return "The channel is busy";
    case "multi-select":
      return "Choose an option";
  }
}

/**
 * Pat's session is blocked until this is answered.
 *
 * Not dismissable by clicking away for that reason: ignoring it does not make
 * it go away, it makes the connection time out with no explanation.
 */
export function PromptDialog({ prompt, onAnswer, onCancel }: PromptDialogProps) {
  const [value, setValue] = useState("");

  const isPassword = prompt.kind === "password";
  const isChoice = prompt.kind === "pre-account-activation" || prompt.kind === "busy-channel";

  return (
    <div className="modal" role="alertdialog" aria-label={promptTitle(prompt.kind)}>
      <div className="modal__card">
        <h2 className="modal__title">{promptTitle(prompt.kind)}</h2>
        <p className="modal__detail">{prompt.message || "Winlink is waiting for a response."}</p>

        {isPassword ? (
          <>
            <div className="field">
              <label className="field__label" htmlFor="prompt-password">
                Winlink password
              </label>
              <input
                id="prompt-password"
                className="field__input"
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoFocus
                autoComplete="off"
              />
              <div className="field__help">
                Save it in Settings afterwards and you will not be asked again.
              </div>
            </div>
            <div className="modal__actions">
              {/* Aborts the session rather than answering. Pat hands whatever it
                  is given straight to the CMS as the password, so sending "" here
                  would attempt a login with an empty password rather than stop. */}
              <button type="button" className="btn" onClick={onCancel}>
                Cancel session
              </button>
              <button type="button" className="btn btn--primary" onClick={() => onAnswer(value)} disabled={!value}>
                Continue
              </button>
            </div>
          </>
        ) : isChoice ? (
          <div className="modal__actions">
            {/* Here an empty value is a real answer: Pat checks for the literal
                "confirmed", so anything else declines. */}
            <button type="button" className="btn" onClick={() => onAnswer("")}>
              No, stop
            </button>
            <button type="button" className="btn btn--primary" onClick={() => onAnswer("confirmed")}>
              Yes, continue
            </button>
          </div>
        ) : (
          <>
            {prompt.options?.length ? (
              <div className="field">
                <label className="field__label" htmlFor="prompt-choice">
                  Options
                </label>
                <select
                  id="prompt-choice"
                  className="field__input"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                >
                  <option value="">Select…</option>
                  {prompt.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.desc || option.value}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="field">
                <label className="field__label" htmlFor="prompt-value">
                  Response
                </label>
                <input
                  id="prompt-value"
                  className="field__input"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoFocus
                />
              </div>
            )}
            <div className="modal__actions">
              <button type="button" className="btn" onClick={() => onAnswer("")}>
                Cancel
              </button>
              <button type="button" className="btn btn--primary" onClick={() => onAnswer(value)}>
                Send
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export interface ChannelHoldDialogProps {
  onDecide: (decision: ChannelHoldDecision) => void;
}

/**
 * The pre-dial channel check heard a signal, and the call is on hold.
 *
 * Shown once per session, on the first hold: after "Keep waiting" the amber TX
 * light and the status line carry the state, and a marginal signal fluttering
 * in and out does not re-prompt on every flutter. Like PromptDialog, not
 * dismissable by clicking away -- the call is blocked until this is answered.
 *
 * "Keep waiting" is the primary action on purpose. Forcing a transmission onto
 * a channel someone else is using should never be the button a reflexive Enter
 * press lands on.
 */
export function ChannelHoldDialog({ onDecide }: ChannelHoldDialogProps) {
  return (
    <div className="modal" role="alertdialog" aria-label="The frequency is in use">
      <div className="modal__card">
        <h2 className="modal__title">The frequency is in use</h2>
        <p className="modal__detail">
          Another signal was heard on this frequency. WL2GO is holding your transmission until the
          channel has been clear for 10 seconds.
        </p>
        <div className="modal__actions">
          <button type="button" className="btn" onClick={() => onDecide("abort")}>
            Cancel the call
          </button>
          <button type="button" className="btn" onClick={() => onDecide("force")}>
            Transmit anyway
          </button>
          <button type="button" className="btn btn--primary" autoFocus onClick={() => onDecide("wait")}>
            Keep waiting
          </button>
        </div>
      </div>
    </div>
  );
}

export interface ActivationPasswordDialogProps {
  event: ActivationPasswordEvent;
  onDismiss: () => void;
}

/**
 * Winlink assigned an account password, and this is the only time it is shown.
 *
 * Pat prints it and never stores it; without this the operator would never see
 * it and every later connection would fail. Deliberately loud, and deliberately
 * shows the value even when it was stored successfully -- Winlink's own advice
 * is to write it down.
 */
export function ActivationPasswordDialog({ event, onDismiss }: ActivationPasswordDialogProps) {
  return (
    <div className="modal" role="alertdialog" aria-label="Your new Winlink password">
      <div className="modal__card">
        <h2 className="modal__title">Winlink has issued your account password</h2>
        <p className="modal__detail">
          This is shown once. Write it down and keep it somewhere safe — Winlink will ask for it on
          every future connection.
        </p>

        <div className="modal__secret" aria-label="Your Winlink password">
          {event.password}
        </div>

        <p className="modal__detail">
          {event.stored
            ? "WL2GO has saved it to your system keychain, so you will not normally be asked for it."
            : "WL2GO could NOT save it to your keychain. You must write it down now — it is not stored anywhere."}
        </p>

        <div className="modal__actions">
          <button type="button" className="btn btn--primary" onClick={onDismiss}>
            I have written it down
          </button>
        </div>
      </div>
    </div>
  );
}
