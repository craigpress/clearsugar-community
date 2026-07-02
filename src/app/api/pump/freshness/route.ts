import { NextResponse } from "next/server";
import { getLastPumpUpdate } from "@/lib/nightscout";
import { requireApiAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

/** Pump data freshness endpoint — consumed by external monitoring */
export async function GET(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  try {
    const lastUpdate = await getLastPumpUpdate();

    if (!lastUpdate) {
      return NextResponse.json({
        lastUpdate: null,
        staleMinutes: 999,
        isStale: true,
      });
    }

    const staleMinutes = Math.round(
      (Date.now() - lastUpdate.getTime()) / 60_000
    );

    return NextResponse.json({
      lastUpdate: lastUpdate.toISOString(),
      staleMinutes,
      isStale: staleMinutes > 360, // 6 hours
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
