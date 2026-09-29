import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getEntries, getTreatments, getProfile } from "@/lib/nightscout";
import { computeAutoPrediction, PredictionInputError, NoModelError, type PredictionModel } from "@/lib/prediction/auto";
import type { PredictionHorizon } from "@/lib/prediction/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(req.url);
    const rawHorizon = parseInt(searchParams.get("horizon") || "30", 10);
    const validHorizons: PredictionHorizon[] = [15, 30, 60, 180];
    const horizon = validHorizons.reduce((best, h) =>
      Math.abs(h - rawHorizon) < Math.abs(best - rawHorizon) ? h : best);
    const model = (searchParams.get("model") || "ensemble") as PredictionModel;

    const [readings, treatments, profiles] = await Promise.all([
      getEntries(36, 3 * 60 * 60 * 1000),
      getTreatments(500, 6 * 60 * 60 * 1000),
      getProfile(),
    ]);

    const result = await computeAutoPrediction(readings, treatments, profiles, { horizon, model });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof PredictionInputError) return NextResponse.json({ error: err.message }, { status: 422 });
    if (err instanceof NoModelError) return NextResponse.json({ error: err.message }, { status: 503 });
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Auto-prediction failed: ${message}` }, { status: 502 });
  }
}
