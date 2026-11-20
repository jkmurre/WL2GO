import { useState } from "react";
import type { SerialPortInfo } from "../../../shared/ipcContract.ts";
import { TX_MODES, icomPttCommands, type PttMethod, type TxMode } from "../../../shared/configSchema.ts";
import { txModeLabel, txModeNote } from "../../../shared/rigModes.ts";
import {
  CUSTOM_PRESET_ID,
  CUSTOM_PRESET_NOTE,
  DEFAULT_PRESET_ID,
  PTT_PRESETS,
  findPreset,
  presetIdForCommands,
} from "../../../shared/pttPresets.ts";
import { hamlibFromDraft, pttFromDraft, type WizardDraft } from "../../../shared/profileWizard.ts";
import { useRadioDetect } from "../../hooks/useRadioDetect.ts";
import { useRigModels } from "../../hooks/useRigModels.ts";
import { TuningModal } from "./TuningModal.tsx";
import { SerialPortPicker } from "./DevicePickers.tsx";

/**
 * The field groups the guided wizard and the single-page editor BOTH render.
 *
 * They already share WizardDraft and toProfileInput so they cannot collect
 * different things; these components are the same guarantee one level up, for
 * the markup. PTT in particular has four methods with different fields each,
 * and two hand-maintained copies of that would drift on the first change.
 */

export interface DraftFieldsProps {
  draft: WizardDraft;
  update: (patch: Partial<WizardDraft>) => void;
}

export interface LanFieldsProps extends DraftFieldsProps {
  /** Whether a password is already in the keychain for this profile. */
  hasPassword?: boolean;
  /** Absent while creating a profile: there is no id to file a secret under yet. */
  onSetPassword?: (password: string) => void;
  /** False on systems with no keyring; the UI must then refuse to collect one. */
  secureStorageAvailable?: boolean;
}

/**
 * Icom's three UDP ports.
 *
 * All three are editable rather than assumed. They ship as 50001/50002/50003
 * but they are per-radio settings -- the same model can be reconfigured, and an
 * operator who moved one because the default was taken must be able to say so.
 */
export function LanFields({
  draft,
  update,
  hasPassword,
  onSetPassword,
  secureStorageAvailable = true,
}: LanFieldsProps) {
  const ports: ReadonlyArray<{ key: "controlPort" | "civPort" | "audioPort"; label: string; help: string }> = [
    { key: "controlPort", label: "Control port", help: "Login and session keepalive." },
    { key: "civPort", label: "CI-V port", help: "Rig commands — the network equivalent of the CAT cable." },
    { key: "audioPort", label: "Audio port", help: "The codec stream in both directions." },
  ];

  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor="lan-host">
          Host
        </label>
        <input
          id="lan-host"
          className="field__input"
          value={draft.host}
          onChange={(e) => update({ host: e.target.value })}
          placeholder="192.168.1.50"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>

      {ports.map(({ key, label, help }) => (
        <div className="field" key={key}>
          <label className="field__label" htmlFor={`lan-${key}`}>
            {label}
          </label>
          <input
            id={`lan-${key}`}
            className="field__input field__input--narrow"
            value={draft[key]}
            onChange={(e) => update({ [key]: e.target.value })}
            inputMode="numeric"
          />
          <div className="field__help">{help}</div>
        </div>
      ))}

      <div className="field">
        <label className="field__label" htmlFor="lan-user">
          Username
        </label>
        <input
          id="lan-user"
          className="field__input"
          value={draft.username}
          onChange={(e) => update({ username: e.target.value })}
          autoCorrect="off"
          spellCheck={false}
        />
        {/* Not "Optional" any more. The profile still SAVES without it -- an
            unfinished profile is legal, same as a USB one for a radio that has
            not arrived -- but the radio's login needs it, so a session cannot
            start until it is filled in. */}
        <div className="field__help">
          Needed to connect: this is the login the radio itself expects. The profile saves without it.
        </div>
      </div>

      {onSetPassword ? (
        <LanPassword
          hasPassword={hasPassword === true}
          available={secureStorageAvailable}
          onSet={onSetPassword}
        />
      ) : null}

      {/* Says what is and is not built, rather than implying a session will
          work. A networked Icom carries its audio in Icom's own protocol on the
          port above; the modem can only open a local sound card, so there is
          nothing to connect with yet. */}
      <div className="settings__notice">
        Network profiles can be saved and edited now. Connecting to a radio over its network port needs
        WL2GO to speak Icom&rsquo;s own protocol on all three ports, which is not built yet — use the
        USB connection for on-air sessions in the meantime.
      </div>
    </>
  );
}

/**
 * Transmit drive, and the door to the tuning window.
 *
 * Shown as a plain number here rather than a live slider: changing it means
 * nothing until it is applied to a running modem, and a slider that appears to
 * do something while nothing is transmitting would be a control with no effect.
 * The tuning window is where it can actually be heard.
 */
export function DriveLevelField({ draft, update }: DraftFieldsProps) {
  const [tuning, setTuning] = useState(false);

  return (
    <div className="field">
      <span className="field__label">Transmit drive — {draft.driveLevel}</span>
      <div className="settings__actions">
        <button type="button" className="btn btn--small" onClick={() => setTuning(true)}>
          Set the drive level…
        </button>
      </div>
      <div className="field__help">
        Scales the audio the modem transmits. Lower it until the radio&rsquo;s ALC meter is barely
        moving — ALC acting on a digital signal is what distorts it.
        {draft.driveLevel === 100
          ? " This is still at full scale, which is the modem's default rather than a level anyone chose."
          : ""}
      </div>
      {tuning ? (
        <TuningModal
          // Straight from the draft, so the window tunes the radio being edited
          // rather than whichever profile happens to be active.
          target={{
            audioInput: draft.audioInput,
            audioOutput: draft.audioOutput,
            ptt: pttFromDraft(draft),
            driveLevel: draft.driveLevel,
            // The rig goes too. It is what keys the radio when this profile
            // keys through rig control, AND what puts the radio into a data
            // mode -- without which the two-tone test modulates nothing and
            // every drive level looks identical on the ALC meter.
            hamlib: hamlibFromDraft(draft),
            txMode: draft.txMode,
          }}
          onDone={(driveLevel) => {
            update({ driveLevel });
            setTuning(false);
          }}
          onCancel={() => setTuning(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * ardopcf's busy-detector sensitivity (BUSYDET), 0-10.
 *
 * A plain number, not a slider: there is no live feedback to tune it against
 * short of listening on the air, so a slider here would only invite
 * fiddling. Lower is MORE sensitive; the scale is steep (the detector's
 * threshold grows with this number to the 4th power), so a step or two is a
 * big swing in practice, not fine control.
 */
export function BusyDetField({ draft, update }: DraftFieldsProps) {
  return (
    <div className="field">
      <label className="field__label" htmlFor="busyDetLevel">
        Busy detector sensitivity
      </label>
      <input
        id="busyDetLevel"
        className="field__input field__input--narrow"
        value={draft.busyDetLevel}
        onChange={(e) => update({ busyDetLevel: e.target.value })}
        inputMode="numeric"
      />
      <div className="field__help">
        How much signal above the noise floor the modem requires before it calls the channel busy,
        before every on-air dial. A whole number from 0 to 10 — lower is more sensitive to weak or
        marginal signals, but also to noise; raise it if the pre-dial check reports busy with no
        one actually on frequency. Each step is a large change (the threshold roughly doubles per
        step) — 5 is ardopcf&rsquo;s own default.
      </div>
    </div>
  );
}

const PTT_METHODS: ReadonlyArray<{ value: PttMethod; label: string }> = [
  { value: "none", label: "VOX — the interface keys itself" },
  { value: "rts", label: "Serial RTS" },
  { value: "cat", label: "CAT command" },
  { value: "rigctld", label: "Through rig control (recommended when rig control is on)" },
];

export interface RigControlFieldsProps extends DraftFieldsProps {
  ports: SerialPortInfo[];
}

/**
 * Rig control: whether WL2GO drives the radio's VFO and mode at all.
 *
 * OFF by default and opt-in, because a wrong model number drives the wrong
 * radio and WL2GO retuning a transmitter nobody asked it to touch is worse than
 * not doing it. With it on, three separate things start working that cannot
 * work without it: the station browser tunes the radio to the frequency that
 * was actually chosen, the radio is put into a DATA mode so the sound card
 * rather than the microphone is transmitted, and keying can go through Hamlib.
 */
export function RigControlFields({ draft, update, ports }: RigControlFieldsProps) {
  const rigs = useRigModels();
  const enabled = draft.rigModel !== "";

  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor="rig-model">
          Radio model
        </label>
        <select
          id="rig-model"
          className="field__input"
          value={draft.rigModel}
          onChange={(e) => {
            const rigModel = e.target.value;
            update({
              rigModel,
              // Turning rig control on defaults keying to it as well. With one
              // CAT port there is no other correct answer -- rigctld holds it,
              // so CAT keying on the same port cannot open it, and
              // validateProfile refuses to save that combination anyway.
              ...(rigModel && !draft.rigPort ? { rigPort: draft.pttPort || draft.serialPort } : {}),
              ...(rigModel && draft.pttMethod !== "rigctld" && draft.pttPort === draft.rigPort
                ? { pttMethod: "rigctld" as const }
                : {}),
            });
          }}
        >
          <option value="">No rig control — I will tune the radio by hand</option>
          {rigs.models.map((rig) => (
            <option key={rig.model} value={String(rig.model)}>
              {rig.make} {rig.name}
              {rig.status === "Beta" ? " (beta)" : ""}
            </option>
          ))}
        </select>
        <div className="field__help">
          {rigs.error
            ? `The radio list could not be read: ${rigs.error}`
            : rigs.loading
              ? "Reading the list of supported radios…"
              : enabled
                ? "WL2GO will set the frequency and the transmit mode before each call, and put them back afterwards."
                : "Without this, WL2GO will not touch your radio: set the frequency and a DATA mode by hand before calling."}
        </div>
      </div>

      {enabled ? (
        <>
          <div className="field">
            <label className="field__label" htmlFor="rig-port">
              Radio CAT port
            </label>
            <select
              id="rig-port"
              className="field__input"
              value={draft.rigPort}
              onChange={(e) => update({ rigPort: e.target.value })}
            >
              <option value="">Select…</option>
              {ports.map((port) => (
                <option key={port.path} value={port.path}>
                  {port.path}
                  {port.manufacturer ? ` — ${port.manufacturer}` : ""}
                </option>
              ))}
            </select>
            <div className="field__help">
              The serial port the radio&rsquo;s CAT interface is on. WL2GO holds this port for as long
              as this profile is active, so nothing else can use it — which is why keying should go
              through rig control too.
            </div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="rig-baud">
              CAT speed
            </label>
            <input
              id="rig-baud"
              className="field__input field__input--narrow"
              value={draft.rigBaud}
              inputMode="numeric"
              onChange={(e) => update({ rigBaud: e.target.value })}
            />
            <div className="field__help">Must match the radio&rsquo;s own CI-V or CAT baud setting.</div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="rig-txmode">
              Transmit mode
            </label>
            <select
              id="rig-txmode"
              className="field__input"
              value={draft.txMode}
              onChange={(e) => update({ txMode: e.target.value as TxMode })}
            >
              {TX_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {txModeLabel(mode)}
                </option>
              ))}
            </select>
            <div className="field__help">{txModeNote(draft.txMode)}</div>
          </div>
        </>
      ) : null}
    </>
  );
}

export interface PttFieldsProps extends DraftFieldsProps {
  ports: SerialPortInfo[];
}

/**
 * How the modem keys the transmitter.
 *
 * Without one of these the radio never transmits, so this is not an optional
 * extra -- it is the difference between a profile that can hold a session and
 * one that dials and goes silent. CM108/HID is deliberately not offered: our
 * ardopcf recognises it only through a Linux hidraw path, so on macOS the
 * option would be a control that does nothing.
 */
export function PttFields({ draft, update, ports }: PttFieldsProps) {
  const method = draft.pttMethod;
  const usesSerial = method === "rts" || method === "cat";

  // Derived from the commands rather than stored alongside them, so a profile
  // written before this picker existed still opens showing its radio. The one
  // thing derivation cannot recover is a deliberate choice of Custom whose hex
  // happens to match a preset, which is what this piece of local state is for.
  const [customChosen, setCustomChosen] = useState(false);
  const matched = presetIdForCommands(draft.pttKeyHex, draft.pttUnkeyHex);
  const presetId = customChosen ? CUSTOM_PRESET_ID : matched;
  const preset = findPreset(presetId);

  const radio = useRadioDetect();

  /**
   * Puts what the probe found into the draft.
   *
   * The commands come from the address the radio REPORTED, not from the model
   * we guessed: an operator who changed the CI-V address in the radio's menu
   * gets working commands even though no preset matches, which is the case a
   * model dropdown alone cannot serve.
   */
  const applyDetection = async () => {
    const result = await radio.detect();
    const found = result?.found;
    if (!found) return;

    const preset = found.presetId ? findPreset(found.presetId) : null;
    const commands = preset ?? icomPttCommands(found.civAddress);
    setCustomChosen(false);
    update({
      // CI-V answered, so CAT is the method that will work. Left alone when the
      // operator has deliberately chosen RTS -- the probe found their radio,
      // but it did not find out how they wired their keying.
      pttMethod: method === "rts" ? "rts" : "cat",
      pttPort: found.port,
      pttBaud: String(found.baud),
      pttKeyHex: commands.keyHex,
      pttUnkeyHex: commands.unkeyHex,
    });
  };

  const applyPreset = (id: string) => {
    if (id === CUSTOM_PRESET_ID) {
      setCustomChosen(true);
      return;
    }
    setCustomChosen(false);
    const chosen = findPreset(id);
    if (chosen) update({ pttKeyHex: chosen.keyHex, pttUnkeyHex: chosen.unkeyHex });
  };

  /**
   * Switching to CAT fills the commands in rather than revealing two blanks.
   *
   * Only when they are empty: an operator coming back to CAT after a detour
   * through VOX keeps whatever they had. A blank CAT profile cannot key the
   * radio and will not save, so there is no valid state being overwritten.
   */
  const changeMethod = (next: PttMethod) => {
    const blank = draft.pttKeyHex.length === 0 && draft.pttUnkeyHex.length === 0;
    if (next !== "cat" || !blank) {
      update({ pttMethod: next });
      return;
    }
    const fallback = findPreset(DEFAULT_PRESET_ID);
    update({
      pttMethod: next,
      pttKeyHex: fallback?.keyHex ?? "",
      pttUnkeyHex: fallback?.unkeyHex ?? "",
    });
    setCustomChosen(false);
  };

  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor="ptt-method">
          How the radio keys
        </label>
        <select
          id="ptt-method"
          className="field__input"
          value={method}
          onChange={(e) => changeMethod(e.target.value as PttMethod)}
        >
          {PTT_METHODS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <div className="field__help">
          {method === "none"
            ? "The modem transmits audio and the interface keys the radio itself. Fine for VOX; nothing else to set."
            : method === "rigctld"
              ? "Keys through Hamlib rig control. That needs rig control running, which is not built yet — pick another method for now."
              : "The modem keys the radio directly through the port below."}
        </div>
      </div>

      {/* The radio, before anything technical. Everything below it is derived
          from this one choice, and for most operators this is the only PTT
          control they should ever have to touch. */}
      {method === "cat" ? (
        <div className="field">
          <label className="field__label" htmlFor="ptt-radio">
            Which radio
          </label>
          <select
            id="ptt-radio"
            className="field__input"
            value={presetId}
            onChange={(e) => applyPreset(e.target.value)}
          >
            {PTT_PRESETS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
            <option value={CUSTOM_PRESET_ID}>Another radio — enter the commands myself</option>
          </select>
          <div className="field__help">{preset ? preset.note : CUSTOM_PRESET_NOTE}</div>
        </div>
      ) : null}

      {/* Answers the two things a dropdown cannot: which of the radio's serial
          ports carries CI-V -- an IC-7300 MkII presents two that are identical
          in every other respect -- and what address it is really set to. */}
      {usesSerial ? (
        <div className="field">
          <div className="settings__actions">
            <button
              type="button"
              className="btn btn--small"
              disabled={radio.detecting}
              onClick={() => void applyDetection()}
            >
              {radio.detecting ? "Listening for the radio…" : "Detect my radio"}
            </button>
          </div>
          {radio.detection ? (
            <div className="field__help">
              {radio.detection.found ? radio.detection.found.summary : radio.detection.message}
            </div>
          ) : (
            <div className="field__help">
              Asks each serial port who is there. It only reads — it cannot key the transmitter.
            </div>
          )}
        </div>
      ) : null}

      {usesSerial ? (
        <>
          <SerialPortPicker
            id="ptt-port"
            label={method === "cat" ? "CAT port" : "PTT port"}
            help={
              method === "cat"
                ? "The radio's CAT port. It may be the same port as rig control uses."
                : "The modem asserts RTS on this port to transmit."
            }
            value={draft.pttPort}
            onChange={(value) => update({ pttPort: value })}
            ports={ports}
          />
          <div className="field">
            <label className="field__label" htmlFor="ptt-baud">
              Speed
            </label>
            <input
              id="ptt-baud"
              className="field__input field__input--narrow"
              value={draft.pttBaud}
              onChange={(e) => update({ pttBaud: e.target.value })}
              inputMode="numeric"
            />
            <div className="field__help">
              Must match the radio&rsquo;s setting. On an IC-7300 that is SET &rsaquo; Connectors &rsaquo; CI-V.
            </div>
          </div>
        </>
      ) : null}

      {method === "rigctld" ? (
        <div className="field">
          <label className="field__label" htmlFor="ptt-address">
            Rig control address
          </label>
          <input
            id="ptt-address"
            className="field__input"
            value={draft.pttPort}
            onChange={(e) => update({ pttPort: e.target.value })}
            placeholder="127.0.0.1:4532"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
      ) : null}

      {method === "cat" ? <RawCatCommands draft={draft} update={update} startOpen={presetId === CUSTOM_PRESET_ID} /> : null}

      {usesSerial ? (
        <KeyingTest
          onTest={() => void radio.testKeying(pttFromDraft(draft))}
          running={radio.keying}
          result={radio.keyResult}
        />
      ) : null}
    </>
  );
}

/**
 * Keys the radio once, on purpose.
 *
 * Two clicks rather than one, because this is the only control in WL2GO that
 * puts a carrier on the air outside a session. The armed state names what is
 * about to happen instead of relying on the operator to know.
 */
function KeyingTest({
  onTest,
  running,
  result,
}: {
  onTest: () => void;
  running: boolean;
  result: { ok: boolean; message: string } | null;
}) {
  const [armed, setArmed] = useState(false);

  return (
    <div className="field">
      <span className="field__label">Check the keying</span>
      {armed ? (
        <>
          <div className="field__help">
            This keys your transmitter for about a second. No audio is sent, so an SSB radio puts out
            nothing — but use a dummy load or a clear frequency all the same.
          </div>
          <div className="settings__actions">
            <button
              type="button"
              className="btn btn--small btn--danger"
              disabled={running}
              onClick={() => {
                setArmed(false);
                onTest();
              }}
            >
              {running ? "Keying…" : "Key the radio now"}
            </button>
            <button type="button" className="btn btn--small" onClick={() => setArmed(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="settings__actions">
            <button type="button" className="btn btn--small" disabled={running} onClick={() => setArmed(true)}>
              Test keying
            </button>
          </div>
          <div className="field__help">
            {result
              ? result.message
              : "Sends the key command, waits a second, then sends the unkey command. Watch the radio."}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The two hex commands, folded away unless they are needed.
 *
 * They used to be the most prominent control on the page, above nothing and
 * below the port, with the presets as two small buttons underneath -- which
 * told an operator who had never seen a CI-V frame that hex was the thing they
 * were supposed to know. It is an escape hatch, so it looks like one.
 */
function RawCatCommands({ draft, update, startOpen }: DraftFieldsProps & { startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const show = open || startOpen;

  return (
    <div className="field">
      <button
        type="button"
        className="btn btn--small"
        aria-expanded={show}
        onClick={() => setOpen(!show)}
      >
        {show ? "Hide the raw commands" : "Show the raw commands"}
      </button>
      {show ? (
        <>
          <div className="field">
            <label className="field__label" htmlFor="ptt-key">
              Key command
            </label>
            <input
              id="ptt-key"
              className="field__input"
              value={draft.pttKeyHex}
              onChange={(e) => update({ pttKeyHex: e.target.value })}
              placeholder="FE FE 94 E0 1C 00 01 FD"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="ptt-unkey">
              Unkey command
            </label>
            <input
              id="ptt-unkey"
              className="field__input"
              value={draft.pttUnkeyHex}
              onChange={(e) => update({ pttUnkeyHex: e.target.value })}
              placeholder="FE FE 94 E0 1C 00 00 FD"
              autoCorrect="off"
              spellCheck={false}
            />
            <div className="field__help">Hex, with or without spaces. WL2GO tidies it up when you save.</div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The networked radio's login password.
 *
 * Kept out of WizardDraft deliberately: everything else in the draft is written
 * to config.json, and a credential must never take that route. This goes
 * straight to the keychain through its own channel, namespaced by profile id,
 * so two radios can have different logins and deleting a profile takes its
 * password with it.
 *
 * Only offered when editing a saved profile, because a secret needs a profile
 * id to be filed under and a profile being created does not have one yet.
 */
function LanPassword({
  hasPassword,
  available,
  onSet,
}: {
  hasPassword: boolean;
  available: boolean;
  onSet: (password: string) => void;
}) {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);

  if (!available) {
    return (
      <div className="field">
        <span className="field__label">Password</span>
        <div className="field__help">
          This system has no secure keychain, so WL2GO will not store a password. It refuses rather than
          writing one to disk in clear text.
        </div>
      </div>
    );
  }

  return (
    <div className="field">
      <label className="field__label" htmlFor="lan-password">
        Password
      </label>
      <input
        id="lan-password"
        className="field__input"
        type="password"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(false);
        }}
        placeholder={hasPassword ? "Stored — type to replace" : "Not set"}
        autoComplete="off"
      />
      <div className="settings__actions">
        <button
          type="button"
          className="btn btn--small"
          disabled={!value}
          onClick={() => {
            onSet(value);
            setValue("");
            setSaved(true);
          }}
        >
          Save password
        </button>
        {hasPassword ? (
          <button
            type="button"
            className="btn btn--small"
            onClick={() => {
              onSet("");
              setValue("");
              setSaved(false);
            }}
          >
            Clear
          </button>
        ) : null}
        {saved ? <span className="field__help">Saved to the keychain.</span> : null}
      </div>
      <div className="field__help">
        Stored in your keychain, never in WL2GO&rsquo;s configuration file.
      </div>
    </div>
  );
}
