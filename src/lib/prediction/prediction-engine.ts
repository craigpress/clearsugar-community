// ClearSugar — Prediction engine orchestrator
// Runs selected model(s), detects alerts, returns unified PredictionResult

import type { GlucoseReading, Treatment, PumpProfile } from "../types";
import { GLUCOSE_RANGES } from "../types";
import type { AGPSlot } from "../trends";
import type { SiteChange } from "../insulin-analysis";
import type {
  PredictionResult,
  PredictionPoint,
  PredictiveAlert,
  PredictionModel,
  PredictionHorizon,
  PredictionSettings,
} from "./types";
import { predictPhysiological, estimateRateOfChange } from "./physiological-model";
import { extractFeatures } from "./feature-engine";
import { ML_FEATURE_NAMES } from "./types";
import { detectRescueCarbs, type InferredRescueCarb } from "./rescue-carb-detector";

/** Generate predictions using the configured model */
export async function generatePrediction(
  readings: GlucoseReading[],
  treatments: Treatment[],
  profile: PumpProfile,
  agpSlots: AGPSlot[],
  siteChanges: SiteChange[],
  observedISF: number | null,
  settings: PredictionSettings
): Promise<PredictionResult | null> {
  if (readings.length < 3) return null;

  const sorted = [...readings].sort((a, b) => b.date - a.date);
  const latest = sorted[0];
  const staleness = Date.now() - latest.date;

  // Don't predict from stale data (>15 min old)
  if (staleness > 15 * 60_000) return null;

  const { activeModel, horizon } = settings;

  // Detect unlogged rescue carbs from the glucose trace
  const rescueCarbs = detectRescueCarbs(readings, treatments, profile);

  // Detect rapid rise for blending weight adjustment
  const roc = estimateRateOfChange(readings);
  const isRapidRise = roc > 2.0; // > 2 mg/dL per 5 min = meaningful rapid rise

  let points: PredictionPoint[];
  let iob: number;
  let cob: number;
  let model: PredictionModel = activeModel;

  if (activeModel === "physiological" || activeModel === "ensemble") {
    const physResult = predictPhysiological(
      readings,
      treatments,
      profile,
      horizon,
      rescueCarbs
    );
    points = physResult.points;
    iob = physResult.iob;
    cob = physResult.cob;

    if (activeModel === "ensemble") {
      // Phase 4: blend with ML model
      // For now, fall back to physiological only
      const mlPoints = await tryMLPrediction(
        readings,
        treatments,
        profile,
        agpSlots,
        siteChanges,
        observedISF,
        horizon
      );
      if (mlPoints) {
        points = blendPredictions(points, mlPoints, horizon, isRapidRise);
        model = "ensemble";
      } else {
        model = "physiological"; // ML unavailable, silent fallback
      }
    }
  } else {
    // ML only
    const mlPoints = await tryMLPrediction(
      readings,
      treatments,
      profile,
      agpSlots,
      siteChanges,
      observedISF,
      horizon
    );
    if (mlPoints) {
      points = mlPoints;
    } else {
      // Fall back to physiological if ML unavailable
      const physResult = predictPhysiological(
        readings,
        treatments,
        profile,
        horizon,
        rescueCarbs
      );
      points = physResult.points;
      model = "physiological";
    }
    // Still need IOB/COB for display
    const physResult = predictPhysiological(
      readings,
      treatments,
      profile,
      horizon,
      rescueCarbs
    );
    iob = physResult.iob;
    cob = physResult.cob;
  }

  // Detect alerts
  const alerts = detectAlerts(points, settings);

  return {
    model,
    horizon,
    points,
    generatedAt: Date.now(),
    staleness,
    iob: iob!,
    cob: cob!,
    alerts,
  };
}

/** Attempt ML prediction via server-side multi-point API */
async function tryMLPrediction(
  readings: GlucoseReading[],
  treatments: Treatment[],
  profile: PumpProfile,
  agpSlots: AGPSlot[],
  siteChanges: SiteChange[],
  observedISF: number | null,
  horizon: PredictionHorizon
): Promise<PredictionPoint[] | null> {
  try {
    const featureObj = extractFeatures(
      readings,
      treatments,
      profile,
      agpSlots,
      siteChanges,
      observedISF
    );

    const featureArray = ML_FEATURE_NAMES.map((name) => featureObj[name] as number);

    const res = await fetch("/api/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ features: featureArray, horizon }),
    });

    if (!res.ok) return null;
    const result = await res.json();

    if (!result.points || !Array.isArray(result.points)) return null;

    const sorted = [...readings].sort((a, b) => b.date - a.date);
    const currentTime = sorted[0].date;

    return result.points.map((p: { offset: number; predicted: number; low: number; high: number }) => ({
      timestamp: currentTime + p.offset * 60_000,
      sgv: p.predicted,
      confidence: { low: p.low, high: p.high },
    }));
  } catch {
    return null;
  }
}

/** Blend physiological and ML predictions with horizon-dependent weights.
 *
 * When the physiological model detects a rapid rise, we shift weight toward
 * ML at all horizons — the ML model has learned that rapid rises typically
 * plateau or reverse, while the physio model's momentum term overshoots.
 */
function blendPredictions(
  physPoints: PredictionPoint[],
  mlPoints: PredictionPoint[],
  horizon: PredictionHorizon,
  isRapidRise: boolean = false
): PredictionPoint[] {
  // Base weights: ML weighted more at longer horizons
  let mlWeight =
    horizon === 15 ? 0.4 : horizon === 30 ? 0.6 : horizon === 60 ? 0.7 : 0.8;

  // During rapid rises, boost ML weight to counteract physio momentum overshoot.
  // ML has learned from historical data that rises plateau — trust it more.
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
        low: Math.round(
          Math.max(39, phys.confidence.low * physWeight + ml.confidence.low * mlWeight)
        ),
        high: Math.round(
          Math.min(401, phys.confidence.high * physWeight + ml.confidence.high * mlWeight)
        ),
      },
    };
  });
}

/** Detect predictive alerts from prediction points */
function detectAlerts(
  points: PredictionPoint[],
  settings: PredictionSettings
): PredictiveAlert[] {
  const alerts: PredictiveAlert[] = [];
  const { notifications } = settings;
  const minutesAhead = notifications.minutesAhead || settings.horizon;

  for (const point of points) {
    const minutesUntil = Math.round(
      (point.timestamp - Date.now()) / 60_000
    );
    if (minutesUntil < 0) continue; // skip points already in the past
    if (minutesUntil > minutesAhead) break;

    // Predicted low — fire off the q10 LOWER band, not the point estimate.
    // Point predictions rarely commit to a low (they regress to the median), so
    // alerting on the lower confidence band catches impending lows the point
    // estimate misses. Asymmetric on purpose: better to over-warn a low.
    const lowerBand = point.confidence?.low ?? point.sgv;
    if (lowerBand < notifications.predictedLowThreshold) {
      const severity =
        lowerBand < GLUCOSE_RANGES.URGENT_LOW ? "urgent" : "warning";
      // Only add if we haven't already detected this type
      if (!alerts.some((a) => a.type === "low")) {
        alerts.push({
          type: "low",
          predictedSgv: point.sgv,
          minutesUntil,
          severity,
        });
      }
    }

    // Predicted high
    if (point.sgv > notifications.predictedHighThreshold) {
      const severity =
        point.sgv > GLUCOSE_RANGES.URGENT_HIGH ? "urgent" : "warning";
      if (!alerts.some((a) => a.type === "high")) {
        alerts.push({
          type: "high",
          predictedSgv: point.sgv,
          minutesUntil,
          severity,
        });
      }
    }
  }

  return alerts;
}
