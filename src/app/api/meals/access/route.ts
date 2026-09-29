import { NextResponse } from "next/server";
import { requireIdentity } from "@/lib/patient-auth";
import { accessibleProfiles, loadMealProfiles } from "@/lib/meals/profiles";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const user = await requireIdentity(req);
  if (!("sub" in user)) return user;
  const children = accessibleProfiles(await loadMealProfiles(), user).map(({ members: _members, ...p }) => ({ ...p, localOnly: p.id !== "patient" || process.env.DEMO_MODE === "true" }));
  return NextResponse.json({ sub: user.sub, canLogMeals: children.length > 0,
    canManageProfiles: user.role === "owner", children, defaultChildId: children[0]?.id ?? "" },
    { headers: { "Cache-Control": "private, no-store" } });
}
