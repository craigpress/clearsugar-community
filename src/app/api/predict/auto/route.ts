import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getEntries, getTreatments, getProfile } from "@/lib/nightscout";
import { extractFeatures } from "@/lib/prediction/feature-engine";
import { ML_FEATURE_NAMES } from "@/lib/prediction/types";
import { predictPhysiological, estimateRateOfChange } from "@/lib/prediction/physiological-model";
import { detectRescueCarbs } from "@/lib/prediction/rescue-carb-detector";
import { computeAGP } from "@/lib/trends";
import { extractSiteChanges } from "@/lib/insulin-analysis";
import type { PredictionPoint, PredictionHorizon } from "@/lib/prediction/types";

export const dynamic = "force-dynamic";

const PREDICT_URL = process.env.CLEARSUGAR_PREDICT_URL;
const PREDICT_TOKEN = process.env.CLEARSUGAR_PREDICT_TOKEN || "";

/**
 * Blend physiological and ML predictions with horizon-dependent weights.
 * During rapid rises, shift weight toward ML — it has learned that
 * rapid rises typically plateau, while physio momentum overshoots.
 */
function blendPredictions(
  physPoints: PredictionPoint[],
  mlPoints: PredictionPoint[],
  horizon: PredictionHorizon,
  isRapidRise: boolean
): PredictionPoint[] {
  let mlWeight =
    horizon === 15 ? 0.4 : horizon === 30 ? 0.6 : horizon === 60 ? 0.7 : 0.8;

  if (isRapidRise) {
    mlWeight = Math.min(0.9, mlWeight + 0.2);
  }
  const physWeight = 1 - mlWeight;

  return physPoints.map((phys, i) => {
    const ml = mlPoints[i];
    if (!ml) return phys;

    const sgv = Math.round(phys.sgv * physWeight + ml.sgv * mlWeight);
    return {
      timestamp: phys.timestamp,
      sgv: Math.max(39, Math.min(401, sgv)),
      confidence: {
        low: Math.round(Math.max(39, phys.confidence.low * physWeight + ml.confidence.low * mlWeight)),
        high: Math.round(Math.min(401, phys.confidence.high * physWeight + ml.confidence.high * mlWeight)),
      },
    };
  });
}

/**
 * GET /api/predict/auto
 *
 * Ensemble prediction endpoint. Runs both physiological and ML models,
 * blends their outputs with horizon-dependent weights.
 * Falls back to physiological-only if ML is unavailable.
 *
 * Query params:
 *   horizon  — prediction horizon in minutes (5-180, default 30)
 *   model    — "ensemble" (default), "ml", or "physiological"
 */
export async function GET(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  try {
    const { searchParams } = new URL(req.url);
    const rawHorizon = parseInt(searchParams.get("horizon") || "30", 10);
    const validHorizons: PredictionHorizon[] = [15, 30, 60, 180];
    const horizon: PredictionHorizon = validHorizons.reduce((best, h) =>
      Math.abs(h - rawHorizon) < Math.abs(best - rawHorizon) ? h : best
    );
    const modelParam = searchParams.get("model") || "ensemble";

    // Fetch glucose (3h), treatments (6h), and profile in parallel
    const threeHoursMs = 3 * 60 * 60 * 1000;
    const sixHoursMs = 6 * 60 * 60 * 1000;

    const [readings, treatments, profiles] = await Promise.all([
      getEntries(36, threeHoursMs),
      getTreatments(500, sixHoursMs),
      getProfile(),
    ]);

    if (readings.length < 3) {
      return NextResponse.json(
        { error: "Insufficient glucose data (need at least 3 readings)" },
        { status: 422 }
      );
    }

    const profile = profiles[0];
    if (!profile) {
      return NextResponse.json(
        { error: "No pump profile found" },
        { status: 422 }
      );
    }

    const rescueCarbs = detectRescueCarbs(readings, treatments, profile);
    const roc = estimateRateOfChange(readings);
    const isRapidRise = roc > 2.0;

    let resultModel = modelParam;
    let finalPoints: { offset: number; predicted: number; low: number; high: number }[];

    // ── Physiological model ──
    const runPhysio = modelParam === "physiological" || modelParam === "ensemble";
    let physPoints: PredictionPoint[] | null = null;

    if (runPhysio) {
      const physResult = predictPhysiological(readings, treatments, profile, horizon, rescueCarbs);
      physPoints = physResult.points;
    }

    // ── ML model (ONNX) ──
    const runML = modelParam === "ml" || modelParam === "ensemble";
    let mlPoints: PredictionPoint[] | null = null;

    if (runML && PREDICT_URL) {
      try {
        const agpSlots = computeAGP(readings);
        const siteChanges = extractSiteChanges(treatments);
        const featureObj = extractFeatures(readings, treatments, profile, agpSlots, siteChanges, null);
        const features = ML_FEATURE_NAMES.map((name) => featureObj[name] as number);

        const res = await fetch(`${PREDICT_URL}/predict`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${PREDICT_TOKEN}`,
          },
          body: JSON.stringify({ features, horizon }),
          signal: AbortSignal.timeout(10000),
        });

        if (res.ok) {
          const data = await res.json();
          if (data.points && Array.isArray(data.points)) {
            const sorted = [...readings].sort((a, b) => b.date - a.date);
            const currentTime = sorted[0].date;
            mlPoints = data.points.map((p: { offset: number; predicted: number; low: number; high: number }) => ({
              timestamp: currentTime + p.offset * 60_000,
              sgv: p.predicted,
              confidence: { low: p.low, high: p.high },
            }));
          }
        }
      } catch (err) {
        // ML unavailable — fall back to physiological, but log so outages aren't silent
        console.error("[predict/auto] ML call failed, using physiological fallback:", err);
      }
    }

    // ── Blend or select ──
    let outputPoints: PredictionPoint[];

    if (modelParam === "ensemble" && physPoints && mlPoints) {
      outputPoints = blendPredictions(physPoints, mlPoints, horizon, isRapidRise);
      resultModel = "ensemble";
    } else if (modelParam === "ensemble" && physPoints) {
      outputPoints = physPoints;
      resultModel = "physiological"; // ML unavailable, silent fallback
    } else if (mlPoints) {
      outputPoints = mlPoints;
      resultModel = "ml";
    } else if (physPoints) {
      outputPoints = physPoints;
      resultModel = "physiological";
    } else {
      return NextResponse.json(
        { error: "No prediction models available" },
        { status: 503 }
      );
    }

    // Convert to API response format
    finalPoints = outputPoints.map((p) => {
      const offset = Math.round((p.timestamp - readings.sort((a, b) => b.date - a.date)[0].date) / 60_000);
      return {
        offset,
        predicted: Math.round(p.sgv),
        low: Math.round(p.confidence.low),
        high: Math.round(p.confidence.high),
      };
    });

    return NextResponse.json({
      points: finalPoints,
      model: resultModel,
      horizon,
      isRapidRise,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Auto-prediction failed: ${message}` },
      { status: 502 }
    );
  }
}
