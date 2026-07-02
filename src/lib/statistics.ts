// ClearSugar — Glucose statistics calculations

import type { GlucoseReading, GlucoseStats } from "./types";
import { GLUCOSE_RANGES } from "./types";
import { minOf, maxOf } from "./stats-util";

/** Calculate comprehensive glucose statistics from a set of readings */
export function calculateStats(readings: GlucoseReading[]): GlucoseStats {
  if (readings.length === 0) {
    return {
      count: 0,
      mean: 0,
      median: 0,
      stddev: 0,
      min: 0,
      max: 0,
      gmi: 0,
      cv: 0,
      timeInRange: { veryLow: 0, low: 0, inRange: 0, high: 0, veryHigh: 0 },
    };
  }

  const values = readings.map((r) => r.sgv);
  const n = values.length;

  const mean = values.reduce((s, v) => s + v, 0) / n;
  const sorted = [...values].sort((a, b) => a - b);
  const median = n % 2 === 1 ? sorted[Math.floor(n / 2)] : Math.round((sorted[n / 2 - 1] + sorted[n / 2]) / 2);
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  const cv = mean > 0 ? (stddev / mean) * 100 : 0;

  // GMI (Glucose Management Indicator) — estimated A1c from mean glucose
  // Formula: GMI(%) = 3.31 + 0.02392 × mean glucose (mg/dL)
  const gmi = 3.31 + 0.02392 * mean;

  // Time in range calculations
  let veryLow = 0,
    low = 0,
    inRange = 0,
    high = 0,
    veryHigh = 0;

  for (const v of values) {
    if (v < GLUCOSE_RANGES.URGENT_LOW) veryLow++;
    else if (v < GLUCOSE_RANGES.LOW) low++;
    else if (v <= GLUCOSE_RANGES.TARGET_HIGH) inRange++;
    else if (v <= GLUCOSE_RANGES.HIGH) high++;
    else veryHigh++;
  }

  return {
    count: n,
    mean: Math.round(mean),
    median,
    stddev: Math.round(stddev),
    min: minOf(values),
    max: maxOf(values),
    gmi: Math.round(gmi * 10) / 10,
    cv: Math.round(cv),
    timeInRange: {
      veryLow: Math.round((veryLow / n) * 100),
      low: Math.round((low / n) * 100),
      inRange: Math.round((inRange / n) * 100),
      high: Math.round((high / n) * 100),
      veryHigh: Math.round((veryHigh / n) * 100),
    },
  };
}

/** Get the glucose range color token for a given value */
export function glucoseColor(sgv: number): string {
  if (sgv < GLUCOSE_RANGES.URGENT_LOW) return "var(--glucose-urgent-low)";
  if (sgv < GLUCOSE_RANGES.LOW) return "var(--glucose-low)";
  if (sgv <= GLUCOSE_RANGES.TARGET_HIGH) return "var(--glucose-in-range)";
  if (sgv <= GLUCOSE_RANGES.HIGH) return "var(--glucose-high)";
  return "var(--glucose-urgent-high)";
}

/** Get a Tailwind-compatible color class for glucose value */
export function glucoseColorClass(sgv: number): string {
  if (sgv < GLUCOSE_RANGES.URGENT_LOW) return "text-red-400";
  if (sgv < GLUCOSE_RANGES.LOW) return "text-amber-400";
  if (sgv <= GLUCOSE_RANGES.TARGET_HIGH) return "text-emerald-400";
  if (sgv <= GLUCOSE_RANGES.HIGH) return "text-amber-400";
  return "text-red-400";
}

/** Get a status label for glucose value */
export function glucoseStatus(sgv: number): string {
  if (sgv < GLUCOSE_RANGES.URGENT_LOW) return "URGENT LOW";
  if (sgv < GLUCOSE_RANGES.LOW) return "LOW";
  if (sgv <= GLUCOSE_RANGES.TARGET_HIGH) return "In Range";
  if (sgv <= GLUCOSE_RANGES.HIGH) return "HIGH";
  return "URGENT HIGH";
}

/** Format minutes ago from a timestamp */
export function minutesAgo(dateMs: number): number {
  return Math.round((Date.now() - dateMs) / 60_000);
}

/** Format a duration in minutes to a human-readable string */
export function formatMinutesAgo(mins: number): string {
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours === 1) return "1 hr ago";
  return `${hours} hrs ago`;
}
