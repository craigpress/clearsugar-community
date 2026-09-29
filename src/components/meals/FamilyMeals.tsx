"use client";
import { useEffect, useState } from "react";
import { useMeals } from "@/lib/use-meals";
import { useEpisodes } from "@/lib/use-episodes";
import { LogCarbsSheet } from "./LogCarbsSheet";
import { RecentMealsList } from "./RecentMealsList";
import { MealPromptsCard } from "./MealPromptsCard";

type Profile = { id: string; name: string; isTest: boolean; members: string[] };
function ProfileManager({ onSaved }: { onSaved: () => void }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [users, setUsers] = useState<{ username: string; role: string }[]>([]);
  const [draft, setDraft] = useState<Profile>({ id: "", name: "", isTest: false, members: [] });
  const [status, setStatus] = useState("");
  useEffect(() => { fetch("/api/meals/profiles").then(async r => { if (r.ok) { const d = await r.json(); setProfiles(d.profiles); setUsers(d.users); } }).catch(() => {}); }, []);
  if (!profiles.length) return null;
  return <details className="rounded-xl border border-[var(--border)] p-4">
    <summary className="cursor-pointer">Manage family profiles</summary>
    <form className="grid gap-3 mt-4" onSubmit={async e => {
      e.preventDefault(); setStatus("Saving…");
      try {
        const r = await fetch("/api/meals/profiles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
        const data = await r.json();
        if (!r.ok) { setStatus(data.error); return; }
        setProfiles(previous => [...previous.filter(p => p.id !== draft.id), data.profile]);
        setStatus("Saved"); onSaved();
      } catch { setStatus("Unable to save; please retry."); }
    }}>
      <label>Edit profile <select className="bg-[var(--bg-elevated)] p-2" value={profiles.some(p => p.id === draft.id) ? draft.id : ""} onChange={e => setDraft(profiles.find(p => p.id === e.target.value) ?? { id: "", name: "", isTest: false, members: [] })}>
        <option value="">New profile</option>{profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>
      <label>Profile ID <input required pattern="[a-z][a-z0-9-]{0,39}" disabled={profiles.some(p => p.id === draft.id)} className="bg-[var(--bg-elevated)] p-2" value={draft.id} onChange={e => setDraft({ ...draft, id: e.target.value })} /></label>
      <label>Name <input required maxLength={80} className="bg-[var(--bg-elevated)] p-2" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <label><input type="checkbox" disabled={draft.id === "patient"} checked={draft.isTest} onChange={e => setDraft({ ...draft, isTest: e.target.checked })} /> Test profile</label>
      <fieldset><legend>Accounts allowed to log and view meals</legend>{users.filter(u => u.role === "parent" || u.role === "child").map(u => <label className="block" key={u.username}>
        <input type="checkbox" checked={draft.members.includes(u.username)} onChange={e => setDraft({ ...draft, members: e.target.checked ? [...draft.members, u.username] : draft.members.filter(m => m !== u.username) })} /> {u.username} ({u.role})
      </label>)}</fieldset>
      <p className="text-sm text-[var(--text-secondary)]">Owners can access every profile. Only the primary profile uses the configured Nightscout instance. Other profiles have separate local meal journals.</p>
      <button className="rounded-lg bg-blue-600 p-2 text-white" type="submit">Save profile</button><p role="status">{status}</p>
    </form>
  </details>;
}

export function FamilyMeals() {
  const m = useMeals();
  const e = useEpisodes(24, m.childId);
  const profile = m.children.find(p => p.id === m.childId);
  return <section className="space-y-3">
    <h2 className="text-xl font-semibold">Family meals</h2>
    <ProfileManager onSaved={() => { void m.refresh(); }} />
    {!m.notPatient && <>
      <label>Meal log for <select className="bg-[var(--bg-elevated)] p-2 rounded-lg" value={m.childId} onChange={event => m.selectChild(event.target.value)}>{m.children.map(p => <option key={p.id} value={p.id}>{p.name}{p.isTest ? " (test)" : ""}</option>)}</select></label>
      <p className="text-sm text-[var(--text-secondary)]">{profile?.localOnly ? "This profile has a separate local meal journal. The glucose dashboard continues to show the primary profile." : "Confirmed uncovered carbohydrates are written to the primary profile’s Nightscout. Do not log carbohydrates already entered on the pump."}</p>
      <LogCarbsSheet key={m.childId} {...m} />
      <RecentMealsList meals={m.meals} loading={m.loading} deleteMeal={m.deleteMeal} />
      <MealPromptsCard key={`prompts-${m.childId}`} {...e} uploadPhoto={m.uploadPhoto} estimate={m.estimate} />
    </>}
    {m.error && <p role="alert">{m.error}</p>}
  </section>;
}
