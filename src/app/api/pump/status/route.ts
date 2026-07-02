import { NextResponse } from "next/server";
import { getTreatments, getLastPumpUpdate } from "@/lib/nightscout";
import { requireApiAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  try {
    // Get recent treatments — need enough to not be crowded out by temp basals
    // Control-IQ creates ~12 temp basals/hour, so 6h = ~72 basals alone
    const treatments = await getTreatments(500, 6 * 60 * 60 * 1000); // last 6h
    const lastPump = await getLastPumpUpdate();

    // Find latest temp basal from Control-IQ
    const latestBasal = treatments.find(
      (t) => t.eventType === "Temp Basal" && t.reason === "Algorithm"
    );

    // Count boluses in last 6 hours
    const boluses = treatments.filter(
      (t) => t.insulin !== null && t.insulin !== undefined && t.insulin > 0
    );
    const totalBolus = boluses.reduce((sum, b) => sum + (b.insulin || 0), 0);

    // Count carbs in last 6 hours
    const carbs = treatments.filter(
      (t) => t.carbs !== null && t.carbs !== undefined && t.carbs > 0
    );
    const totalCarbs = carbs.reduce((sum, c) => sum + (c.carbs || 0), 0);

    const pumpStaleMinutes = lastPump
      ? Math.round((Date.now() - lastPump.getTime()) / 60_000)
      : null;

    return NextResponse.json({
      currentBasalRate: latestBasal?.rate ?? null,
      lastBasalTime: latestBasal?.created_at ?? null,
      boluses: {
        count: boluses.length,
        totalUnits: Math.round(totalBolus * 100) / 100,
        last: boluses[0] ?? null,
      },
      carbs: {
        count: carbs.length,
        totalGrams: totalCarbs,
        last: carbs[0] ?? null,
      },
      lastPumpUpdate: lastPump?.toISOString() ?? null,
      pumpStaleMinutes,
      pumpIsStale: pumpStaleMinutes !== null && pumpStaleMinutes > 30,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
