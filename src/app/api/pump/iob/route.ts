import { NextResponse } from "next/server";
import { getTreatments, getProfile } from "@/lib/nightscout";
import { requireApiAuth } from "@/lib/api-auth";
import { calculateIOB, calculateCOB } from "@/lib/prediction/physiological-model";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  try {
    // Fetch treatments (6h) and pump profile concurrently
    const [treatments, profiles] = await Promise.all([
      getTreatments(200, 6 * 60 * 60 * 1000), // last 6h, generous count
      getProfile(),
    ]);

    const now = Date.now();
    const profile = profiles[0]; // use the first (active) profile

    if (!profile) {
      return NextResponse.json(
        { error: "No pump profile found" },
        { status: 502 }
      );
    }

    const iob = calculateIOB(treatments, profile, now);
    const cob = calculateCOB(treatments, now);

    // Round for display
    const iobRounded = Math.round(iob * 10) / 10;
    const cobRounded = Math.round(cob);

    return NextResponse.json({
      iob: iobRounded,
      cob: cobRounded,
      iobDisplay: `${iobRounded} u`,
      cobDisplay: `${cobRounded} g`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
