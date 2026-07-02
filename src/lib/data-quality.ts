// ClearSugar — CGM data-quality / coverage helpers
//
// Quantifies how complete the CGM stream is over a given window so the UI can
// warn when analytics are computed on sparse data. Dexcom emits one reading
// every ~5 minutes, so expected readings = window minutes / 5.

import { localDateKey } from "@/lib/time";

export interface Coverage {
  /** Percent of expected readings actually present (0-100). */
  pctActive: number;
  /** How many readings a complete window would contain (window minutes / 5). */
  expectedReadings: number;
  /** Readings actually present in the window. */
  actualReadings: number;
  /** Largest gap between consecutive readings, in hours. */
  longestGapHours: number;
  /** Distinct local (Eastern) calendar days that have at least one reading. */
  daysWithData: number;
}

/**
 * Compute CGM coverage over [windowStartMs, windowEndMs].
 * Readings outside the window are ignored. A 5-minute cadence is assumed.
 */
export function computeCoverage(
  readings: { date: number }[],
  windowStartMs: number,
  windowEndMs: number,
): Coverage {
  const windowMinutes = Math.max(0, (windowEndMs - windowStartMs) / 60_000);
  const expectedReadings = Math.round(windowMinutes / 5);

  const inWindow = readings
    .filter((r) => r.date >= windowStartMs && r.date <= windowEndMs)
    .sort((a, b) => a.date - b.date);

  const actualReadings = inWindow.length;

  let longestGapMs = 0;
  for (let i = 1; i < inWindow.length; i++) {
    const gap = inWindow[i].date - inWindow[i - 1].date;
    if (gap > longestGapMs) longestGapMs = gap;
  }

  const dayKeys = new Set<string>();
  for (const r of inWindow) dayKeys.add(localDateKey(r.date));

  const pctActive = expectedReadings > 0
    ? Math.min(100, Math.round((actualReadings / expectedReadings) * 100))
    : 0;

  return {
    pctActive,
    expectedReadings,
    actualReadings,
    longestGapHours: Math.round((longestGapMs / 3_600_000) * 10) / 10,
    daysWithData: dayKeys.size,
  };
}
