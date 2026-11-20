import type { RadioProfile } from "../../../shared/configSchema.ts";
import { describeProfile } from "../../../shared/profileSummary.ts";

export interface RadioProfileListProps {
  profiles: RadioProfile[];
  activeProfileId: string | null;
  onAdd: () => void;
  onEdit: (profile: RadioProfile) => void;
  onDelete: (profile: RadioProfile) => void;
  onSetActive: (profile: RadioProfile) => void;
}


export function RadioProfileList({
  profiles,
  activeProfileId,
  onAdd,
  onEdit,
  onDelete,
  onSetActive,
}: RadioProfileListProps) {
  return (
    <section className="settings__section">
      <div className="settings__section-head">
        <div>
          <h2 className="settings__section-title">Radio profiles</h2>
          <p className="settings__section-detail">
            A profile bundles everything needed to reach one radio, so connecting is one click.
          </p>
        </div>
        <button type="button" className="btn btn--primary" onClick={onAdd}>
          Add profile
        </button>
      </div>

      {profiles.length === 0 ? (
        <div className="settings__empty settings__empty--cta">
          {/* A sentence describing a button elsewhere on the page is not a call
              to action. This is the only place an operator with no radio set up
              will be looking, so the way forward is here. */}
          <div>
            <strong>No radio profiles yet.</strong>
            <div>
              WL2GO can send and receive over the internet without one. Set up a radio to use Winlink
              over the air.
            </div>
          </div>
          <button type="button" className="btn btn--primary" onClick={onAdd}>
            Set up a radio
          </button>
        </div>
      ) : (
        <ul className="profile-list">
          {profiles.map((profile) => {
            const active = profile.id === activeProfileId;
            return (
              <li key={profile.id} className={`profile${active ? " profile--active" : ""}`}>
                <div className="profile__main">
                  <div className="profile__name">
                    {profile.name}
                    {active ? <span className="profile__badge">Active</span> : null}
                  </div>
                  <div className="profile__detail">{describeProfile(profile)}</div>
                </div>
                <div className="profile__actions">
                  {active ? null : (
                    <button type="button" className="btn btn--small" onClick={() => onSetActive(profile)}>
                      Make active
                    </button>
                  )}
                  <button type="button" className="btn btn--small" onClick={() => onEdit(profile)}>
                    Edit
                  </button>
                  <button type="button" className="btn btn--small btn--danger" onClick={() => onDelete(profile)}>
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
