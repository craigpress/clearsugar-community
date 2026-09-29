/**
 * ClearSugar — glucose-rise meal trigger (section 4a / 4c)
 *
 * The pump path tells us about a meal ~50 minutes late and never tells us about
 * a meal with no bolus at all. The CGM trace does both. This is the predicate:
 *
 *   >= 30 mg/dL over the last 30 minutes (decision 3a — the shadow week may
 *   tune the slope variant but not below this), computed on VALID readings only
 *   (isValidSgv: a sensor-error sentinel 0-12 read as a real value manufactures
 *   a 60 mg/dL "rise" out of nothing), with at least 4 readings in the window so
 *   a gap with one stale sample either side cannot fire.
 *
 * Exclusions that are the difference between a useful nudge and prompt fatigue
 * (risk 3): the low-recovery window — a rescue treatment for a low produces
 * exactly this rise and the rescue detector already infers it — and anything the
 * caller has already ruled out (Sleep window, recent carbs, an open episode),
 * which `detect.ts` gates rather than this pure predicate.
 *
 * Pure and deterministic: no clock, no I/O.
 */

import { isValidSgv } from "@/lib/glucose-validity";
import type { GlucoseReading } from "@/lib/types";

const MIN = 60_000;

/** Decision 3a: the floor for the rise trigger. */
export const RISE_MIN_DELTA_MGDL = 30;
/** Window the delta is measured over. */
export const RISE_WINDOW_MIN = 30;
/** A 30-minute window holds ~6 CGM readings; 4 is a 2/3 quorum. */
export const RISE_MIN_READINGS = 4;
/**
 * Local copy of the rescue detector's LOW_THRESHOLD (85 mg/dL), which that
 * module does not export. Kept in sync by hand rather than editing a
 * shared-core prediction file for a one-word change.
 */
export const LOW_RECOVERY_THRESHOLD = 85;
/** A rise starting this soon after a low (or an inferred rescue) is recovery. */
export const LOW_RECOVERY_MIN = 45;

export interface RiseOpts {
  /** mg/dL required over the window. Default 30 (decision 3a floor). */
  minDeltaMgdl?: number;
  /** Window length in minutes. Default 30. */
  windowMin?: number;
  /** Valid readings required inside the window. Default 4. */
  minReadings?: number;
  /** Reading below which recovery, not eating, explains a rise. Default 85. */
  lowThreshold?: number;
  /** Minutes after a low/rescue during which a rise is ignored. Default 45. */
  lowRecoveryMin?: number;
  /** Epoch-ms timestamps of inferred rescue-carb events (detectRescueCarbs). */
  rescueEvents?: number[];
}

export interface RiseDetection {
  /** When the rise was detected — the newest reading in the window. */
  detectedAt: number;
  /** Oldest valid reading in the window (where the rise started). */
  fromMgdl: number;
  /** Newest valid reading in the window. */
  toMgdl: number;
  /** Timestamp of `fromMgdl` — what the prompt copy says "rising since". */
  fromAt: number;
  deltaMgdl: number;
}

/**
 * Detect a sustained rise ending at or before `now`.
 *
 * Returns null (no candidate) rather than throwing for every degenerate input:
 * empty series, all-invalid series, a gap, a flat trace, or a rise that is
 * really a recovery from a low.
 */
export function detectRise(
  readings: GlucoseReading[],
  now: number,
  opts: RiseOpts = {}
): RiseDetection | null {
  const minDelta = opts.minDeltaMgdl ?? RISE_MIN_DELTA_MGDL;
  const windowMin = opts.windowMin ?? RISE_WINDOW_MIN;
  const minReadings = opts.minReadings ?? RISE_MIN_READINGS;
  const lowThreshold = opts.lowThreshold ?? LOW_RECOVERY_THRESHOLD;
  const lowRecoveryMin = opts.lowRecoveryMin ?? LOW_RECOVERY_MIN;

  if (!Array.isArray(readings) || readings.length === 0) return null;
  if (!Number.isFinite(now)) return null;

  // Valid readings only, oldest first. An invalid sample is dropped, not
  // interpolated: the quorum check below is what decides whether what is left
  // still describes 30 minutes of trace.
  const valid = readings
    .filter((r) => r && typeof r.date === "number" && r.date <= now && isValidSgv(r.sgv))
    .sort((a, b) => a.date - b.date);
  if (valid.length < minReadings) return null;

  const windowStart = now - windowMin * MIN;
  const window = valid.filter((r) => r.date >= windowStart);
  if (window.length < minReadings) return null;

  const first = window[0];
  const last = window[window.length - 1];
  const delta = last.sgv - first.sgv;
  if (delta < minDelta) return null;

  // Low-recovery exclusion. Anchored on the window START, because that is when
  // the rise began: a rise that began 20 minutes after a 70 mg/dL reading is the
  // juice working, and the rescue detector has already inferred those carbs.
  const recoveryFloor = first.date - lowRecoveryMin * MIN;
  const recentLow = valid.some(
    (r) => r.date >= recoveryFloor && r.date <= first.date && r.sgv < lowThreshold
  );
  if (recentLow) return null;

  const rescueEvents = Array.isArray(opts.rescueEvents) ? opts.rescueEvents : [];
  const recentRescue = rescueEvents.some(
    (ts) => typeof ts === "number" && ts >= recoveryFloor && ts <= first.date
  );
  if (recentRescue) return null;

  return {
    detectedAt: last.date,
    fromMgdl: first.sgv,
    toMgdl: last.sgv,
    fromAt: first.date,
    deltaMgdl: delta,
  };
}
