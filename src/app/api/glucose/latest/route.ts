import { NextResponse } from "next/server";
import { getEntries, getLastPumpUpdate } from "@/lib/nightscout";
import { requireApiAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  try {
    const [entries, lastPump] = await Promise.all([
      getEntries(2), // Fetch 2 to compute delta
      getLastPumpUpdate(),
    ]);

    const entry = entries[0];
    if (!entry) {
      return NextResponse.json({ error: "No data" }, { status: 404 });
    }

    // Compute delta from previous reading
    const delta = entries.length >= 2 ? entry.sgv - entries[1].sgv : null;

    const pumpStaleMinutes = lastPump
      ? Math.round((Date.now() - lastPump.getTime()) / 60_000)
      : null;

    return NextResponse.json({
      ...entry,
      delta,
      pumpLastUpdate: lastPump?.toISOString() ?? null,
      pumpStaleMinutes,
      pumpIsStale: pumpStaleMinutes !== null && pumpStaleMinutes > 360,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
