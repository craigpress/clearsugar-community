import { NextResponse, type NextRequest } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getTreatments } from "@/lib/nightscout";
import type { Treatment } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = await requireApiAuth(request);
  if (denied) return denied;

  const { searchParams } = request.nextUrl;
  const hours = parseInt(searchParams.get("hours") || "3", 10);
  const maxAge = hours * 60 * 60 * 1000;
  const count = parseInt(searchParams.get("count") || "0", 10);

  try {
    // Scale limits by time window to avoid over-fetching
    // 3h = reasonable defaults; longer windows scale proportionally
    const scale = Math.max(1, hours / 3);
    const bolusLimit = count || Math.min(Math.round(200 * scale), 2000);
    const carbLimit = count || Math.min(Math.round(100 * scale), 1000);
    const basalLimit = count || Math.min(Math.round(300 * scale), 3000);

    // Single fetch through the shared Nightscout client (also powers demo
    // mode), then partition by type so Temp Basals can't crowd out rarer
    // events like site changes and sensor starts.
    const fetchLimit = Math.min(bolusLimit + carbLimit + basalLimit + 60, 6000);
    const treatments = await getTreatments(fetchLimit, maxAge);

    const boluses: Treatment[] = [];
    const carbEntries: Treatment[] = [];
    const siteChanges: Treatment[] = [];
    const basals: Treatment[] = [];
    const sensorStarts: Treatment[] = [];
    for (const t of treatments) {
      if ((t.insulin ?? 0) > 0 && boluses.length < bolusLimit) boluses.push(t);
      if ((t.carbs ?? 0) > 0 && carbEntries.length < carbLimit) carbEntries.push(t);
      if (t.eventType === "Site Change" && siteChanges.length < 50) siteChanges.push(t);
      if (t.eventType === "Temp Basal" && basals.length < basalLimit) basals.push(t);
      if (t.eventType === "Sensor Start" && sensorStarts.length < 10) sensorStarts.push(t);
    }

    // Merge and deduplicate by _id
    const seen = new Set<string>();
    const all: Treatment[] = [];
    for (const arr of [boluses, carbEntries, siteChanges, basals, sensorStarts]) {
      for (const t of arr) {
        const id = (t as { _id?: string })._id;
        if (id && !seen.has(id)) {
          seen.add(id);
          all.push(t);
        }
      }
    }

    return NextResponse.json(all, {
      headers: { "Cache-Control": "private, max-age=30" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
