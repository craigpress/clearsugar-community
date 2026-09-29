import { NextResponse } from "next/server";
import { requireIdentity } from "@/lib/patient-auth";
import { mealScope } from "./profile-storage";
import { accessibleProfiles, loadMealProfiles } from "./profiles";

export function withMealRoute<C>(handler: (req: Request, context: C) => Promise<Response>, write = true) {
  return async (req: Request, context?: C) => {
    const user = await requireIdentity(req);
    if (!("sub" in user)) return user;
    const profiles = await loadMealProfiles();
    const allowed = accessibleProfiles(profiles, user);
    if (!allowed.length) return NextResponse.json({ error: "No meal profiles assigned to this account" }, { status: 403 });
    const query = new URL(req.url).searchParams.get("childId");
    const header = req.headers.get("X-Meal-Child");
    const body = req.method === "POST" ? await req.clone().json().catch(() => null) : null;
    const choices = [query, header, body?.childId].filter(value => value !== null && value !== undefined);
    if (new Set(choices).size > 1 || choices.some(value => typeof value !== "string" || !profiles.some(p => p.id === value))) {
      return NextResponse.json({ error: "Invalid or conflicting profile selection" }, { status: 400 });
    }
    if (!choices.length && (allowed.length !== 1 || (write && user.role !== "child"))) {
      return NextResponse.json({ error: "Choose a meal profile" }, { status: 400 });
    }
    const profile = allowed.find(p => p.id === (choices[0] ?? allowed[0].id));
    if (!profile) return NextResponse.json({ error: "Profile access denied" }, { status: 403 });
    const response = await mealScope.run(profile, () => handler(req, context as C));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  };
}
