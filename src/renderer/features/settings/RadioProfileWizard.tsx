import { useState } from "react";
import type { AudioDeviceTestResult } from "../../../shared/ipcContract.ts";
import {
  DEFAULT_ARDOP_HOST_PORT,
  type RadioProfileInput,
} from "../../../shared/configSchema.ts";
import {
  STEP_COPY,
  canSave,
  emptyDraft,
  nextStep,
  previousStep,
  stepAfterKindChange,
  stepIssues,
  toProfileInput,
  wizardSteps,
  type WizardDraft,
  type WizardStep,
} from "../../../shared/profileWizard.ts";
import { describeProfileInput } from "../../../shared/profileSummary.ts";
import { useDeviceLists } from "../../hooks/useDeviceLists.ts";
import { useAudioTest } from "../../hooks/useAudioTest.ts";
import { AudioDevicePicker, RescanBar, SerialPortPicker } from "./DevicePickers.tsx";
import { BusyDetField, DriveLevelField, LanFields, PttFields, RigControlFields } from "./ProfileFieldGroups.tsx";

export interface RadioProfileWizardProps {
  /** Saves the profile. Resolving false leaves the wizard open on its last step. */
  onSave: (input: RadioProfileInput, makeActive: boolean) => Promise<boolean>;
  onCancel: () => void;
  /** "Add profile" in Settings; onboarding overrides the wording and the exit. */
  saveLabel?: string;
  cancelLabel?: string;
  /**
   * Whether to offer "use this radio by default".
   *
   * False when this will be the operator's ONLY profile: the store makes the
   * first one active by itself, so a checkbox there would be a control with no
   * effect either way -- worse than absent, because it implies the alternative
   * exists.
   */
  offerMakeActive?: boolean;
}

/**
 * The guided path for building a NEW radio profile.
 *
 * Every decision about sequencing and gating lives in shared/profileWizard.ts,
 * not here: .tsx cannot be type-stripped by node:test, and Module 7's
 * [object Object] bug was exactly this kind of logic sitting where no test
 * could reach it. This file renders what that module decides.
 *
 * Editing an existing profile does NOT come through here -- RadioProfileEditor
 * is a single page over the same draft type, because changing one dropdown
 * should not cost five clicks.
 */
export function RadioProfileWizard({
  onSave,
  onCancel,
  saveLabel = "Save profile",
  cancelLabel = "Cancel",
  offerMakeActive = false,
}: RadioProfileWizardProps) {
  const [draft, setDraft] = useState<WizardDraft>(emptyDraft());
  const [step, setStep] = useState<WizardStep>("identity");
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Problems are shown once the operator tries to move on, not the moment the
  // wizard opens: "A profile needs a name" before they have typed anything
  // reads as a complaint about something they have not done yet.
  const [showIssues, setShowIssues] = useState(false);

  const devices = useDeviceLists();
  const test = useAudioTest();

  const steps = wizardSteps(draft.kind);
  // The review step answers for the whole profile, not just for itself: it is
  // the last chance to see a problem from a step that was walked past.
  const issues = step === "review" ? steps.flatMap((s) => stepIssues(draft, s)) : stepIssues(draft, step);
  const isLast = nextStep(draft, step) === null;

  function update(patch: Partial<WizardDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function goTo(next: WizardStep) {
    setShowIssues(false);
    setStep(next);
  }

  /**
   * Advancing is never blocked by a DISABLED button: a button that will not
   * move and does not say why is the worst of both. Clicking always answers.
   */
  function advance() {
    if (issues.length) {
      setShowIssues(true);
      return;
    }
    goTo(nextStep(draft, step) as WizardStep);
  }

  function changeKind(kind: "usb" | "lan") {
    // The current step may not exist in the other branch. Landing somewhere
    // real beats dropping the operator back to a name they already typed.
    setDraft((current) => ({ ...current, kind }));
    setShowIssues(false);
    setStep((current) => stepAfterKindChange(kind, current));
  }

  function changeAudio(patch: Partial<WizardDraft>) {
    // A verdict about the old devices says nothing about the new ones.
    test.reset();
    update(patch);
  }

  async function save() {
    if (!canSave(draft)) {
      setShowIssues(true);
      return;
    }
    setSaving(true);
    try {
      if (await onSave(toProfileInput(draft), draft.makeActive)) onCancel();
    } finally {
      setSaving(false);
    }
  }

  const copy = STEP_COPY[step];

  return (
    <section className="wizard" aria-label="New radio profile">
      <header className="wizard__head">
        <h3 className="wizard__heading">New radio profile</h3>
        <ol className="onboarding__steps" aria-label="Setup progress">
          {steps.map((s, i) => (
            <li
              key={s}
              className={`onboarding__step${s === step ? " onboarding__step--current" : ""}${
                i < steps.indexOf(step) ? " onboarding__step--done" : ""
              }`}
              aria-current={s === step ? "step" : undefined}
            />
          ))}
        </ol>
      </header>

      <h4 className="wizard__title">{copy.title}</h4>
      <p className="wizard__lead">{copy.lead}</p>

      {step === "identity" ? (
        <>
          <div className="field">
            <label className="field__label" htmlFor="wiz-name">
              Profile name
            </label>
            <input
              id="wiz-name"
              className="field__input"
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
              placeholder="IC-7300 in the shack"
              autoFocus
            />
            <div className="field__help">Whatever helps you recognise this setup.</div>
          </div>

          <fieldset className="field">
            <legend className="field__label">How is the radio connected?</legend>
            <div className="field__radios">
              <label className="radio">
                <input type="radio" checked={draft.kind === "usb"} onChange={() => changeKind("usb")} />
                <span>USB cable</span>
              </label>
              <label className="radio">
                <input type="radio" checked={draft.kind === "lan"} onChange={() => changeKind("lan")} />
                <span>Network (LAN)</span>
              </label>
            </div>
          </fieldset>
        </>
      ) : null}

      {step === "audio" ? (
        <>
          <RescanBar
            label="Detected devices"
            loading={devices.loading}
            error={devices.error}
            onRescan={() => void devices.rescan()}
          />
          <AudioDevicePicker
            id="wiz-audio-in"
            label="Audio input (from radio)"
            help="Where the modem listens. This is the radio's audio output."
            value={draft.audioInput}
            onChange={(audioInput) => changeAudio({ audioInput })}
            devices={devices.capture}
            direction="capture"
          />
          <AudioDevicePicker
            id="wiz-audio-out"
            label="Audio output (to radio)"
            help="Where the modem transmits. This is the radio's audio input."
            value={draft.audioOutput}
            onChange={(audioOutput) => changeAudio({ audioOutput })}
            devices={devices.playback}
            direction="playback"
          />
          {/* Both steps stay skippable on purpose: a profile for a radio that
              is not plugged in yet is legal, and the schema says so. */}
          <div className="field__help">
            Not plugged in yet? Leave these alone and come back — the profile saves either way.
          </div>
        </>
      ) : null}

      {step === "rig" ? (
        <>
          <RescanBar
            label="Detected ports"
            loading={devices.loading}
            error={devices.error}
            onRescan={() => void devices.rescan()}
          />
          <SerialPortPicker
            id="wiz-serial"
            label="Serial port"
            help="The radio's CAT port, recorded for rig control. Keying is set below."
            value={draft.serialPort}
            onChange={(serialPort) => update({ serialPort })}
            ports={devices.serial}
          />
          <div className="field__help">
            Some radios present two ports on one cable with identical details, and only the port name
            tells them apart.
          </div>
          {/* Rig control ABOVE keying, because it changes what the keying
              options mean: with a rig configured, keying through it is the only
              choice that can work on a single CAT port. */}
          <RigControlFields draft={draft} update={update} ports={devices.serial} />
          <PttFields draft={draft} update={update} ports={devices.serial} />
        </>
      ) : null}

      {step === "test" ? (
        <>
          {/* Above the device test on purpose. Every new profile passes through
              here, which is the only chance to put the drive level in front of
              someone before their first transmission -- migration leaves
              existing profiles at full scale and cannot ask. */}
          <DriveLevelField draft={draft} update={update} />
          <BusyDetField draft={draft} update={update} />
          <div className="settings__actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void test.run(draft.audioInput, draft.audioOutput)}
              disabled={test.running || devices.loading}
            >
              {test.running ? "Testing…" : "Test these devices"}
            </button>
          </div>
          <TestVerdict result={test.result} />
          <div className="field__help">
            You can skip this and save anyway. It only tells you now what a real connection would
            tell you later.
          </div>
        </>
      ) : null}

      {step === "lan" ? <LanFields draft={draft} update={update} /> : null}

      {step === "review" ? (
        <>
          <div className="wizard__review">
            <div className="wizard__review-name">{draft.name.trim() || "Unnamed profile"}</div>
            <div className="wizard__review-detail">{describeProfileInput(toProfileInput(draft))}</div>
          </div>

          {test.result ? <TestVerdict result={test.result} /> : null}

          {offerMakeActive ? (
            <label className="radio">
              <input
                type="checkbox"
                checked={draft.makeActive}
                onChange={(e) => update({ makeActive: e.target.checked })}
              />
              <span>Use this radio by default</span>
            </label>
          ) : null}

          <div className="settings__actions">
            <button type="button" className="btn btn--small" onClick={() => setShowAdvanced((v) => !v)}>
              {showAdvanced ? "Hide advanced" : "Advanced"}
            </button>
          </div>
          {showAdvanced ? (
            <div className="field">
              <label className="field__label" htmlFor="wiz-host-port">
                ARDOP host port
              </label>
              <input
                id="wiz-host-port"
                className="field__input field__input--narrow"
                value={draft.hostPort}
                onChange={(e) => update({ hostPort: e.target.value })}
                inputMode="numeric"
              />
              <div className="field__help">
                Leave at {DEFAULT_ARDOP_HOST_PORT} unless something else is using that port.
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {showIssues && issues.length ? (
        <div className="settings__error">
          {issues.map((issue) => (
            <div key={issue}>{issue}</div>
          ))}
        </div>
      ) : null}

      <div className="settings__actions">
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          {cancelLabel}
        </button>
        <div className="toolbar__spacer" />
        {previousStep(draft, step) ? (
          <button
            type="button"
            className="btn"
            onClick={() => goTo(previousStep(draft, step) as WizardStep)}
            disabled={saving}
          >
            Back
          </button>
        ) : null}
        {isLast ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? "Saving…" : saveLabel}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            onClick={advance}
          >
            Continue
          </button>
        )}
      </div>
    </section>
  );
}

/** The device test's verdict, shown identically wherever the test can be run. */
export function TestVerdict({ result }: { result: AudioDeviceTestResult | null }) {
  if (!result) return null;
  return (
    <div className={result.ok ? "settings__notice" : "settings__error"}>
      <div className="wizard__verdict">{result.message}</div>
      {result.warnings.map((warning) => (
        <div key={warning} className="field__help">
          {warning}
        </div>
      ))}
    </div>
  );
}
