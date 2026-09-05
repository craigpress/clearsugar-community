// ClearSugar — Physiological glucose prediction model
// Forward simulation using rate of change, IOB decay, COB absorption, and ISF

import type { GlucoseReading, Treatment, PumpProfile } from "../types";
import { GLUCOSE_RANGES } from "../types";
import type { PredictionPoint, PredictionHorizon } from "./types";
import type { InferredRescueCarb } from "./rescue-carb-detector";
import { calculateInferredCOB } from "./rescue-carb-detector";

const FIVE_MIN_MS = 5 * 60_000;

// ── Dynamic ISF (Autosens) ──
// Compares actual glucose changes over the last 8 hours against what the
// pump profile's ISF would predict, given the insulin delivered. This gives
// a sensitivity ratio: >1 means more sensitive than profile, <1 means more
// resistant. Clamped to 0.5–1.5 to prevent extreme values.
//
// Based on OpenAPS autosens: https://openaps.readthedocs.io/en/latest/docs/Customize-Iterate/autosens.html

export function calculateAutosens(
  readings: GlucoseReading[],
  treatments: Treatment[],
  profile: PumpProfile
): number {
  const active = getActiveProfile(profile);
  const diaHours = typeof active.dia === "string" ? parseFloat(active.dia) : active.dia;
  const diaMinutes = diaHours * 60;

  const sorted = [...readings].sort((a, b) => a.date - b.date);
  if (sorted.length < 24) return 1; // need at least 2h of data

  const now = sorted[sorted.length - 1].date;
  const windowStart = now - 8 * 3_600_000; // look back 8 hours

  // Collect 30-min segments where we can compare actual vs expected BG change
  const ratios: number[] = [];

  for (let i = 6; i < sorted.length; i++) {
    const current = sorted[i];
    if (current.date < windowStart) continue;

    // Find a reading ~30 min earlier
    const targetTime = current.date - 30 * 60_000;
    let prev: GlucoseReading | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const dt = Math.abs(sorted[j].date - targetTime);
      if (dt < 5 * 60_000) { // within 5 min of target
        prev = sorted[j];
        break;
      }
      if (sorted[j].date < targetTime - 5 * 60_000) break;
    }
    if (!prev) continue;

    const actualDelta = current.sgv - prev.sgv;
    const midTime = (current.date + prev.date) / 2;

    // Calculate expected delta from IOB change in this period
    const iobStart = calculateIOBForAutosens(treatments, diaMinutes, prev.date);
    const iobEnd = calculateIOBForAutosens(treatments, diaMinutes, current.date);
    const insulinAbsorbed = iobStart - iobEnd;

    if (Math.abs(insulinAbsorbed) < 0.05) continue; // skip periods with negligible insulin activity

    const profileISF = getScheduledValue(active.sens, midTime);
    const expectedDelta = -insulinAbsorbed * profileISF; // insulin lowers BG

    // Skip if expected change is tiny (avoid division by near-zero)
    if (Math.abs(expectedDelta) < 3) continue;

    // Ratio: how much did BG actually move vs what ISF predicted?
    // If actual drop was bigger than expected, patient is more sensitive (ratio > 1)
    const ratio = expectedDelta !== 0 ? actualDelta / expectedDelta : 1;

    // Only include reasonable ratios (filter outliers from meals etc)
    if (ratio > 0.2 && ratio < 3.0) {
      ratios.push(ratio);
    }
  }

  if (ratios.length < 3) return 1; // insufficient data

  // Use median to be robust against meal spikes
  ratios.sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];

  // Clamp to 0.5–1.5 (50% to 150% of profile sensitivity)
  return Math.max(0.5, Math.min(1.5, median));
}

// Simplified IOB for autosens — avoids circular dependency with full calculateIOB
export function calculateIOBForAutosens(
  treatments: Treatment[],
  diaMinutes: number,
  atTime: number
): number {
  let iob = 0;
  for (const t of treatments) {
    if (t.insulin && t.insulin > 0) {
      const age = (atTime - treatmentTime(t)) / 60_000;
      if (age >= 0 && age < diaMinutes) {
        iob += t.insulin * iobCurvePercent(age, diaMinutes);
      }
    }
  }
  return Math.max(0, iob);
}

// ── Helpers ──

function treatmentTime(t: Treatment): number {
  return t.mills || new Date(t.created_at).getTime();
}

/** Get the active profile store entry */
function getActiveProfile(profile: PumpProfile) {
  const name = profile.defaultProfile;
  return profile.store[name];
}

/** Re-exported for hypo-risk.ts, so the two curves cannot disagree about which
 *  profile segment or ISF they are using. Same function, no behaviour change. */
export const getActiveProfileFor = getActiveProfile;

/** Look up a time-scheduled value (ISF, CR, basal) for a given timestamp */
function getScheduledValue(
  schedule: { time: string; value: number; timeAsSeconds: number }[],
  atTime: number
): number {
  if (schedule.length === 0) return 0;
  const d = new Date(atTime);
  const secondsOfDay = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  let value = schedule[0].value;
  for (const entry of schedule) {
    if (entry.timeAsSeconds <= secondsOfDay) {
      value = entry.value;
    } else {
      break;
    }
  }
  return value;
}

/** Re-exported for hypo-risk.ts — see getActiveProfileFor. */
export const getScheduledValueAt = getScheduledValue;

// ── IOB Calculation ──
// Maksimovic exponential insulin model — the standard used by OpenAPS, Loop, and Tidepool.
// Source: https://github.com/LoopKit/Loop/issues/388#issuecomment-317938473
// Also used in OpenAPS oref0: https://github.com/openaps/oref0/blob/master/lib/iob/calculate.js
// Parameters: td = DIA in minutes, tp = time of peak activity (75 min for rapid-acting)

// 10-minute delay before insulin starts acting (matches Loop).
// Insulin is delivered subcutaneously and takes time to reach bloodstream.
const INSULIN_DELAY_MIN = 10;

function iobCurvePercent(minutesAge: number, diaMinutes: number): number {
  // Apply 10-minute delay: insulin hasn't started acting yet
  const effectiveAge = minutesAge - INSULIN_DELAY_MIN;
  if (effectiveAge <= 0) return 1; // still in delay period, 100% remaining
  if (minutesAge >= diaMinutes) return 0;

  const td = diaMinutes - INSULIN_DELAY_MIN; // effective duration after delay
  const tp = 75 - INSULIN_DELAY_MIN; // shift peak by delay
  const t = effectiveAge;

  const tau = tp * (1 - tp / td) / (1 - 2 * tp / td);
  const a = 2 * tau / td;
  const S = 1 / (1 - a + (1 + a) * Math.exp(-td / tau));

  // IOB = fraction of insulin remaining
  const iob =
    1 -
    S *
      (1 - a) *
      ((t * t / (tau * td * (1 - a)) - t / tau - 1) * Math.exp(-t / tau) + 1);

  return Math.max(0, Math.min(1, iob));
}

/** Calculate insulin on board at a given time.
 *
 * Matches Control-IQ behavior: includes ALL insulin delivery —
 * user boluses, auto-corrections, and basal deviations above/below
 * scheduled rate. Uses the Maksimovic exponential decay curve.
 *
 * Source: Tandem support confirms Control-IQ IOB includes auto-corrections
 * and basal deviations for dosing decisions.
 */
export function calculateIOB(
  treatments: Treatment[],
  profile: PumpProfile,
  atTime: number
): number {
  const active = getActiveProfile(profile);
  const diaHours = typeof active.dia === "string" ? parseFloat(active.dia) : active.dia;
  const diaMinutes = diaHours * 60;

  let iob = 0;

  for (const t of treatments) {
    // Boluses (includes user boluses + auto-corrections from Control-IQ)
    if (t.insulin && t.insulin > 0) {
      const age = (atTime - treatmentTime(t)) / 60_000;
      if (age >= 0 && age < diaMinutes) {
        iob += t.insulin * iobCurvePercent(age, diaMinutes);
      }
    }

    // Temp basals — count the delta above/below scheduled rate
    // Control-IQ includes this in its IOB calculation
    if (
      t.eventType === "Temp Basal" &&
      t.duration &&
      t.duration > 0 &&
      (t.rate !== undefined || t.absolute !== undefined)
    ) {
      const startTime = treatmentTime(t);
      const endTime = startTime + t.duration * 60_000;
      const rate = t.absolute ?? t.rate ?? 0;
      const scheduledBasal = getScheduledValue(active.basal, startTime);
      const deltaRate = rate - scheduledBasal; // units/hr above(+) or below(-) scheduled

      // Only process if this temp basal is within the DIA window
      if (deltaRate !== 0 && startTime < atTime && endTime > atTime - diaMinutes * 60_000) {
        // Calculate the extra (or reduced) insulin delivered during the overlap period
        const overlapStart = Math.max(startTime, atTime - diaMinutes * 60_000);
        const overlapEnd = Math.min(endTime, atTime);
        const durationHrs = (overlapEnd - overlapStart) / 3_600_000;
        const extraInsulin = deltaRate * durationHrs;
        const avgAge = (atTime - (overlapStart + overlapEnd) / 2) / 60_000;
        iob += extraInsulin * iobCurvePercent(avgAge, diaMinutes);
      }
    }
  }

  return Math.max(0, iob);
}

// ── COB Calculation ──
// Hermite S-curve absorption over a 180-min window (must match the Python
// calculate_cob in scripts/train-model.py, scripts/cs_features.py and
// carb_absorption_percent/calc_cob in scripts/cs_physio.py).

/** Default Hermite absorption span in minutes. */
export const CARB_ABSORPTION_SPAN_MIN = 180;

/** Safety window for a given absorption span: never below the historical 4h. */
export function carbSafetyWindowMin(
  spanMinutes: number = CARB_ABSORPTION_SPAN_MIN
): number {
  return Math.max(240, spanMinutes + 60);
}

/**
 * Resolve a treatment's absorption span: Nightscout's `absorptionTime` when it
 * is a positive finite number, else the 180-min default.
 */
export function treatmentCarbSpan(t: Treatment): number {
  const a = t.absorptionTime;
  return typeof a === "number" && Number.isFinite(a) && a > 0
    ? a
    : CARB_ABSORPTION_SPAN_MIN;
}

/** Only repeated copies of the same Nightscout document are duplicates.
 * Similar amounts and nearby timestamps cannot identify an eating event. */
export function dedupeCarbTreatments(treatments: Treatment[]): Treatment[] {
  const seen = new Set<string>();
  const kept = treatments.filter(t => {
    if (!(t.carbs && t.carbs > 0) || !t._id) return true;
    if (seen.has(t._id)) return false;
    seen.add(t._id);
    return true;
  });
  return kept.length === treatments.length ? treatments : kept;
}

export function carbAbsorptionPercent(
  minutesAge: number,
  spanMinutes: number = CARB_ABSORPTION_SPAN_MIN
): number {
  if (minutesAge <= 0) return 0;
  if (minutesAge >= carbSafetyWindowMin(spanMinutes)) return 1; // fully absorbed by the safety window
  // Hermite smoothstep (3s² - 2s³) over the first `spanMinutes`, then fully absorbed.
  // At the 180-min default, fraction absorbed: ~7% at 30 min, ~26% at 60 min,
  // ~74% at 120 min, 100% by 180 min. (Not a 50%-at-60-min curve — it is
  // back-loaded.) The span only rescales time; the curve shape is unchanged.
  const shifted = Math.min(1, minutesAge / spanMinutes); // 0..1 over the absorption span
  return shifted * shifted * (3 - 2 * shifted);
}

/** Calculate carbs on board at a given time */
export function calculateCOB(
  treatments: Treatment[],
  atTime: number
): number {
  let cob = 0;

  for (const t of dedupeCarbTreatments(treatments)) {
    if (t.carbs && t.carbs > 0) {
      const span = treatmentCarbSpan(t);
      const window = carbSafetyWindowMin(span);
      const age = (atTime - treatmentTime(t)) / 60_000; // minutes
      if (age >= 0 && age < window) {
        // ≥ 4h window for safety
        const absorbed = t.carbs * carbAbsorptionPercent(age, span);
        cob += t.carbs - absorbed;
      }
    }
  }

  return Math.max(0, cob);
}

// ── Rate of Change ──

/** Estimate glucose rate of change from recent readings (mg/dL per 5 min) */
export function estimateRateOfChange(
  readings: GlucoseReading[],
  windowMinutes: number = 15
): number {
  if (readings.length < 2) return 0;

  // Sort newest first (should already be, but be safe)
  const sorted = [...readings].sort((a, b) => b.date - a.date);
  const now = sorted[0].date;
  const cutoff = now - windowMinutes * 60_000;

  // Get readings within window
  const windowReadings = sorted.filter((r) => r.date >= cutoff);
  if (windowReadings.length < 2) return 0;

  // Simple linear regression for robustness against noise
  const n = windowReadings.length;
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0;
  for (const r of windowReadings) {
    const x = (r.date - now) / 60_000; // minutes relative to now (negative)
    const y = r.sgv;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;

  const slope = (n * sumXY - sumX * sumY) / denom; // mg/dL per minute
  return slope * 5; // convert to mg/dL per 5 minutes
}

// ── Forward Simulation ──

export interface PhysiologicalPrediction {
  points: PredictionPoint[];
  iob: number;
  cob: number;
}

/**
 * Predict glucose trajectory using physiological model.
 *
 * Combines:
 * 1. Current rate of change (momentum from CGM trend)
 * 2. IOB decay effect (insulin lowers glucose via ISF)
 * 3. COB absorption effect (carbs raise glucose via CR)
 */
export function predictPhysiological(
  readings: GlucoseReading[],
  treatments: Treatment[],
  profile: PumpProfile,
  horizon: PredictionHorizon,
  rescueCarbs: InferredRescueCarb[] = []
): PhysiologicalPrediction {
  if (readings.length < 2) {
    return { points: [], iob: 0, cob: 0 };
  }

  const sorted = [...readings].sort((a, b) => b.date - a.date);
  const latest = sorted[0];
  const now = latest.date;
  const active = getActiveProfile(profile);

  // Ignore low-confidence inferred rescue carbs: those are usually ordinary CGM
  // wiggle (a small bounce above ~85 mg/dL), and consuming them fabricates a
  // sharp fake rise in the forecast. Only medium/high-confidence rescues feed
  // the prediction.
  const usableRescue = rescueCarbs.filter((r) => r.confidence !== "low");

  // Current state
  const roc = estimateRateOfChange(readings);
  const currentIOB = calculateIOB(treatments, profile, now);
  const currentCOB = calculateCOB(treatments, now);

  // Dynamic ISF — adjust profile ISF based on recent actual sensitivity.
  // autosensRatio > 1 means more sensitive (insulin works harder),
  // < 1 means more resistant (insulin works less).
  const autosensRatio = calculateAutosens(readings, treatments, profile);

  // ── Momentum / absorption reconciliation (Loop/oref0-style) ──
  // The observed ROC already contains the current insulin- and carb-driven
  // rates. Carrying raw ROC forward AND re-adding the modeled IOB/COB effects
  // double-counts them — the source of the upside overshoot (e.g. predicting a
  // +35 rise with insulin on board). Instead we:
  //   1. Scale modeled carb absorption toward what the CGM actually shows.
  //      Never above 1 (don't invent absorption); floored at 0.25 so a real
  //      meal still in its absorption-delay phase isn't zeroed out.
  //   2. Carry forward only the residual "deviation" ROC the scaled model does
  //      NOT explain. At step 1 this reproduces the observed trend; over the
  //      horizon it decays and the physiological model takes over.
  const isfNow = getScheduledValue(active.sens, now) * autosensRatio;
  const crNow = getScheduledValue(active.carbratio, now);

  const insulinImpulseNow =
    -(calculateIOB(treatments, profile, now - FIVE_MIN_MS) -
      calculateIOB(treatments, profile, now)) * isfNow; // <= 0 (insulin lowers)

  let carbImpulseNow =
    crNow > 0
      ? ((calculateCOB(treatments, now - FIVE_MIN_MS) -
          calculateCOB(treatments, now)) / crNow) * isfNow
      : 0;
  if (usableRescue.length > 0 && crNow > 0) {
    carbImpulseNow +=
      ((calculateInferredCOB(usableRescue, now - FIVE_MIN_MS) -
        calculateInferredCOB(usableRescue, now)) / crNow) * isfNow;
  }

  // What the CGM's actual momentum attributes to carbs (ROC minus known insulin).
  const observedCarbImpulse = roc - insulinImpulseNow;
  const absorptionScale =
    carbImpulseNow > 1
      ? Math.max(0.25, Math.min(1, observedCarbImpulse / carbImpulseNow))
      : 1;

  // Residual momentum not explained by the (scaled) physiological model.
  const deviation = roc - (insulinImpulseNow + carbImpulseNow * absorptionScale);

  const steps = horizon / 5;
  const points: PredictionPoint[] = [];
  let prevSgv = latest.sgv;

  // Confidence band parameters — widen over time
  // Base uncertainty from recent glucose variability
  const recentValues = sorted.slice(0, 6).map((r) => r.sgv); // last 30 min
  const recentMean =
    recentValues.reduce((s, v) => s + v, 0) / recentValues.length;
  const recentStd = Math.sqrt(
    recentValues.reduce((s, v) => s + (v - recentMean) ** 2, 0) /
      recentValues.length
  );
  const baseUncertainty = Math.max(recentStd, 5); // minimum 5 mg/dL

  // Determine if BG is currently rising (for asymmetric momentum decay)
  const isRising = roc > 0.5; // > 0.5 mg/dL per 5 min = meaningful upward trend

  for (let step = 1; step <= steps; step++) {
    const futureTime = now + step * FIVE_MIN_MS;

    // 1. Momentum — rate of change carries forward with ASYMMETRIC decay.
    //
    // Rising momentum decays FASTER than falling momentum because:
    // - Meal-driven rises peak and plateau (carb absorption is finite)
    // - Control-IQ actively corrects highs with auto-boluses
    // - Without this, predictions overshoot on rapid rises
    //
    // Falling momentum uses softer decay because:
    // - Insulin action is sustained (IOB effect is modeled separately)
    // - Rescue carbs cause sudden reversals (handled by rescue COB below)
    //
    // Rising: ~50% at 5 steps (25 min), ~20% at 10 steps (50 min)
    // Falling: ~80% at 6 steps (30 min), ~50% at 15 steps (75 min) [original]
    const rocDecay = isRising
      ? Math.exp(-step * 0.14)  // faster decay when rising
      : Math.exp(-step * 0.045); // original gentle decay when falling
    const momentumDelta = deviation * rocDecay;

    // 2. IOB effect — insulin still working lowers glucose
    const iobNow = calculateIOB(treatments, profile, futureTime);
    const iobPrev = calculateIOB(
      treatments,
      profile,
      futureTime - FIVE_MIN_MS
    );
    const insulinAbsorbed = iobPrev - iobNow; // units absorbed in this 5-min step
    // Apply dynamic ISF: profile ISF adjusted by autosens ratio.
    // Higher ratio = more sensitive = stronger insulin effect.
    const profileISF = getScheduledValue(active.sens, futureTime);
    const isf = profileISF * autosensRatio;
    const iobEffect = -insulinAbsorbed * isf; // negative = glucose drops

    // 3. COB effect — logged carbs absorbing raises glucose
    const cobNow = calculateCOB(treatments, futureTime);
    const cobPrev = calculateCOB(treatments, futureTime - FIVE_MIN_MS);
    const carbsAbsorbed = cobPrev - cobNow; // grams absorbed in this 5-min step
    const cr = getScheduledValue(active.carbratio, futureTime);
    // Scale by the observed-vs-modeled absorption ratio (see reconciliation above)
    const cobEffect = cr > 0 ? (carbsAbsorbed / cr) * isf * absorptionScale : 0; // positive = glucose rises

    // 4. Inferred rescue carb effect — unlogged fast-sugar corrections
    // Uses a faster absorption curve (30 min vs 4h for food)
    let rescueCobEffect = 0;
    if (usableRescue.length > 0) {
      const rescueCobNow = calculateInferredCOB(usableRescue, futureTime);
      const rescueCobPrev = calculateInferredCOB(usableRescue, futureTime - FIVE_MIN_MS);
      const rescueCarbsAbsorbed = rescueCobPrev - rescueCobNow;
      rescueCobEffect = cr > 0 ? (rescueCarbsAbsorbed / cr) * isf * absorptionScale : 0;
    }

    // Combine effects
    const delta = momentumDelta + iobEffect + cobEffect + rescueCobEffect;
    const predicted = Math.round(
      Math.max(39, Math.min(401, prevSgv + delta))
    );

    // Confidence band — widens with time
    // Wider bands when rescue carbs are inferred (less certain about exact grams)
    const rescueUncertaintyBoost = rescueCarbs.length > 0 ? 1.3 : 1.0;
    const uncertaintyMultiplier = Math.sqrt(step) * rescueUncertaintyBoost;
    const band = baseUncertainty * uncertaintyMultiplier;
    const confidenceLow = Math.round(Math.max(39, predicted - band));
    const confidenceHigh = Math.round(Math.min(401, predicted + band));

    points.push({
      timestamp: futureTime,
      sgv: predicted,
      confidence: { low: confidenceLow, high: confidenceHigh },
    });

    prevSgv = predicted;
  }

  return {
    points,
    iob: Math.round(currentIOB * 100) / 100,
    cob: Math.round(currentCOB),
  };
}
