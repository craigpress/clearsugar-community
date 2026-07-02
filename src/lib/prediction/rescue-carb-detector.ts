// ClearSugar — Inferred rescue carb detection
// Detects unlogged fast-acting sugar corrections from glucose trace patterns.
//
// The signal: BG dropping or already low → sudden reversal upward with no
// logged carbs in the window. The patient (or any user) pops glucose tabs or
// drinks juice without logging it. The model needs to know this happened
// so it doesn't predict continued dropping.
//
// Detection criteria:
//   1. BG was below lowThreshold OR dropping faster than -1 mg/dL/min
//   2. BG reverses upward by at least reversalMinDelta within reversalWindowMin
//   3. No carb treatment logged in the lookback window
//   4. Active IOB exists (rules out spontaneous rise from dawn phenomenon etc.)

import type { GlucoseReading, Treatment, PumpProfile } from "../types";
import { calculateIOB } from "./physiological-model";

export interface InferredRescueCarb {
  /** When the rescue carb was likely consumed (epoch ms) */
  timestamp: number;
  /** Estimated grams of fast-acting carbs (glucose tabs ≈ 4g each, juice box ≈ 15g) */
  estimatedGrams: number;
  /** Detection confidence */
  confidence: "low" | "medium" | "high";
  /** BG at the trough before reversal */
  troughSgv: number;
  /** BG at the peak of the reversal detected so far */
  reversalSgv: number;
  /** Minutes between trough and detection point */
  reversalMinutes: number;
}

// ── Configuration ──

/** BG threshold — if below this, consider the patient "low" */
const LOW_THRESHOLD = 85;

/** Minimum upward reversal to count (mg/dL from trough to current) */
const REVERSAL_MIN_DELTA = 12;

/** How far back to look for the trough (minutes) */
const REVERSAL_WINDOW_MIN = 25;

/** No logged carbs within this window → likely unlogged (minutes) */
const NO_CARB_LOOKBACK_MIN = 30;

/** Minimum rate of drop to qualify even if not below LOW_THRESHOLD (mg/dL/min) */
const FAST_DROP_RATE = -1.0;

/** How far back to scan for rescue events (minutes) */
const SCAN_WINDOW_MIN = 60;

// ── Fast-sugar absorption profile ──
// Glucose tabs and juice absorb much faster than food.
// Peak absorption at ~10 min, ~80% absorbed by 20 min, 100% by 30 min.

function fastCarbAbsorptionPercent(minutesAge: number): number {
  if (minutesAge <= 0) return 0;
  if (minutesAge >= 30) return 1;
  // Fast S-curve peaking around 10 min
  const t = minutesAge / 30;
  // Steeper than food absorption — shifted hermite
  const shifted = Math.min(1, minutesAge / 20);
  return shifted * shifted * (3 - 2 * shifted);
}

/**
 * Estimate grams of fast carbs from the observed glucose rise.
 * Uses a simplified model: rise_mg_dL ≈ grams × (ISF / CR).
 * For a typical ISF=50, CR=10: 1g carbs ≈ 5 mg/dL rise.
 * We use a conservative estimate since we can't know the exact ratio.
 */
function estimateGramsFromRise(riseMgDl: number): number {
  // Conservative: assume 1g fast carb → ~3-5 mg/dL rise
  // Use 4 mg/dL per gram as middle estimate for fast-acting sugar
  const grams = riseMgDl / 4;
  // Clamp to reasonable range (1 tab = 4g, juice box = 15g, typical rescue = 15-30g)
  return Math.round(Math.max(4, Math.min(45, grams)));
}

/**
 * Scan recent glucose history for unlogged rescue carb events.
 *
 * Returns an array of inferred events (usually 0 or 1 in the scan window).
 * Each event includes estimated grams and a confidence level.
 */
export function detectRescueCarbs(
  readings: GlucoseReading[],
  treatments: Treatment[],
  profile: PumpProfile
): InferredRescueCarb[] {
  if (readings.length < 6) return []; // need at least 30 min of data

  const sorted = [...readings].sort((a, b) => a.date - b.date); // oldest first
  const now = sorted[sorted.length - 1].date;
  const scanStart = now - SCAN_WINDOW_MIN * 60_000;

  // Pre-filter: only readings in scan window
  const window = sorted.filter((r) => r.date >= scanStart);
  if (window.length < 4) return [];

  // Pre-compute: carb treatments in the lookback period
  const recentCarbs = treatments.filter(
    (t) =>
      t.carbs &&
      t.carbs > 0 &&
      (t.mills || new Date(t.created_at).getTime()) >= scanStart - NO_CARB_LOOKBACK_MIN * 60_000
  );

  const detected: InferredRescueCarb[] = [];

  // Scan for trough-then-reversal patterns
  for (let i = 2; i < window.length - 2; i++) {
    const candidate = window[i];

    // Is this a local minimum (trough)?
    const prev = window[i - 1];
    const prevPrev = window[i - 2];
    const next = window[i + 1];
    const nextNext = window[i + 2];

    // Trough: readings before were dropping, readings after are rising
    const wasDroppingBefore = prev.sgv >= candidate.sgv && prevPrev.sgv >= prev.sgv;
    const isRisingAfter = next.sgv > candidate.sgv && nextNext.sgv > next.sgv;

    if (!wasDroppingBefore || !isRisingAfter) continue;

    // Check if BG was low enough or dropping fast enough to warrant a rescue
    const dropRate = (candidate.sgv - prevPrev.sgv) /
      ((candidate.date - prevPrev.date) / 60_000); // mg/dL per min

    const wasLow = candidate.sgv < LOW_THRESHOLD;
    const wasDroppingFast = dropRate < FAST_DROP_RATE;

    if (!wasLow && !wasDroppingFast) continue;

    // Find the peak of the reversal (highest point within reversal window after trough)
    const reversalEnd = candidate.date + REVERSAL_WINDOW_MIN * 60_000;
    const reversalReadings = window.filter(
      (r) => r.date > candidate.date && r.date <= reversalEnd
    );

    if (reversalReadings.length === 0) continue;

    const peak = reversalReadings.reduce((best, r) =>
      r.sgv > best.sgv ? r : best
    );
    const riseDelta = peak.sgv - candidate.sgv;

    if (riseDelta < REVERSAL_MIN_DELTA) continue;

    // Check: were any carbs logged near the trough?
    const troughTime = candidate.date;
    const hasLoggedCarbs = recentCarbs.some((t) => {
      const tTime = t.mills || new Date(t.created_at).getTime();
      return Math.abs(tTime - troughTime) < NO_CARB_LOOKBACK_MIN * 60_000;
    });

    if (hasLoggedCarbs) continue; // carbs were logged, not a rescue detection

    // Check: is there active IOB? (Rules out dawn phenomenon, rebound etc.)
    const iob = calculateIOB(treatments, profile, troughTime);
    const hasActiveInsulin = iob > 0.1;

    // Determine confidence
    let confidence: InferredRescueCarb["confidence"];
    if (wasLow && riseDelta >= 20 && hasActiveInsulin) {
      confidence = "high"; // classic rescue: low BG + big reversal + IOB present
    } else if (wasLow || (wasDroppingFast && riseDelta >= 15)) {
      confidence = "medium";
    } else {
      confidence = "low";
    }

    const reversalMinutes = Math.round(
      (peak.date - candidate.date) / 60_000
    );

    detected.push({
      // Estimate the carb was consumed ~5 min before the trough
      // (it takes a few minutes for glucose tabs to hit the bloodstream)
      timestamp: troughTime - 5 * 60_000,
      estimatedGrams: estimateGramsFromRise(riseDelta),
      confidence,
      troughSgv: candidate.sgv,
      reversalSgv: peak.sgv,
      reversalMinutes,
    });
  }

  // Deduplicate: if multiple troughs detected within 15 min, keep the one with highest confidence
  const deduped: InferredRescueCarb[] = [];
  const confidenceOrder = { high: 3, medium: 2, low: 1 };

  for (const event of detected) {
    const overlap = deduped.findIndex(
      (d) => Math.abs(d.timestamp - event.timestamp) < 15 * 60_000
    );
    if (overlap >= 0) {
      if (confidenceOrder[event.confidence] > confidenceOrder[deduped[overlap].confidence]) {
        deduped[overlap] = event;
      }
    } else {
      deduped.push(event);
    }
  }

  return deduped;
}

/**
 * Calculate "inferred COB" from detected rescue carbs.
 * Uses a fast-sugar absorption curve (30 min total, not 4h like food).
 */
export function calculateInferredCOB(
  rescueCarbs: InferredRescueCarb[],
  atTime: number
): number {
  let cob = 0;
  for (const rc of rescueCarbs) {
    const age = (atTime - rc.timestamp) / 60_000;
    if (age >= 0 && age < 30) {
      const absorbed = rc.estimatedGrams * fastCarbAbsorptionPercent(age);
      cob += rc.estimatedGrams - absorbed;
    }
  }
  return Math.max(0, cob);
}

/**
 * Check if a rescue carb event is currently active (still absorbing).
 * Useful for the prediction engine to know whether to expect continued rise.
 */
export function hasActiveRescueCarbs(
  rescueCarbs: InferredRescueCarb[],
  atTime: number
): boolean {
  return rescueCarbs.some((rc) => {
    const age = (atTime - rc.timestamp) / 60_000;
    return age >= 0 && age < 30;
  });
}
