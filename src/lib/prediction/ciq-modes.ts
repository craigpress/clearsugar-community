// ClearSugar — Control-IQ mode awareness (Option 3) + pump sleep wake-gate.
//
// Two related concepts the BFF fix now makes available:
//
//  1. The pump's sleep SCHEDULE (a time window, e.g. 22:00–05:00) — published to
//     NS devicestatus by the clearsugar-pumpstate job. Use it as the overnight
//     "quiet hours" wake-gate instead of the hardcoded 22:00–07:00. isPumpSleep()
//     implements exactly that, with a safe fallback.
//
//  2. The actual CIQ MODE (Sleep / Exercise) — now flowing to NS as activity
//     treatments (eventType "Sleep"/"Exercise", with a duration). getCiqMode()
//     reports the mode active at a given instant.
//
// Safety posture: mode DETECTION + LABELING is pure observability and is wired
// live (it only tags the feedback/outcome record — it changes NO firing). The
// pump sleep wake-gate IS a firing-path change, but an intentional one. Any
// modulation of the VALIDATED low path (exercise sensitivity) is left
// GATED behind EXERCISE_LOW_MODULATION (default off) — enabling it shifts the
// validated roc_sat@70 operating point and must be re-proven first.

import type { Treatment, PumpState } from "../types";

export type CiqMode = "sleep" | "exercise" | "normal";

const MIN = 60_000;

// Generic quiet hours when no pump schedule is available, in local minutes.
function quietMinute(value: string | undefined, fallback: number): number {
  const minute = value === undefined || value.trim() === "" ? NaN : Number(value);
  return Number.isInteger(minute) && minute >= 0 && minute < 1440 ? minute : fallback;
}

/** Local minutes-from-midnight for a timestamp (host-local, like isNight). */
function localMinOfDay(atTime: number): number {
  const d = new Date(atTime);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Is `atTime` within the pump's Sleep-schedule window? Uses the published pump
 * sleepSchedule (start/end minutes, when enabled) and otherwise falls back to
 * configured quiet hours (default 22:00–07:00). The window wraps midnight.
 */
export function isPumpSleep(
  atTime: number,
  sleep?: PumpState["controlIQ"]["sleepSchedule"] | null
): boolean {
  let start = quietMinute(process.env.QUIET_HOURS_START_MIN, 22 * 60);
  let end = quietMinute(process.env.QUIET_HOURS_END_MIN, 7 * 60);
  if (
    sleep &&
    sleep.enabled !== false &&
    typeof sleep.startMin === "number" &&
    typeof sleep.endMin === "number"
  ) {
    start = sleep.startMin;
    end = sleep.endMin;
  }
  const m = localMinOfDay(atTime);
  if (start === end) return false; // degenerate → no quiet hours
  if (start < end) return m >= start && m < end;
  return m >= start || m < end; // wraps midnight
}

/** True when the treatment is an activity-mode marker of the given kind. */
function isModeMarker(t: Treatment, kind: "Sleep" | "Exercise"): boolean {
  return t.eventType === kind;
}

/**
 * The CIQ mode active at `now`, derived from Sleep/Exercise activity treatments.
 * A marker covers [start, start+duration]; "Not Ended" provisional markers carry
 * a long duration and simply stay active until a real end event arrives.
 * Exercise wins over Sleep if (unusually) both cover the instant.
 */
export function getCiqMode(treatments: Treatment[], now: number): CiqMode {
  const covers = (t: Treatment): boolean => {
    const start = t.mills || Date.parse(t.created_at);
    if (!Number.isFinite(start) || start > now) return false;
    const durMs = (typeof t.duration === "number" ? t.duration : 0) * MIN;
    return now <= start + durMs;
  };
  const exercise = treatments.some((t) => isModeMarker(t, "Exercise") && covers(t));
  if (exercise) return "exercise";
  const sleep = treatments.some((t) => isModeMarker(t, "Sleep") && covers(t));
  if (sleep) return "sleep";
  return "normal";
}

// ── Exercise low-side modulation (GATED — validated-path change) ────────────────

/**
 * Master switch for exercise-aware low sensitivity. OFF by default: turning it
 * on raises the low-alert threshold during Exercise (exercise → more lows, CIQ
 * runs a higher target), which SHIFTS the validated roc_sat@70 operating point
 * and therefore must be re-proven with a phase0_eval-style backtest before it
 * may go live. Provided + tested so it's ready to enable, not wired into the
 * live low trigger.
 */
export const EXERCISE_LOW_MODULATION = false;

/** mg/dL to raise the low-event threshold by while in Exercise mode. */
export const EXERCISE_LOW_THRESHOLD_BUMP = 15;

/**
 * The low-event threshold to use given the current mode. Returns the base
 * threshold unchanged unless EXERCISE_LOW_MODULATION is enabled AND the mode is
 * exercise — in which case it raises the bar so lows are caught earlier.
 */
export function lowThresholdForMode(
  baseThreshold: number,
  mode: CiqMode,
  enabled: boolean = EXERCISE_LOW_MODULATION
): number {
  if (enabled && mode === "exercise") {
    return baseThreshold + EXERCISE_LOW_THRESHOLD_BUMP;
  }
  return baseThreshold;
}
