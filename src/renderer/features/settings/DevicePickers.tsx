import type { AudioDevice, SerialPortInfo } from "../../../shared/ipcContract.ts";
import type { AudioDeviceSelection } from "../../../shared/configSchema.ts";
import { describeDevice, duplicatedNames, matchAudioSelection } from "../../../shared/audioSelection.ts";

export interface AudioDevicePickerProps {
  id: string;
  label: string;
  help: string;
  value: AudioDeviceSelection | null;
  onChange: (value: AudioDeviceSelection | null) => void;
  devices: AudioDevice[];
  direction: "capture" | "playback";
}

/** The option value standing for a saved device the listing cannot resolve. */
const UNRESOLVED = "__unresolved__";

/**
 * Picks an audio device, keyed by INDEX rather than by name.
 *
 * Two USB dongles can present the same name exactly -- PortAudio offers no
 * serial number or USB path to tell them apart -- so a name-keyed dropdown
 * cannot express "the second one" and would quietly resolve to the first. The
 * option value is therefore the index, which is unique within a listing, while
 * the NAME is what gets saved as the durable part of the selection.
 *
 * Which device a saved selection points at is decided by matchAudioSelection,
 * the same function main uses to pick ardopcf's argument. This component used
 * to answer that question itself and got it wrong in one specific way: it
 * required an exact index match whenever one had been recorded, so a device
 * whose index had merely shifted -- what happens whenever anything else is
 * plugged in -- was drawn as "not currently connected" while the Test button
 * opened it without complaint, and the same device appeared twice in the list.
 */
export function AudioDevicePicker({
  id,
  label,
  help,
  value,
  onChange,
  devices,
  direction,
}: AudioDevicePickerProps) {
  const match = matchAudioSelection(value, devices, direction);
  const duplicated = duplicatedNames(devices);
  const resolved = match.kind === "exact" || match.kind === "moved" || match.kind === "tiebreak";

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="field__input"
        value={resolved ? String(match.device.index) : match.kind === "default" ? "" : UNRESOLVED}
        onChange={(e) => {
          // Re-picking the unresolvable entry keeps it. Treating it as "nothing
          // chosen" would clear a setting the operator was only looking at.
          if (e.target.value === UNRESOLVED) return;
          const picked = devices.find((d) => String(d.index) === e.target.value);
          onChange(picked ? { name: picked.name, index: picked.index, hostApi: picked.hostApi } : null);
        }}
      >
        <option value="">Use the system default</option>
        {!resolved && value ? (
          <option value={UNRESOLVED}>
            {value.name}
            {match.kind === "ambiguous" ? " (which one?)" : " (not currently connected)"}
          </option>
        ) : null}
        {devices.map((d) => (
          <option key={d.index} value={String(d.index)}>
            {describeDevice(d, duplicated.has(d.name))}
          </option>
        ))}
      </select>
      <div className="field__help">
        {devices.length === 0 ? "Nothing detected. Connect the radio and rescan." : help}
      </div>
      {match.kind === "moved" ? (
        // Not a problem, but not silence either: the number in the config file
        // no longer matches the number on screen, and an operator who notices
        // deserves an explanation rather than a mystery.
        <div className="field__help field__help--note">
          This device is connected, but its number changed from {match.from} to {match.device.index} —
          normal when something else was plugged in or removed. Saving records the new one.
        </div>
      ) : null}
      {match.kind === "tiebreak" ? (
        <div className="field__help field__help--note">
          {match.candidates.length} devices share this name. WL2GO picked number {match.device.index}
          {" "}because that is what was saved. If the wrong radio responds, choose it again here.
        </div>
      ) : null}
      {match.kind === "ambiguous" ? (
        <div className="field__help field__help--note">
          {match.candidates.length} devices are called “{value?.name}” (numbers{" "}
          {match.candidates.map((d) => d.index).join(", ")}), and the one this profile was saved with
          is gone. Choose it again — guessing would be a coin flip on which radio transmits.
        </div>
      ) : null}
    </div>
  );
}

export interface SerialPortPickerProps {
  id: string;
  label: string;
  help: string;
  value: string;
  onChange: (value: string) => void;
  ports: SerialPortInfo[];
}

/**
 * Picks a serial port, keyed by path.
 *
 * The path is the only discriminator that works: an IC-7300 MK2 presents two
 * ports on one USB interface with identical manufacturer, vendor id, product id
 * AND serial number. The current value is kept as an option even when absent,
 * so editing a profile for an unplugged radio does not silently drop it.
 */
export function SerialPortPicker({ id, label, help, value, onChange, ports }: SerialPortPickerProps) {
  const missing = value !== "" && !ports.some((p) => p.path === value);

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="field__input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Not selected</option>
        {missing ? <option value={value}>{value} (not currently connected)</option> : null}
        {ports.map((port) => (
          <option key={port.path} value={port.path}>
            {describePort(port)}
          </option>
        ))}
      </select>
      <div className="field__help">
        {ports.length === 0 ? "Nothing detected. Connect the radio and rescan." : help}
      </div>
    </div>
  );
}

/**
 * Ports with no USB vendor id are LABELLED, never hidden: an unusual adapter
 * filtered out on the day it matters is worse than an odd entry in the list.
 */
function describePort(port: SerialPortInfo): string {
  const base = port.manufacturer ? `${port.path} — ${port.manufacturer}` : port.path;
  return port.likelyRadioInterface ? base : `${base} (probably not a radio)`;
}

export interface RescanBarProps {
  label: string;
  loading: boolean;
  error: string | null;
  onRescan: () => void;
}

/** The "Devices / Rescan" header shared by the wizard and the editor. */
export function RescanBar({ label, loading, error, onRescan }: RescanBarProps) {
  return (
    <>
      <div className="settings__devices-header">
        <span className="field__label">{label}</span>
        <button type="button" className="btn btn--small" onClick={onRescan} disabled={loading}>
          {loading ? "Scanning…" : "Rescan"}
        </button>
      </div>
      {error ? <div className="settings__error">{error}</div> : null}
    </>
  );
}
