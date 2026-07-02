import { NextResponse } from "next/server";
import { getTreatments, getProfile } from "@/lib/nightscout";
import { calculateIOB, calculateCOB } from "@/lib/prediction/physiological-model";
import { requireApiAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  try {
    // Fetch treatments (6h for IOB since DIA ~4-5h, 4h for COB)
    const [treatments, profiles] = await Promise.all([
      getTreatments(5000, 6 * 60 * 60 * 1000),
      getProfile(),
    ]);

    const now = Date.now();

    // Calculate IOB using the Maksimovic exponential insulin model
    const iob = profiles.length > 0
      ? calculateIOB(treatments, profiles[0], now)
      : 0;

    // Calculate COB using parabolic absorption
    const cob = calculateCOB(treatments, now);

    return NextResponse.json({
      iob: Math.round(iob * 100) / 100,
      cob: Math.round(cob * 10) / 10,
      iobFormatted: iob < 0.05 ? "0u" : `${(Math.round(iob * 10) / 10).toFixed(1)}u`,
      cobFormatted: cob < 0.5 ? "0g" : `${Math.round(cob)}g`,
      timestamp: new Date(now).toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
