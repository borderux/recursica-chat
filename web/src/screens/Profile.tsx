// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Server > You: your own profile. Your username (PUT /api/me/handle), how everyone sees
// you; your full name (PATCH /api/me), shown only here and behind your initials; your avatar's
// color (PUT /api/me/look); and whether your Google photo is your avatar (PUT /api/me/photo).
// The server side is server/src/profile.ts.
import { useEffect, useState } from "react";
import { api, type User } from "../api.ts";
import { useStore } from "../store.tsx";
import { NAMED_TONES, PersonAv, Toggle } from "../ui/ui.tsx";

/** The longest name the server keeps (PATCH /api/me cuts a name at 60 characters). */
export const NAME_MAX = 60;

export function YourProfile({ onSignOut }: { onSignOut: () => void }) {
  const { me, setMe, reloadUsers, profiles, reloadProfiles, toast, fail } = useStore();
  const mine = profiles[me.id];
  const [name, setName] = useState(me.name);
  const [handle, setHandle] = useState(mine?.handle ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(me.name), [me.name]);
  useEffect(() => setHandle(mine?.handle ?? ""), [mine?.handle]);
  const clean = name.trim();
  const changed = clean !== me.name;
  const cleanHandle = handle.trim().replace(/^@/, "").toLowerCase();
  const handleChanged = !!mine && cleanHandle !== mine.handle;

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const saveName = () =>
    run(async () => {
      if (!clean || !changed) return;
      const r = await api.patch<{ user: User }>("/api/me", { name: clean });
      setMe(r.user);
      await reloadUsers();
      toast("Saved");
    });
  const saveHandle = () =>
    run(async () => {
      if (!cleanHandle || !handleChanged) return;
      await api.put("/api/me/handle", { handle: cleanHandle });
      await reloadProfiles();
      toast("Saved");
    });
  const tone = mine?.tone ?? undefined;
  const pickTone = (t: string | null) =>
    run(async () => {
      if (t === (tone ?? null)) return;
      await api.put("/api/me/look", { tone: t });
      await reloadProfiles();
    });
  const usePhoto = (use: boolean) =>
    run(async () => {
      await api.put("/api/me/photo", { use });
      await reloadProfiles();
    });

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
  const field = (id: string, label: string, value: string, set: (v: string) => void, can: boolean, save: () => Promise<void>, extra: object) => (
    <form
      className="it"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label htmlFor={id}>{label}</label>
      <span className="right" style={{ gap: 8 }}>
        <input id={id} className="input sm" style={{ width: 220 }} value={value} onChange={(e) => set(e.target.value)} {...extra} />
        <button className="btn sm" type="submit" disabled={busy || !can}>
          Save
        </button>
      </span>
    </form>
  );

  return (
    <>
      <div className="sect">You</div>
      <div className="group">
        <div className="it">
          <PersonAv
            name={clean || me.name}
            id={me.id}
            tone={tone}
            photo={mine?.photo ? `/api/people/${me.id}/photo?v=${mine.photo}` : undefined}
            title={mine ? `@${mine.handle}` : undefined}
          />
          <div className="grow">
            <b style={{ fontWeight: 600 }}>{mine ? `@${mine.handle}` : me.name}</b>
            <div className="small muted">
              {me.name} · {me.email} · {me.role.charAt(0).toUpperCase() + me.role.slice(1)}
            </div>
          </div>
          <button className="btn sm" onClick={onSignOut}>
            Sign out
          </button>
        </div>
        {field("profile-handle", "Username", handle, setHandle, !!cleanHandle && handleChanged, saveHandle, {
          maxLength: 31,
          autoComplete: "username",
          spellCheck: false,
        })}
        {field("profile-name", "Full name", name, setName, !!clean && changed, saveName, { maxLength: NAME_MAX, autoComplete: "name" })}
        <div className="it">
          Avatar color
          <span className="right" style={{ gap: 6, flexWrap: "wrap" }}>
            {swatch(null, "Automatic", "var(--bg)", "var(--ink-2)")}
            {Object.entries(NAMED_TONES).map(([t, c]) => swatch(t, t[0].toUpperCase() + t.slice(1), c.bg, c.fg))}
          </span>
        </div>
        <div className="it">
          <div className="grow">
            Use my Google photo
            <div className="small muted">
              {mine?.hasPhoto ? "A copy from your last sign-in with Google, kept on this server." : "None yet: it's copied at your next sign-in with Google."}
            </div>
          </div>
          <Toggle on={mine?.usePhoto ?? true} disabled={busy} label="Use my Google photo" onChange={(v) => void usePhoto(v)} />
        </div>
      </div>
      <p className="small muted" style={{ marginTop: 6 }}>
        Everyone sees you as your username, with your photo or your initials on your color. Your full name shows only here and behind your initials. People and
        agents mention you with @{mine?.handle ?? "username"}.
      </p>
    </>
  );
}
