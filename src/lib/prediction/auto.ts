import type { GlucoseReading, PumpProfile, Treatment } from "@/lib/types";
import { extractFeatures } from "@/lib/prediction/feature-engine";
import { ML_FEATURE_NAMES } from "@/lib/prediction/types";
import { predictPhysiological, estimateRateOfChange } from "@/lib/prediction/physiological-model";
import { detectRescueCarbs } from "@/lib/prediction/rescue-carb-detector";
import { computeAGP } from "@/lib/trends";
import { extractSiteChanges } from "@/lib/insulin-analysis";
import type { PredictionPoint, PredictionHorizon } from "@/lib/prediction/types";

const PREDICT_URL = process.env.CLEARSUGAR_PREDICT_URL;
const PREDICT_TOKEN = process.env.CLEARSUGAR_PREDICT_TOKEN || "";

export type PredictionModel = "ensemble" | "ml" | "physiological";
export interface AutoPredictionPoint { offset: number; predicted: number; low: number; high: number }
export interface AutoPredictionResult {
  points: AutoPredictionPoint[];
  model: string;
  horizon: PredictionHorizon;
  isRapidRise: boolean;
}

/** Thrown when inputs cannot produce a prediction (maps to HTTP 422 at the route). */
export class PredictionInputError extends Error {}
/** Thrown when no model can run (maps to HTTP 503). */
export class NoModelError extends Error {}

function blendPredictions(
  physPoints: PredictionPoint[],
  mlPoints: PredictionPoint[],
  horizon: PredictionHorizon,
  isRapidRise: boolean
): PredictionPoint[] {
  let mlWeight = horizon === 15 ? 0.4 : horizon === 30 ? 0.6 : horizon === 60 ? 0.7 : 0.8;
  if (isRapidRise) mlWeight = Math.min(0.9, mlWeight + 0.2);
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
 * Ensemble prediction over ALREADY-FETCHED Nightscout data. Callers fetch
 * readings/treatments/profiles once and pass them in — no internal HTTP.
 */
export async function computeAutoPrediction(
  readings: GlucoseReading[],
  treatments: Treatment[],
  profiles: PumpProfile[],
  opts: { horizon: PredictionHorizon; model: PredictionModel }
): Promise<AutoPredictionResult> {
  const { horizon, model: modelParam } = opts;

  if (readings.length < 3) throw new PredictionInputError("Insufficient glucose data (need at least 3 readings)");
  const profile = profiles[0];
  if (!profile) throw new PredictionInputError("No pump profile found");

  const rescueCarbs = detectRescueCarbs(readings, treatments, profile);
  const roc = estimateRateOfChange(readings);
  const isRapidRise = roc > 2.0;

  let resultModel: string = modelParam;

  const runPhysio = modelParam === "physiological" || modelParam === "ensemble";
  let physPoints: PredictionPoint[] | null = null;
  if (runPhysio) {
    physPoints = predictPhysiological(readings, treatments, profile, horizon, rescueCarbs).points;
  }

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
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${PREDICT_TOKEN}` },
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
      console.error("[predict/auto] ML call failed, using physiological fallback:", err);
    }
  }

  let outputPoints: PredictionPoint[];
  if (modelParam === "ensemble" && physPoints && mlPoints) {
    outputPoints = blendPredictions(physPoints, mlPoints, horizon, isRapidRise);
    resultModel = "ensemble";
  } else if (modelParam === "ensemble" && physPoints) {
    outputPoints = physPoints; resultModel = "physiological";
  } else if (mlPoints) {
    outputPoints = mlPoints; resultModel = "ml";
  } else if (physPoints) {
    outputPoints = physPoints; resultModel = "physiological";
  } else {
    throw new NoModelError("No prediction models available");
  }

  const newest = [...readings].sort((a, b) => b.date - a.date)[0].date;
  const points = outputPoints.map((p) => ({
    offset: Math.round((p.timestamp - newest) / 60_000),
    predicted: Math.round(p.sgv),
    low: Math.round(p.confidence.low),
    high: Math.round(p.confidence.high),
  }));

  return { points, model: resultModel, horizon, isRapidRise };
}
