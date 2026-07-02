// ClearSugar — Trend analysis utilities
// Computes AGP percentiles, daily overlays, and day-of-week patterns

import type { GlucoseReading } from "./types";
import { localHour, localDayOfWeek, localDateKey } from "./time";
import { percentile } from "./stats-util";

/** AGP time slot — one per 30-minute period across a 24-hour day */
export interface AGPSlot {
  minuteOfDay: number; // 0-1410 (every 30 min)
  p10: number;
  p25: number;
  p50: number; // median
  p75: number;
  p90: number;
  count: number;
}

/** Compute AGP percentile bands from readings */
export function computeAGP(readings: GlucoseReading[]): AGPSlot[] {
  // Bucket readings by 30-minute slots
  const buckets: Map<number, number[]> = new Map();
  for (let m = 0; m < 1440; m += 30) {
    buckets.set(m, []);
  }

  for (const r of readings) {
    const d = new Date(r.date);
    const mins = localHour(d) * 60 + d.getMinutes();
    const slot = Math.floor(mins / 30) * 30;
    buckets.get(slot)?.push(r.sgv);
  }

  const slots: AGPSlot[] = [];
  for (const [minuteOfDay, values] of buckets) {
    if (values.length === 0) {
      slots.push({ minuteOfDay, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, count: 0 });
      continue;
    }
    values.sort((a, b) => a - b);
    slots.push({
      minuteOfDay,
      p10: percentile(values, 0.1),
      p25: percentile(values, 0.25),
      p50: percentile(values, 0.5),
      p75: percentile(values, 0.75),
      p90: percentile(values, 0.9),
      count: values.length,
    });
  }

  return slots.sort((a, b) => a.minuteOfDay - b.minuteOfDay);
}

/** Daily profile — one day's worth of glucose readings */
export interface DailyProfile {
  date: string; // YYYY-MM-DD
  dayOfWeek: string; // Mon, Tue, etc
  readings: { minuteOfDay: number; sgv: number }[];
  timeInRange: number; // percentage 70-180
  mean: number;
}

/** Extract individual daily profiles */
export function computeDailyProfiles(
  readings: GlucoseReading[]
): DailyProfile[] {
  const dayMap: Map<string, GlucoseReading[]> = new Map();

  for (const r of readings) {
    const key = localDateKey(r.date); // YYYY-MM-DD in patient TZ
    if (!dayMap.has(key)) dayMap.set(key, []);
    dayMap.get(key)!.push(r);
  }

  const profiles: DailyProfile[] = [];
  for (const [date, dayReadings] of dayMap) {
    const d = new Date(date + "T12:00:00");
    const dayOfWeek = d.toLocaleDateString("en-US", { weekday: "short" });
    const values = dayReadings.map((r) => r.sgv);
    const inRange = values.filter((v) => v >= 70 && v <= 180).length;

    profiles.push({
      date,
      dayOfWeek,
      readings: dayReadings.map((r) => {
        const rd = new Date(r.date);
        return {
          minuteOfDay: localHour(rd) * 60 + rd.getMinutes(),
          sgv: r.sgv,
        };
      }),
      timeInRange: Math.round((inRange / values.length) * 100),
      mean: Math.round(values.reduce((s, v) => s + v, 0) / values.length),
    });
  }

  return profiles.sort((a, b) => b.date.localeCompare(a.date)); // newest first
}

/** Day-of-week pattern summary */
export interface DayOfWeekPattern {
  day: string; // Mon, Tue, etc.
  dayIndex: number; // 0=Sun, 6=Sat
  mean: number;
  timeInRange: number;
  count: number;
}

/** Compute average glucose and TIR by day of week */
export function computeDayOfWeekPatterns(
  readings: GlucoseReading[]
): DayOfWeekPattern[] {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const buckets: Map<number, number[]> = new Map();
  for (let i = 0; i < 7; i++) buckets.set(i, []);

  for (const r of readings) {
    buckets.get(localDayOfWeek(r.date))!.push(r.sgv);
  }

  return days.map((day, i) => {
    const values = buckets.get(i) || [];
    if (values.length === 0) {
      return { day, dayIndex: i, mean: 0, timeInRange: 0, count: 0 };
    }
    const inRange = values.filter((v) => v >= 70 && v <= 180).length;
    return {
      day,
      dayIndex: i,
      mean: Math.round(values.reduce((s, v) => s + v, 0) / values.length),
      timeInRange: Math.round((inRange / values.length) * 100),
      count: values.length,
    };
  });
}

/** Time-of-day pattern (4 periods) */
export interface TimeOfDayPattern {
  period: string;
  label: string;
  mean: number;
  timeInRange: number;
  count: number;
}

/** Compute patterns by time of day */
export function computeTimeOfDayPatterns(
  readings: GlucoseReading[]
): TimeOfDayPattern[] {
  const periods = [
    { period: "overnight", label: "Overnight (12a-6a)", startH: 0, endH: 6 },
    { period: "morning", label: "Morning (6a-12p)", startH: 6, endH: 12 },
    { period: "afternoon", label: "Afternoon (12p-6p)", startH: 12, endH: 18 },
    { period: "evening", label: "Evening (6p-12a)", startH: 18, endH: 24 },
  ];

  return periods.map(({ period, label, startH, endH }) => {
    const values = readings
      .filter((r) => {
        const h = localHour(r.date);
        return h >= startH && h < endH;
      })
      .map((r) => r.sgv);

    if (values.length === 0) {
      return { period, label, mean: 0, timeInRange: 0, count: 0 };
    }
    const inRange = values.filter((v) => v >= 70 && v <= 180).length;
    return {
      period,
      label,
      mean: Math.round(values.reduce((s, v) => s + v, 0) / values.length),
      timeInRange: Math.round((inRange / values.length) * 100),
      count: values.length,
    };
  });
}
