import { NextResponse } from "next/server";
import { requireIdentity } from "@/lib/patient-auth";
import { loadMealProfiles, PROFILES_KEY, PROFILE_ID, type MealProfile } from "@/lib/meals/profiles";
import { saveJSON, withStoreLock } from "@/lib/local-store";
import { getUsers } from "@/lib/users-store";

export async function GET(req: Request) {
  const user = await requireIdentity(req);
  if (!("sub" in user)) return user;
  if (user.role !== "owner") return NextResponse.json({ error: "Owner required" }, { status: 403 });
  return NextResponse.json({ profiles: await loadMealProfiles(), users: (await getUsers()).map(u => ({ username: u.username, role: u.role })) },
    { headers: { "Cache-Control": "private, no-store" } });
}
export async function POST(req: Request) {
  const user = await requireIdentity(req);
  if (!("sub" in user)) return user;
  if (user.role !== "owner") return NextResponse.json({ error: "Owner required" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const users = await getUsers();
  if (!body || typeof body.id !== "string" || !PROFILE_ID.test(body.id) || typeof body.name !== "string" || !body.name.trim() || body.name.length > 80 || typeof body.isTest !== "boolean" || (body.id === "patient" && body.isTest) || !Array.isArray(body.members) || body.members.some((m: unknown) => typeof m !== "string" || !users.some(u => u.username === m && (u.role === "parent" || u.role === "child")))) {
    return NextResponse.json({ error: "Provide a valid ID, name, test flag, and existing parent/child accounts" }, { status: 400 });
  }
  const profile: MealProfile = { id: body.id, name: body.name.trim(), isTest: body.isTest, members: [...new Set<string>(body.members)] };
  await withStoreLock(PROFILES_KEY, async () => {
    const profiles = await loadMealProfiles();
    const idx = profiles.findIndex(p => p.id === profile.id);
    if (idx < 0) profiles.push(profile); else profiles[idx] = profile;
    await saveJSON(PROFILES_KEY, profiles);
  });
  return NextResponse.json({ profile });
}
