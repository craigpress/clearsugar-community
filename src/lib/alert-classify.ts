/**
 * ClearSugar — per-device glucose threshold classification.
 *
 * Gates on the validity invariant first: sentinel/error values must never
 * classify (a sensor-error 0 is "below every low threshold" numerically).
 */

import { isValidSgv } from "@/lib/glucose-validity";

export interface AlertThresholds {
  thresholdUrgentLow: number;
  thresholdLow: number;
  thresholdHigh: number;
  thresholdUrgentHigh: number;
}

export function classifyGlucose(
  sgv: number,
  prefs: AlertThresholds
): string | null {
  if (!isValidSgv(sgv)) return null;
  if (sgv < prefs.thresholdUrgentLow) return "urgentLow";
  if (sgv < prefs.thresholdLow) return "low";
  if (sgv >= prefs.thresholdUrgentHigh) return "urgentHigh";
  if (sgv >= prefs.thresholdHigh) return "high";
  return null;
}
