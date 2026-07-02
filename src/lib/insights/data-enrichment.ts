/**
 * ClearSugar — Data enrichment for LLM insights
 *
 * Computes time blocks, notable days, correction effectiveness,
 * and AGP percentiles from raw CGM + treatment data.
 */

import type { GlucoseReading, Treatment } from "../types";
import { calculateStats } from "../statistics";
import { localHour, localDayOfWeek, localDateKey } from "../time";
import { percentile } from "../stats-util";

// ── Time Blocks ──

const TIME_BLOCKS = [
  { label: "Overnight", hours: "10 PM–6 AM", start: 22, end: 6 },
  { label: "Fasting Morning", hours: "6–8 AM", start: 6, end: 8 },
  { label: "Post-Breakfast", hours: "8–11 AM", start: 8, end: 11 },
  { label: "Lunch", hours: "11 AM–2 PM", start: 11, end: 14 },
  { label: "Afternoon", hours: "2–5 PM", start: 14, end: 17 },
  { label: "Dinner", hours: "5–8 PM", start: 17, end: 20 },
  { label: "Evening", hours: "8–10 PM", start: 20, end: 22 },
] as const;

function hourInBlock(hour: number, start: number, end: number): boolean {
  if (start > end) {
    // Wraps midnight (e.g., 22–6)
    return hour >= start || hour < end;
  }
  return hour >= start && hour < end;
}

export function computeTimeBlocks(readings: GlucoseReading[]) {
  return TIME_BLOCKS.map((block) => {
    const filtered = readings.filter((r) => {
      const h = localHour(r.date);
      return hourInBlock(h, block.start, block.end);
    });

    if (filtered.length === 0) {
      return { label: block.label, hours: block.hours, avg: 0, tir: 0, low: 0, high: 0, count: 0 };
    }

    const stats = calculateStats(filtered);
    return {
      label: block.label,
      hours: block.hours,
      avg: stats.mean,
      tir: stats.timeInRange.inRange,
      low: stats.timeInRange.low + stats.timeInRange.veryLow,
      high: stats.timeInRange.high + stats.timeInRange.veryHigh,
      count: filtered.length,
    };
  });
}

// ── Notable Days ──

export function computeNotableDays(readings: GlucoseReading[]) {
  // Group readings by date
  const byDate = new Map<string, GlucoseReading[]>();
  for (const r of readings) {
    const key = localDateKey(r.date);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(r);
  }

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const allDays: Array<{
    date: string;
    dayOfWeek: string;
    mean: number;
    tir: number;
    lows: number;
    highs: number;
    note?: string;
  }> = [];

  for (const [date, dayReadings] of byDate) {
    if (dayReadings.length < 50) continue; // Skip partial days
    const stats = calculateStats(dayReadings);
    const lows = dayReadings.filter((r) => r.sgv < 70).length;
    const highs = dayReadings.filter((r) => r.sgv > 250).length;
    const dow = dayNames[localDayOfWeek(dayReadings[0].date)];

    let note: string | undefined;
    // Detect potential sick day: sustained highs across all time blocks
    if (stats.timeInRange.high + stats.timeInRange.veryHigh > 60 && stats.mean > 200) {
      note = "Possible sick day — sustained highs across time blocks";
    }
    // Detect very bad overnight
    const overnightR = dayReadings.filter((r) => {
      const h = localHour(r.date);
      return h >= 22 || h < 6;
    });
    if (overnightR.length > 20) {
      const oStats = calculateStats(overnightR);
      if (oStats.timeInRange.inRange < 40) {
        note = (note ? note + "; " : "") + `Rough overnight (TIR ${oStats.timeInRange.inRange}%, avg ${oStats.mean})`;
      }
    }

    allDays.push({ date, dayOfWeek: dow, mean: stats.mean, tir: stats.timeInRange.inRange, lows, highs, note });
  }

  // Return outlier days: worst TIR, most lows, most highs
  allDays.sort((a, b) => a.tir - b.tir);

  // Take bottom 3 (worst) and top 2 (best) if enough days
  const notable: typeof allDays = [];
  const seen = new Set<string>();

  // Worst days
  for (const day of allDays) {
    if (notable.length >= 3) break;
    if (day.tir < 60 || day.lows > 5 || day.highs > 10) {
      notable.push(day);
      seen.add(day.date);
    }
  }

  // Best days
  for (let i = allDays.length - 1; i >= 0; i--) {
    if (notable.length >= 5) break;
    const day = allDays[i];
    if (!seen.has(day.date) && day.tir >= 85) {
      notable.push({ ...day, note: "Excellent day" });
      seen.add(day.date);
    }
  }

  return notable;
}

// ── Correction Effectiveness ──

export function computeCorrectionEffectiveness(
  readings: GlucoseReading[],
  treatments: Treatment[]
) {
  // Find correction boluses (insulin with no carbs within ±15 min)
  const corrections: Array<{
    time: string;
    units: number;
    bgBefore: number;
    bgAfter60min: number;
    effectiveISF: number;
  }> = [];

  const sortedReadings = [...readings].sort((a, b) => a.date - b.date);
  const boluses = treatments.filter((t) => t.insulin && t.insulin > 0);
  const carbTreatments = treatments.filter((t) => t.carbs && t.carbs > 0);

  for (const bolus of boluses) {
    const bolusTime = new Date(bolus.created_at || bolus.mills || 0).getTime();
    if (!bolusTime) continue;

    // Check if carbs were given within ±15 min (if so, skip — not a pure correction)
    const hasCarbs = carbTreatments.some((c) => {
      const carbTime = new Date(c.created_at || c.mills || 0).getTime();
      return Math.abs(carbTime - bolusTime) < 15 * 60_000;
    });
    if (hasCarbs) continue;

    // Find BG at bolus time
    const bgBefore = findClosestReading(sortedReadings, bolusTime, 5 * 60_000);
    if (!bgBefore || bgBefore.sgv < 150) continue; // Only analyze corrections from high BG

    // Find BG 60 min later
    const bgAfter = findClosestReading(sortedReadings, bolusTime + 60 * 60_000, 10 * 60_000);
    if (!bgAfter) continue;

    const drop = bgBefore.sgv - bgAfter.sgv;
    const effectiveISF = Math.round(drop / bolus.insulin!);

    const dt = new Date(bolusTime);
    const ET = "America/New_York";
    corrections.push({
      time: `${dt.toLocaleDateString("en-US", { timeZone: ET })} ${dt.toLocaleTimeString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" })}`,
      units: Math.round(bolus.insulin! * 10) / 10,
      bgBefore: bgBefore.sgv,
      bgAfter60min: bgAfter.sgv,
      effectiveISF,
    });
  }

  // Return most recent 10 corrections
  return corrections.slice(-10);
}

function findClosestReading(
  sorted: GlucoseReading[],
  targetTime: number,
  tolerance: number
): GlucoseReading | null {
  let best: GlucoseReading | null = null;
  let bestDiff = Infinity;

  for (const r of sorted) {
    const diff = Math.abs(r.date - targetTime);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
    // Early exit — readings are sorted, so once we pass the target, stop
    if (r.date > targetTime + tolerance) break;
  }

  return bestDiff <= tolerance ? best : null;
}

// ── AGP Percentiles by Hour ──

export function computeAGPByHour(readings: GlucoseReading[]) {
  const buckets = new Map<number, number[]>();

  for (const r of readings) {
    const h = localHour(r.date);
    if (!buckets.has(h)) buckets.set(h, []);
    buckets.get(h)!.push(r.sgv);
  }

  const result: Array<{ hour: number; p10: number; p25: number; p50: number; p75: number; p90: number }> = [];

  for (let h = 0; h < 24; h++) {
    const values = buckets.get(h);
    if (!values || values.length < 5) continue;
    values.sort((a, b) => a - b);

    result.push({
      hour: h,
      p10: Math.round(percentile(values, 0.1)),
      p25: Math.round(percentile(values, 0.25)),
      p50: Math.round(percentile(values, 0.5)),
      p75: Math.round(percentile(values, 0.75)),
      p90: Math.round(percentile(values, 0.9)),
    });
  }

  return result;
}
