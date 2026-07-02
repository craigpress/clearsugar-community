import { NextResponse } from "next/server";
import { getProfile } from "@/lib/nightscout";
import { requireApiAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  try {
    const profiles = await getProfile();
    if (!profiles || profiles.length === 0) {
      return NextResponse.json({ error: "No profile found" }, { status: 404 });
    }
    return NextResponse.json(profiles[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
