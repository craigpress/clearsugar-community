import type { GlucoseReading, Treatment, PumpProfile } from "../types";
import type { PredictionPoint } from "./types";
import {
  calculateIOB,
  calculateAutosens,
  getActiveProfileFor,
  getScheduledValueAt,
} from "./physiological-model";

const FIVE_MIN_MS = 5 * 60_000;
const DEFAULT_HORIZON_MIN = 120;
const DEFAULT_LOW_THRESHOLD = 70;
const SGV_FLOOR = 39;

export interface HypoRiskPrediction {
  points: PredictionPoint[];
  /** Lowest predicted value across the horizon (mg/dL). */
  nadir: number;
  /** Epoch ms at which the nadir occurs. 0 when there is no prediction. */
  nadirAt: number;
  /** Minutes from the latest reading to the nadir. */
  minutesToNadir: number;
  /** Minutes until the curve first crosses below the threshold; null if never. */
  minutesToLow: number | null;
  /** IOB at prediction time, for display. */
  iob: number;
}

const EMPTY: HypoRiskPrediction = {
  points: [],
  nadir: 0,
  nadirAt: 0,
  minutesToNadir: 0,
  minutesToLow: null,
  iob: 0,
};

/**
 * Where does glucose go on insulin already delivered, if nothing else happens?
 *
 * This is the hypoglycaemia floor, and it is deliberately NOT the blended
 * forecast. `predictPhysiological` sums momentum + IOB + COB into one number,
 * which means a pending meal can arithmetically cancel an impending
 * insulin-driven low and hide it. For an app whose job is warning a parent
 * before a teenager goes low, that is the wrong shape — so this curve answers
 * the narrower, safety-oriented question on its own.
 *
 * Modelled on oref0's ZTpredBG ("where does BG go if I stop dosing"), adapted
 * for a monitoring app: we cannot change insulin delivery, so the useful
 * question is the floor implied by insulin already on board.
 *
 * Deliberately excluded:
 *  - **Carbs.** Including them is the whole failure mode above. A meal that has
 *    not absorbed yet is a hope, not a guarantee; the floor must not depend on it.
 *  - **Momentum.** Observed ROC is already largely *caused* by the insulin being
 *    modelled here, so carrying it forward double-counts — the same error that
 *    produced the upside overshoot in the blended model.
 *
 * The result is intentionally conservative: it is a floor, not a forecast, and
 * it will often sit below what actually happens because carbs usually do arrive.
 */
export function predictHypoRisk(
  readings: GlucoseReading[],
  treatments: Treatment[],
  profile: PumpProfile,
  opts: { horizonMinutes?: number; lowThreshold?: number } = {}
): HypoRiskPrediction {
  if (readings.length < 2) return EMPTY;

  const horizonMinutes = opts.horizonMinutes ?? DEFAULT_HORIZON_MIN;
  const lowThreshold = opts.lowThreshold ?? DEFAULT_LOW_THRESHOLD;
  const steps = Math.max(1, Math.round(horizonMinutes / 5));

  const sorted = [...readings].sort((a, b) => b.date - a.date);
  const latest = sorted[0];
  const now = latest.date;
  const active = getActiveProfileFor(profile);

  const currentIOB = calculateIOB(treatments, profile, now);
  // Same sensitivity adjustment the blended model uses, so the two curves do
  // not disagree about how hard insulin is working.
  const autosensRatio = calculateAutosens(readings, treatments, profile);

  const points: PredictionPoint[] = [];
  let prevSgv = latest.sgv;
  let nadir = latest.sgv;
  let nadirAt = now;
  let minutesToLow: number | null = null;

  for (let step = 1; step <= steps; step++) {
    const futureTime = now + step * FIVE_MIN_MS;

    const iobNow = calculateIOB(treatments, profile, futureTime);
    const iobPrev = calculateIOB(treatments, profile, futureTime - FIVE_MIN_MS);
    const insulinAbsorbed = iobPrev - iobNow;

    const isf = getScheduledValueAt(active.sens, futureTime) * autosensRatio;
    const delta = -insulinAbsorbed * isf; // <= 0; insulin only ever lowers

    const predicted = Math.round(Math.max(SGV_FLOOR, prevSgv + delta));

    // A floor has no upper band worth drawing — the uncertainty that matters is
    // "could it be lower", which is bounded by the physiological floor.
    points.push({
      timestamp: futureTime,
      sgv: predicted,
      confidence: { low: predicted, high: predicted },
    });

    if (predicted < nadir) {
      nadir = predicted;
      nadirAt = futureTime;
    }
    if (minutesToLow === null && predicted < lowThreshold) {
      minutesToLow = step * 5;
    }

    prevSgv = predicted;
  }

  return {
    points,
    nadir,
    nadirAt,
    minutesToNadir: Math.round((nadirAt - now) / 60_000),
    minutesToLow,
    iob: Math.round(currentIOB * 100) / 100,
  };
}
