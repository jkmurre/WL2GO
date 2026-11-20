import { useState } from "react";
import type { AppConfigView } from "../../../shared/ipcContract.ts";
import {
  isValidCallsign,
  isValidGridSquare,
  normaliseCallsign,
  normaliseGridSquare,
  type RadioProfileInput,
} from "../../../shared/configSchema.ts";
import { RadioProfileWizard } from "../settings/RadioProfileWizard.tsx";

export interface OnboardingWizardProps {
  config: AppConfigView;
  error: string | null;
  mutate: (action: () => Promise<AppConfigView>) => Promise<boolean>;
}

type Step = "welcome" | "identity" | "account" | "radio";

const STEPS: Step[] = ["welcome", "identity", "account", "radio"];

/**
 * First-run setup.
 *
 * Shown instead of the main window rather than over it: until WL2GO knows who
 * the operator is there is nothing useful behind this, and a half-configured
 * mailbox is worse than no mailbox.
 */
export function OnboardingWizard({ config, error, mutate }: OnboardingWizardProps) {
  const [step, setStep] = useState<Step>("welcome");
  const [callsign, setCallsign] = useState("");
  const [gridSquare, setGridSquare] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  // Whether the operator opened the radio wizard, rather than a fourth step that
  // drops them straight into a form they may not want.
  const [radioChosen, setRadioChosen] = useState(false);
  // Held so a retry after a failed identity write updates the profile that was
  // already created rather than making a second one.
  const [savedProfileId, setSavedProfileId] = useState<string | null>(null);

  const trimmedCall = normaliseCallsign(callsign);
  const trimmedGrid = normaliseGridSquare(gridSquare);

  const callsignError =
    trimmedCall && !isValidCallsign(trimmedCall) ? "That does not look like a callsign." : null;
  const gridError =
    trimmedGrid && !isValidGridSquare(trimmedGrid) ? "Use a locator such as FN31 or FN31pr." : null;
  const canLeaveIdentity = trimmedCall.length > 0 && !callsignError && !gridError;

  /**
   * Everything is applied in one go at the end, not step by step: each save
   * restarts the protocol engine, and doing that twice during setup would be
   * both slower and visibly odd.
   *
   * The ORDER is load-bearing, not stylistic, and it runs BACKWARDS from the
   * order the steps were shown in. App.tsx renders this wizard whenever the
   * config has no callsign, so the instant setStation lands the whole tree is
   * replaced by the main shell -- and anything still in flight finishes with
   * its errors nowhere the operator can see them. The callsign is therefore
   * written LAST, once everything else is durable, so a failure anywhere leaves
   * setup on screen with the banner explaining it.
   */
  async function finish(radio: { input: RadioProfileInput } | null): Promise<boolean> {
    setSaving(true);
    try {
      if (radio) {
        // On a retry the profile is UPDATED rather than created again: without
        // the id, a save that succeeded before an identity write failed would
        // leave a duplicate behind on the second attempt.
        const known = new Set(config.profiles.map((p) => p.id));
        const input = savedProfileId ? { ...radio.input, id: savedProfileId } : radio.input;
        if (!(await mutate(() => window.wl2go.profiles.save(input)))) return false;

        if (!savedProfileId) {
          // Found by diffing ids rather than matching the name, which is not
          // unique. No setActive call is needed: this is necessarily the first
          // profile, and the store makes the first one active by itself.
          const saved = await window.wl2go.config.get();
          setSavedProfileId(saved.profiles.find((p) => !known.has(p.id))?.id ?? null);
        }
      }

      if (password && config.secureStorageAvailable) {
        // Blocking rather than best-effort. A password that failed to store is
        // worth stopping for while the operator can still see why and clear the
        // field -- after the callsign lands, this screen is gone.
        if (!(await mutate(() => window.wl2go.config.setWinlinkPassword({ password })))) return false;
      }

      // Last, and the point of no return: this is what swaps the tree. Values
      // stay on screen if it fails, so the operator can retry rather than
      // retype.
      return await mutate(() =>
        window.wl2go.config.setStation({
          callsign: trimmedCall,
          gridSquare: trimmedGrid,
          shareWithWinlink: config.station.shareWithWinlink,
        }),
      );
    } finally {
      setSaving(false);
    }
  }

  const stepIndex = STEPS.indexOf(step);

  return (
    <div className="onboarding">
      <div className="onboarding__card">
        <header className="onboarding__head">
          <div className="onboarding__brand">WL2GO</div>
          <ol className="onboarding__steps" aria-label="Setup progress">
            {STEPS.map((s, i) => (
              <li
                key={s}
                className={`onboarding__step${i === stepIndex ? " onboarding__step--current" : ""}${
                  i < stepIndex ? " onboarding__step--done" : ""
                }`}
                aria-current={i === stepIndex ? "step" : undefined}
              />
            ))}
          </ol>
        </header>

        {error ? <div className="settings__error">{error}</div> : null}

        {step === "welcome" ? (
          <section className="onboarding__body">
            <h1 className="onboarding__title">Welcome to WL2GO</h1>
            <p className="onboarding__lead">
              Winlink email for amateur radio, with everything it needs already built in — no other
              software to install.
            </p>
            <p className="onboarding__detail">
              Setup takes a moment: WL2GO needs your callsign, and optionally your Winlink account
              password. You can change both later in Settings.
            </p>
            <div className="onboarding__actions">
              <button type="button" className="btn btn--primary" onClick={() => setStep("identity")}>
                Get started
              </button>
            </div>
          </section>
        ) : null}

        {step === "identity" ? (
          <section className="onboarding__body">
            <h1 className="onboarding__title">Your station</h1>
            <p className="onboarding__detail">
              Your callsign identifies you on Winlink. It is also the name the protocol engine runs
              under.
            </p>

            <div className="field">
              <label className="field__label" htmlFor="ob-callsign">
                Callsign
              </label>
              <input
                id="ob-callsign"
                className={`field__input${callsignError ? " field__input--invalid" : ""}`}
                value={callsign}
                onChange={(e) => setCallsign(e.target.value.toUpperCase())}
                placeholder="W1AW"
                autoFocus
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={callsignError ? true : undefined}
              />
              <div className="field__help">{callsignError ?? "Required."}</div>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="ob-grid">
                Grid square
              </label>
              <input
                id="ob-grid"
                className={`field__input${gridError ? " field__input--invalid" : ""}`}
                value={gridSquare}
                onChange={(e) => setGridSquare(e.target.value)}
                placeholder="FN31pr"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={gridError ? true : undefined}
              />
              <div className="field__help">
                {gridError ?? "Optional. Used when reporting your position to Winlink."}
              </div>
            </div>

            <div className="onboarding__actions">
              <button type="button" className="btn" onClick={() => setStep("welcome")}>
                Back
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setStep("account")}
                disabled={!canLeaveIdentity}
              >
                Continue
              </button>
            </div>
          </section>
        ) : null}

        {step === "account" ? (
          <section className="onboarding__body">
            <h1 className="onboarding__title">Winlink account</h1>
            <p className="onboarding__detail">
              Winlink gives your account a password when it is first activated, and asks for it on
              every connection after that. If you already have one, entering it here means you will
              not be asked again.
            </p>
            <p className="onboarding__detail">
              <strong>If this is a brand-new callsign, leave it blank.</strong> You do not have a
              password yet — Winlink will send you one the first time you connect, and WL2GO will
              ask for it when it is needed.
            </p>

            <div className="field">
              <label className="field__label" htmlFor="ob-password">
                Winlink password
              </label>
              <input
                id="ob-password"
                className="field__input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank if you do not have one"
                autoComplete="off"
                disabled={!config.secureStorageAvailable}
              />
              <div className="field__help">
                {config.secureStorageAvailable
                  ? "Stored in your system keychain. It is never written to a configuration file."
                  : "This system has no keychain available, so a password cannot be stored safely."}
              </div>
            </div>

            <div className="onboarding__actions">
              <button type="button" className="btn" onClick={() => setStep("identity")} disabled={saving}>
                Back
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setStep("radio")}
                disabled={saving}
              >
                Continue
              </button>
            </div>
          </section>
        ) : null}

        {step === "radio" ? (
          <section className="onboarding__body">
            {radioChosen ? (
              <RadioProfileWizard
                onSave={(input) => finish({ input })}
                onCancel={() => setRadioChosen(false)}
                saveLabel="Finish setup"
                cancelLabel="Not now"
              />
            ) : (
              <>
                <h1 className="onboarding__title">Your radio</h1>
                <p className="onboarding__detail">
                  WL2GO can already send and receive Winlink mail over the internet, with no radio at
                  all. Setting one up adds the other half: Winlink over the air, when the internet is
                  not there.
                </p>
                <p className="onboarding__detail">
                  <strong>Nothing here is permanent, and nothing is required.</strong> If your cable
                  has not arrived, or you would rather do this later, skip it — Settings has the same
                  setup whenever you want it.
                </p>

                <div className="onboarding__actions">
                  <button type="button" className="btn" onClick={() => setStep("account")} disabled={saving}>
                    Back
                  </button>
                  <div className="toolbar__spacer" />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void finish(null)}
                    disabled={saving}
                  >
                    {saving ? "Setting up…" : "Skip — I'll use the internet for now"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => setRadioChosen(true)}
                    disabled={saving}
                  >
                    Set up a radio
                  </button>
                </div>
              </>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}
