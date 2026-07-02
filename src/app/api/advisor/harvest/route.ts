// ClearSugar — Advisory outcome-harvest timer (Phase 1, P1.6)
//
// Loads fired advisories whose outcome has not yet been harvested and which are
// old enough that the 1–3h window has accumulated data, reads the post-fire
// Nightscout readings + treatments, runs the PURE attributeResolution logic, and
// writes back outcomeTrajectory / resolutionAttribution / harvestedAt.
//
// This route is NOT yet scheduled/wired — it is inert until a systemd timer (or
// equivalent) calls it. Auth + shape match /api/alerts/check exactly (the
// established cron-route pattern for this non-standard Next.js — see AGENTS.md).

import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/api-auth";
import { getEntries, getTreatments } from "@/lib/nightscout";
import {
  loadFeedback,
  saveFeedback,
  attributeResolution,
  HARVEST_HORIZON_MS,
} from "@/lib/prediction/feedback-store";

export const dynamic = "force-dynamic";

/**
 * Minimum age before a record is harvestable. We want most of the resolution
 * window to have elapsed without waiting the full 3h — ~90 min captures the
 * decisive part of a low/high recovery while keeping the label stream fresh.
 */
const MIN_HARVEST_AGE_MS = 90 * 60 * 1000; // ~90 min

/**
 * GET /api/advisor/harvest
 *
 * Protected by CLEARSUGAR_API_KEY. Intended to be polled by a timer; safe to
 * call repeatedly (only un-harvested, ripe records are processed each run).
 */
export async function GET(req: Request) {
  const apiKey = req.headers.get("x-api-key");
  if (!apiKey || !process.env.CLEARSUGAR_API_KEY || !safeEqual(apiKey, process.env.CLEARSUGAR_API_KEY)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const now = Date.now();
    const records = await loadFeedback();

    const ripe = records.filter(
      (r) => r.harvestedAt == null && now - r.firedAt >= MIN_HARVEST_AGE_MS
    );

    if (ripe.length === 0) {
      return NextResponse.json({
        total: records.length,
        ripe: 0,
        harvested: 0,
        attributions: {},
      });
    }

    // Pull a window of readings + treatments wide enough to cover the oldest
    // ripe record's full 3h horizon, plus a little slack for fetch latency.
    const oldestFiredAt = Math.min(...ripe.map((r) => r.firedAt));
    const lookbackMs = now - oldestFiredAt + HARVEST_HORIZON_MS;

    const [readings, treatments] = await Promise.all([
      // ~1 reading / 5 min over the lookback, capped generously.
      getEntries(Math.min(Math.ceil(lookbackMs / 60_000 / 5) + 12, 2000), lookbackMs),
      getTreatments(2000, lookbackMs),
    ]);

    const attributions: Record<string, number> = {};
    let harvested = 0;

    for (const record of records) {
      if (record.harvestedAt != null) continue;
      if (now - record.firedAt < MIN_HARVEST_AGE_MS) continue;

      const { trajectory, attribution } = attributeResolution(
        record,
        readings,
        treatments
      );

      record.outcomeTrajectory = trajectory;
      record.resolutionAttribution = attribution;
      record.harvestedAt = now;

      attributions[attribution] = (attributions[attribution] ?? 0) + 1;
      harvested += 1;
    }

    await saveFeedback(records);

    return NextResponse.json({
      total: records.length,
      ripe: ripe.length,
      harvested,
      attributions,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
