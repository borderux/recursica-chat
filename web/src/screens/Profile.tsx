// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Server > You: your own profile. You change your display name here, through PATCH /api/me,
// and your avatar's color, through PUT /api/me/look (server/src/profile.ts).
import { useEffect, useState } from "react";
import { api, type User } from "../api.ts";
import { useStore } from "../store.tsx";
import { NAMED_TONES, PersonAv } from "../ui/ui.tsx";

/** The longest name the server keeps (PATCH /api/me cuts a name at 60 characters). */
export const NAME_MAX = 60;

export function YourProfile({ onSignOut }: { onSignOut: () => void }) {
  const { me, setMe, reloadUsers, looks, reloadLooks, toast, fail } = useStore();
  const [name, setName] = useState(me.name);
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(me.name), [me.name]);
  const clean = name.trim();
  const changed = clean !== me.name;

  const save = async () => {
    if (!clean || !changed) return;
    setBusy(true);
    try {
      const r = await api.patch<{ user: User }>("/api/me", { name: clean });
      setMe(r.user);
      await reloadUsers();
      toast("Saved");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const tone = looks[me.id];
  const pickTone = async (t: string | null) => {
    if (t === (tone ?? null)) return;
    setBusy(true);
    try {
      await api.put("/api/me/look", { tone: t });
      await reloadLooks();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const swatch = (t: string | null, label: string, bg: string, fg: string) => (
    <button
      key={label}
      type="button"
      title={label}
      aria-label={`Avatar color: ${label}`}
      aria-pressed={(tone ?? null) === t}
      disabled={busy}
      onClick={() => void pickTone(t)}
      style={{
        width: 28,
        height: 28,
        borderRadius: "50%",
        background: bg,
        color: fg,
        fontSize: 11,
        fontWeight: 600,
        cursor: "pointer",
        border: (tone ?? null) === t ? "2px solid var(--accent)" : "1px solid var(--line)",
      }}
    >
      {t === null ? "A" : ""}
    </button>
  );

  return (
    <>
      <div className="sect">You</div>
      <div className="group">
        <div className="it">
          <PersonAv name={clean || me.name} id={me.id} tone={tone} />
          <div className="grow">
            <b style={{ fontWeight: 600 }}>{me.name}</b>
            <div className="small muted">
              {me.email} · {me.role.charAt(0).toUpperCase() + me.role.slice(1)}
            </div>
          </div>
          <button className="btn sm" onClick={onSignOut}>
            Sign out
          </button>
        </div>
        <form
          className="it"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label htmlFor="profile-name">Display name</label>
          <span className="right" style={{ gap: 8 }}>
            <input
              id="profile-name"
              className="input sm"
              style={{ width: 220 }}
              value={name}
              maxLength={NAME_MAX}
              autoComplete="name"
              onChange={(e) => setName(e.target.value)}
            />
            <button className="btn sm" type="submit" disabled={busy || !clean || !changed}>
              Save
            </button>
          </span>
        </form>
        <div className="it">
          Avatar color
          <span className="right" style={{ gap: 6, flexWrap: "wrap" }}>
            {swatch(null, "Automatic", "var(--bg)", "var(--ink-2)")}
            {Object.entries(NAMED_TONES).map(([t, c]) => swatch(t, t[0].toUpperCase() + t.slice(1), c.bg, c.fg))}
          </span>
        </div>
      </div>
      <p className="small muted" style={{ marginTop: 6 }}>
        Everyone in the workspace sees your name, and your initials on the color you choose, in chats and next to your messages.
      </p>
    </>
  );
}
