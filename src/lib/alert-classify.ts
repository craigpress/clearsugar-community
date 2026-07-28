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

/**
 * Cooldown + APNs category per alert type. Single source of truth — push/send
 * paces repeat alerts with it, and /api/alerts/ack uses the same duration for a
 * per-device acknowledge (an ack quiets one phone for exactly one cooldown).
 */
export const ALERT_CONFIG: Record<string, { cooldownMs: number; category: string }> = {
  urgentLow:  { cooldownMs: 5 * 60 * 1000,  category: "URGENT_GLUCOSE" },
  low:        { cooldownMs: 15 * 60 * 1000, category: "GLUCOSE_WARNING" },
  high:       { cooldownMs: 30 * 60 * 1000, category: "GLUCOSE_WARNING" },
  urgentHigh: { cooldownMs: 15 * 60 * 1000, category: "URGENT_GLUCOSE" },
};

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
