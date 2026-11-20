import { useState } from "react";
import { DEFAULT_ARDOP_HOST_PORT, type RadioProfile, type RadioProfileInput } from "../../../shared/configSchema.ts";
import {
  canSave,
  draftFromProfile,
  stepIssues,
  toProfileInput,
  wizardSteps,
  type WizardDraft,
} from "../../../shared/profileWizard.ts";
import { useDeviceLists } from "../../hooks/useDeviceLists.ts";
import { useAudioTest } from "../../hooks/useAudioTest.ts";
import { AudioDevicePicker, RescanBar, SerialPortPicker } from "./DevicePickers.tsx";
import { BusyDetField, DriveLevelField, LanFields, PttFields, RigControlFields } from "./ProfileFieldGroups.tsx";
import { TestVerdict } from "./RadioProfileWizard.tsx";

export interface RadioProfileEditorProps {
  profile: RadioProfile;
  onSave: (input: RadioProfileInput) => Promise<boolean>;
  onCancel: () => void;
  /** Whether this profile already has a network password in the keychain. */
  hasLanPassword?: boolean;
  /** False on systems with no keyring, where collecting one is refused. */
  secureStorageAvailable?: boolean;
  /** Applies immediately, separately from Save -- a secret never rides in the draft. */
  onSetLanPassword?: (password: string) => void;
}

/**
 * Editing an EXISTING profile: one page, every field reachable at once.
 *
 * Deliberately not the wizard. The overwhelmingly common edit is "the dongle
 * moved, fix one dropdown", and walking five steps to change one select would
 * be worse buttonology than the flat form this replaced. New profiles get the
 * guided path instead -- see RadioProfileWizard.
 *
 * Both are built on WizardDraft and toProfileInput, so the two views cannot
 * drift into collecting different things or validating them differently.
 */
export function RadioProfileEditor({
  profile,
  onSave,
  onCancel,
  hasLanPassword,
  secureStorageAvailable,
  onSetLanPassword,
}: RadioProfileEditorProps) {
  const [draft, setDraft] = useState<WizardDraft>(() => draftFromProfile(profile));
  const [showErrors, setShowErrors] = useState(false);

  const devices = useDeviceLists();
  const test = useAudioTest();

  // The same partition the wizard's steps use, flattened -- one page shows
  // every problem at once rather than the one belonging to the current step.
  const issues = wizardSteps(draft.kind).flatMap((step) => stepIssues(draft, step));

  function update(patch: Partial<WizardDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function changeAudio(patch: Partial<WizardDraft>) {
    test.reset();
    update(patch);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSave(draft)) {
      setShowErrors(true);
      return;
    }
    if (await onSave(toProfileInput(draft, profile.id))) onCancel();
  }

  return (
    <form className="profile-editor" onSubmit={submit}>
      <h3 className="profile-editor__title">Edit {profile.name}</h3>

      <div className="field">
        <label className="field__label" htmlFor="profile-name">
          Profile name
        </label>
        <input
          id="profile-name"
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
            <input type="radio" checked={draft.kind === "usb"} onChange={() => update({ kind: "usb" })} />
            <span>USB cable</span>
          </label>
          <label className="radio">
            <input type="radio" checked={draft.kind === "lan"} onChange={() => update({ kind: "lan" })} />
            <span>Network (LAN)</span>
          </label>
        </div>
      </fieldset>

      {draft.kind === "usb" ? (
        <>
          <RescanBar
            label="Devices"
            loading={devices.loading}
            error={devices.error}
            onRescan={() => void devices.rescan()}
          />

          <SerialPortPicker
            id="serial-port"
            label="Serial port"
            help="The radio's CAT port, recorded for rig control. Keying is set below."
            value={draft.serialPort}
            onChange={(serialPort) => update({ serialPort })}
            ports={devices.serial}
          />
          <RigControlFields draft={draft} update={update} ports={devices.serial} />
          <PttFields draft={draft} update={update} ports={devices.serial} />
          <DriveLevelField draft={draft} update={update} />
          <BusyDetField draft={draft} update={update} />
          <AudioDevicePicker
            id="audio-input"
            label="Audio input (from radio)"
            help="Where the modem listens. This is the radio's audio output."
            value={draft.audioInput}
            onChange={(audioInput) => changeAudio({ audioInput })}
            devices={devices.capture}
            direction="capture"
          />
          <AudioDevicePicker
            id="audio-output"
            label="Audio output (to radio)"
            help="Where the modem transmits. This is the radio's audio input."
            value={draft.audioOutput}
            onChange={(audioOutput) => changeAudio({ audioOutput })}
            devices={devices.playback}
            direction="playback"
          />

          <div className="settings__actions">
            <button
              type="button"
              className="btn btn--small"
              onClick={() => void test.run(draft.audioInput, draft.audioOutput)}
              disabled={test.running || devices.loading}
            >
              {test.running ? "Testing…" : "Test these devices"}
            </button>
          </div>
          {/* The only honest answer about whether a device works: the modem
              opens it. PortAudio's own prediction disagrees with reality on
              macOS, so this runs the real thing on a scratch port. */}
          <TestVerdict result={test.result} />
        </>
      ) : (
        <LanFields
          draft={draft}
          update={update}
          {...(hasLanPassword === undefined ? {} : { hasPassword: hasLanPassword })}
          {...(secureStorageAvailable === undefined ? {} : { secureStorageAvailable })}
          {...(onSetLanPassword ? { onSetPassword: onSetLanPassword } : {})}
        />
      )}

      <div className="field">
        <label className="field__label" htmlFor="ardop-port">
          ARDOP host port
        </label>
        <input
          id="ardop-port"
          className="field__input field__input--narrow"
          value={draft.hostPort}
          onChange={(e) => update({ hostPort: e.target.value })}
          inputMode="numeric"
        />
        <div className="field__help">Leave at {DEFAULT_ARDOP_HOST_PORT} unless something else is using that port.</div>
      </div>

      {showErrors && issues.length ? (
        <div className="settings__error">
          {issues.map((issue) => (
            <div key={issue}>{issue}</div>
          ))}
        </div>
      ) : null}

      <div className="settings__actions">
        <button type="submit" className="btn btn--primary">
          Save changes
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
