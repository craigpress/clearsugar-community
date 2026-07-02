// ClearSugar — ML feature extraction engine
// Extracts 20-feature vector from current state for LightGBM model
// Feature order must match scripts/train-model.py column order exactly

import type { GlucoseReading, Treatment, PumpProfile } from "../types";
import type { AGPSlot } from "../trends";
import type { SiteChange } from "../insulin-analysis";
import type { MLFeatureVector } from "./types";
import { calculateIOB, calculateCOB, estimateRateOfChange } from "./physiological-model";
import { detectRescueCarbs, calculateInferredCOB, hasActiveRescueCarbs } from "./rescue-carb-detector";

/** Extract ML feature vector from current state */
export function extractFeatures(
  readings: GlucoseReading[],
  treatments: Treatment[],
  profile: PumpProfile,
  agpSlots: AGPSlot[],
  siteChanges: SiteChange[],
  observedISF: number | null
): MLFeatureVector {
  const sorted = [...readings].sort((a, b) => b.date - a.date);
  const now = sorted[0]?.date ?? Date.now();
  const currentSgv = sorted[0]?.sgv ?? 0;

  // Rate of change at different windows
  const roc5 = calcRocPerMinute(sorted, 5);
  const roc15 = calcRocPerMinute(sorted, 15);
  const roc30 = calcRocPerMinute(sorted, 30);

  // IOB and COB
  const iob = calculateIOB(treatments, profile, now);
  const cob = calculateCOB(treatments, now);

  // Minutes since last bolus
  const boluses = treatments
    .filter((t) => t.insulin && t.insulin > 0)
    .map((t) => t.mills || new Date(t.created_at).getTime())
    .sort((a, b) => b - a);
  const insulinAge = boluses.length > 0 ? (now - boluses[0]) / 60_000 : 360;

  // Temporal features — cyclical encoding.
  // Computed in America/New_York explicitly (NOT host-local) so they match the
  // Python trainer (zoneinfo America/New_York) regardless of the server tz.
  const nyTime = getNewYorkTimeParts(now);
  const minuteOfDay = nyTime.hour * 60 + nyTime.minute;
  const dayOfWeek = nyTime.dayOfWeek; // 0=Sun, matches Python isoweekday()%7
  const sinTime = Math.sin((2 * Math.PI * minuteOfDay) / 1440);
  const cosTime = Math.cos((2 * Math.PI * minuteOfDay) / 1440);

  // Site age
  const siteAgeHours = calcSiteAge(siteChanges, now);

  // ISF — profile schedule only (NO autosens), to match the Python trainer.
  // The autosens multiplier is applied elsewhere in the physiological model,
  // but the ML feature must mean exactly what it meant at train time.
  const currentISF = observedISF ?? getProfileISF(profile, now);

  // Recent CV (last 2h)
  const twoHourReadings = sorted.filter((r) => now - r.date < 2 * 3_600_000);
  const recentCV = calcCV(twoHourReadings.map((r) => r.sgv));

  // AGP deviation — current SGV minus AGP median for this 30-min slot
  const agpDeviation = calcAGPDeviation(currentSgv, minuteOfDay, agpSlots);

  // Glucose momentum — 2nd derivative (acceleration of glucose change)
  const glucoseMomentum = calcMomentum(sorted);

  // Rolling statistics
  const oneHourReadings = sorted.filter((r) => now - r.date < 3_600_000);
  const threeHourReadings = sorted.filter((r) => now - r.date < 3 * 3_600_000);
  const oneHourValues = oneHourReadings.map((r) => r.sgv);
  const threeHourValues = threeHourReadings.map((r) => r.sgv);

  // Inferred rescue carb features
  const rescueCarbs = detectRescueCarbs(readings, treatments, profile);
  const inferredRescueCOB = Math.round(calculateInferredCOB(rescueCarbs, now));
  const rescueCarbActive = hasActiveRescueCarbs(rescueCarbs, now) ? 1 : 0;

  // Minutes since last logged carb treatment
  const carbTreatments = treatments
    .filter((t) => t.carbs && t.carbs > 0)
    .map((t) => t.mills || new Date(t.created_at).getTime())
    .sort((a, b) => b - a);
  const minutesSinceLastMeal = carbTreatments.length > 0
    ? Math.min(360, Math.round((now - carbTreatments[0]) / 60_000))
    : 360;

  return {
    currentSgv,
    roc5,
    roc15,
    roc30,
    iob: Math.round(iob * 100) / 100,
    cob: Math.round(cob),
    insulinAge: Math.round(insulinAge),
    minuteOfDay,
    dayOfWeek,
    sinTime,
    cosTime,
    siteAgeHours,
    currentISF,
    recentCV,
    agpDeviation,
    glucoseMomentum,
    mean1h: mean(oneHourValues),
    mean3h: mean(threeHourValues),
    min1h: oneHourValues.length > 0 ? Math.min(...oneHourValues) : currentSgv,
    max1h: oneHourValues.length > 0 ? Math.max(...oneHourValues) : currentSgv,
    // Control-IQ mode features — MUST match cs_features.py _in_any_interval /
    // precompute_mode_intervals (a Sleep/Exercise treatment covers
    // [mills, mills + duration*60000]).
    sleepActive: modeActive(treatments, "Sleep", now),
    exerciseActive: modeActive(treatments, "Exercise", now),
    inferredRescueCOB,
    rescueCarbActive,
    minutesSinceLastMeal,
  };
}

/**
 * 1 if any treatment of `eventType` (Sleep/Exercise) covers `now`, i.e.
 * mills <= now <= mills + duration*60000; else 0. Parity with cs_features.py.
 */
export function modeActive(treatments: Treatment[], eventType: string, now: number): number {
  for (const t of treatments) {
    if (t.eventType !== eventType) continue;
    const start = t.mills || Date.parse(t.created_at);
    if (!Number.isFinite(start) || start > now) continue;
    const durMs = (typeof t.duration === "number" ? t.duration : 0) * 60_000;
    if (now <= start + durMs) return 1;
  }
  return 0;
}

// ── Internal helpers ──

/** Wall-clock parts in America/New_York for a given epoch-ms timestamp.
 * Uses Intl so it is correct under DST and independent of the host timezone.
 * dayOfWeek is 0=Sun..6=Sat to match the Python trainer (isoweekday()%7). */
function getNewYorkTimeParts(epochMs: number): {
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(epochMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    hour: parseInt(get("hour"), 10),
    minute: parseInt(get("minute"), 10),
    second: parseInt(get("second"), 10),
    dayOfWeek: weekdayMap[get("weekday")] ?? 0,
  };
}

function calcRocPerMinute(sorted: GlucoseReading[], windowMin: number): number {
  return estimateRateOfChange(sorted, windowMin) / 5; // convert from per-5-min to per-min
}

function calcCV(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  if (m === 0) return 0;
  const std = Math.sqrt(
    values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length // ddof=0 (population), matches Python std(ddof=0)
  );
  return Math.round((std / m) * 100 * 10) / 10; // round to 1 decimal, matches Python round(...,1)
}

function calcSiteAge(siteChanges: SiteChange[], now: number): number {
  if (siteChanges.length === 0) return 72; // assume 3 days if unknown
  let lastChange: SiteChange | null = null;
  for (const sc of siteChanges) {
    if (sc.time <= now) lastChange = sc;
    else break;
  }
  if (!lastChange) return 72;
  return Math.round((now - lastChange.time) / 3_600_000);
}

function calcAGPDeviation(
  currentSgv: number,
  minuteOfDay: number,
  agpSlots: AGPSlot[]
): number {
  if (agpSlots.length === 0) return 0;
  const slotMinute = Math.floor(minuteOfDay / 30) * 30;
  const slot = agpSlots.find((s) => s.minuteOfDay === slotMinute);
  if (!slot || slot.count === 0) return 0;
  return currentSgv - slot.p50; // positive = above median for this time
}

function calcMomentum(sorted: GlucoseReading[]): number {
  // 2nd derivative: how is the rate of change itself changing?
  // Use 3 points: now, -10min, -20min
  if (sorted.length < 5) return 0;
  const now = sorted[0];
  const mid = sorted.find((r) => now.date - r.date >= 8 * 60_000); // ~10 min ago
  const old = sorted.find((r) => now.date - r.date >= 18 * 60_000); // ~20 min ago
  if (!mid || !old) return 0;

  const dt1 = (now.date - mid.date) / 60_000; // minutes
  const dt2 = (mid.date - old.date) / 60_000;
  if (dt1 === 0 || dt2 === 0) return 0;

  const roc1 = (now.sgv - mid.sgv) / dt1; // recent rate
  const roc2 = (mid.sgv - old.sgv) / dt2; // earlier rate
  const avgDt = (dt1 + dt2) / 2;
  return (roc1 - roc2) / avgDt; // mg/dL/min² — positive = accelerating up
}

function getProfileISF(profile: PumpProfile, atTime: number): number {
  const active = profile.store[profile.defaultProfile];
  if (!active?.sens?.length) return 50; // safe default
  // Schedule lookup in America/New_York to match the Python trainer.
  const ny = getNewYorkTimeParts(atTime);
  const seconds = ny.hour * 3600 + ny.minute * 60 + ny.second;
  let value = active.sens[0].value;
  for (const entry of active.sens) {
    if (entry.timeAsSeconds <= seconds) value = entry.value;
    else break;
  }
  return value;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((s, v) => s + v, 0) / values.length);
}
