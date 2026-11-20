import { useState } from "react";
import type { AppConfigView } from "../../../shared/ipcContract.ts";
import type { RadioProfile, RadioProfileInput } from "../../../shared/configSchema.ts";
import { StationIdentityForm } from "./StationIdentityForm.tsx";
import { DiagnosticsSection } from "./DiagnosticsSection.tsx";
import { PickupStationsSection } from "./PickupStationsSection.tsx";
import { RadioProfileList } from "./RadioProfileList.tsx";
import { RadioProfileEditor } from "./RadioProfileEditor.tsx";
import { RadioProfileWizard } from "./RadioProfileWizard.tsx";

export interface SettingsPageProps {
  config: AppConfigView | null;
  error: string | null;
  clearError: () => void;
  mutate: (action: () => Promise<AppConfigView>) => Promise<boolean>;
}

/**
 * Editing nothing, adding a new profile, or editing an existing one.
 *
 * The two open states render different components on purpose: a new profile
 * gets the guided wizard, an existing one gets the single-page editor, because
 * changing one dropdown should not cost five clicks.
 */
type EditorState = { open: false } | { open: true; profile: RadioProfile } | { open: true; profile: null };

export function SettingsPage({ config, error, clearError, mutate }: SettingsPageProps) {
  const [editor, setEditor] = useState<EditorState>({ open: false });
  const [pendingDelete, setPendingDelete] = useState<RadioProfile | null>(null);

  if (!config) {
    return (
      <section className="pane" aria-label="Settings">
        <header className="pane__header">
          <span className="pane__title">Settings</span>
        </header>
        <div className="pane__scroll settings">
          <div className="settings__inner">
            <div className="settings__empty">Loading your configuration…</div>
          </div>
        </div>
      </section>
    );
  }

  const saveProfile = (input: RadioProfileInput) => mutate(() => window.wl2go.profiles.save(input));
  const existingProfiles = config.profiles;

  /**
   * Saves a new profile and, when asked, points the station at it.
   *
   * Two mutations rather than one: profiles:save has no "and make it active"
   * flag, and inventing an IPC channel for it would be Module 9's business.
   * The store already makes the FIRST profile active by itself, so this only
   * does real work from the second profile onwards.
   *
   * The new profile is found by diffing IDS, not by matching the name. Names
   * are not unique -- nothing stops an operator having two "IC-7300" entries --
   * and picking the wrong one would silently make the wrong radio active.
   */
  async function saveNewProfile(input: RadioProfileInput, makeActive: boolean): Promise<boolean> {
    const known = new Set(existingProfiles.map((p) => p.id));
    if (!(await saveProfile(input))) return false;
    if (!makeActive) return true;

    // Skipped when the save failed, so a rejected profile can never leave the
    // station pointing at something that was not created.
    const saved = await window.wl2go.config.get();
    const created = saved.profiles.find((p) => !known.has(p.id));
    if (created && saved.activeProfileId !== created.id) {
      await mutate(() => window.wl2go.profiles.setActive({ id: created.id }));
    }
    return true;
  }

  return (
    <section className="pane" aria-label="Settings">
      <header className="pane__header">
        <div>
          <span className="pane__title">Settings</span>
          <span className="pane__subtitle"> — your station and the radios WL2GO can use</span>
        </div>
      </header>

      <div className="pane__scroll settings">
        <div className="settings__inner">
          {error ? (
            <div className="settings__error settings__error--banner">
              <span>{error}</span>
              <button type="button" className="btn btn--small" onClick={clearError}>
                Dismiss
              </button>
            </div>
          ) : null}

          {config.warnings.length ? (
            <div className="settings__notice">
              <strong>Your configuration file needed repairs on the last start.</strong>
              {config.warnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </div>
          ) : null}

          <StationIdentityForm
            config={config}
            onSaveStation={(callsign, gridSquare, shareWithWinlink) =>
              mutate(() => window.wl2go.config.setStation({ callsign, gridSquare, shareWithWinlink }))
            }
            onSavePassword={(password) => mutate(() => window.wl2go.config.setWinlinkPassword({ password }))}
          />

          {/* Straight after the password: it is what makes this list changeable. */}
          <PickupStationsSection config={config} />

          {editor.open && editor.profile ? (
            <RadioProfileEditor
              profile={editor.profile}
              onSave={saveProfile}
              onCancel={() => setEditor({ open: false })}
              hasLanPassword={config.profilesWithLanPassword.includes(editor.profile.id)}
              secureStorageAvailable={config.secureStorageAvailable}
              // Applied immediately rather than on Save: a credential must not
              // travel in the draft that gets written to config.json.
              onSetLanPassword={(password) => {
                const profileId = editor.profile?.id;
                if (profileId) {
                  void mutate(() => window.wl2go.profiles.setLanPassword({ profileId, password }));
                }
              }}
            />
          ) : editor.open ? (
            <RadioProfileWizard
              onSave={saveNewProfile}
              onCancel={() => setEditor({ open: false })}
              offerMakeActive={existingProfiles.length > 0}
            />
          ) : (
            <RadioProfileList
              profiles={config.profiles}
              activeProfileId={config.activeProfileId}
              onAdd={() => setEditor({ open: true, profile: null })}
              onEdit={(profile) => setEditor({ open: true, profile })}
              onDelete={setPendingDelete}
              onSetActive={(profile) => void mutate(() => window.wl2go.profiles.setActive({ id: profile.id }))}
            />
          )}

          <DiagnosticsSection
            config={config}
            onSetRecordAudio={(recordRxAudio) =>
              void mutate(() => window.wl2go.config.setDiagnostics({ recordRxAudio }))
            }
          />

          {/* Deleting a profile also destroys its stored credentials, so it is
              confirmed rather than done on a single click. */}
          {pendingDelete ? (
            <div className="settings__confirm" role="alertdialog" aria-label="Confirm deletion">
              <div>
                Delete <strong>{pendingDelete.name}</strong>? Any password saved for it is removed too.
              </div>
              <div className="settings__actions">
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => {
                    void mutate(() => window.wl2go.profiles.delete({ id: pendingDelete.id }));
                    setPendingDelete(null);
                  }}
                >
                  Delete
                </button>
                <button type="button" className="btn" onClick={() => setPendingDelete(null)}>
                  Keep it
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
