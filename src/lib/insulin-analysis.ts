// ClearSugar — Insulin response and basal adequacy analysis

import type { GlucoseReading, Treatment } from "./types";
import { localHour, localDateKey } from "./time";
import { minOf, maxOf } from "./stats-util";

function treatmentTime(t: Treatment): number {
  return t.mills || new Date(t.created_at).getTime();
}

// ── Site Change / Infusion Set Age Tracking ──

export interface SiteChange {
  time: number;
  date: string;
  notes: string;
}

export interface SitePeriod {
  siteChangeTime: number;
  siteChangeDate: string;
  notes: string;
  endTime: number; // when next site change happened (or now)
  ageDays: number; // how long this site lasted
  // Glucose quality during this site
  avgGlucose: number;
  tir: number;
  lowPercent: number;
  highPercent: number;
  readingCount: number;
  // ISF effectiveness during this site
  avgISF: number;
  correctionCount: number;
  effectiveRate: number; // % of corrections that worked
  // Degradation: compare first 24h vs last 24h
  first24hAvg: number;
  last24hAvg: number;
  degradation: number; // positive = glucose got worse over time
}

/** Extract site changes from treatments */
export function extractSiteChanges(treatments: Treatment[]): SiteChange[] {
  return treatments
    .filter((t) => t.eventType === "Site Change")
    .map((t) => ({
      time: treatmentTime(t),
      date: localDateKey(treatmentTime(t)),
      notes: t.notes || "",
    }))
    .sort((a, b) => a.time - b.time);
}

/** Get the age of the current infusion site in hours */
export function getCurrentSiteAge(treatments: Treatment[]): number | null {
  const changes = extractSiteChanges(treatments);
  if (changes.length === 0) return null;
  const latest = changes[changes.length - 1];
  return Math.round((Date.now() - latest.time) / 3_600_000);
}

/** Get the site age at a specific timestamp */
export function getSiteAgeAt(
  siteChanges: SiteChange[],
  timestamp: number
): number | null {
  // Find the most recent site change before this timestamp
  let lastChange: SiteChange | null = null;
  for (const sc of siteChanges) {
    if (sc.time <= timestamp) lastChange = sc;
    else break;
  }
  if (!lastChange) return null;
  return Math.round((timestamp - lastChange.time) / 3_600_000);
}

/** Analyze glucose quality per infusion site period */
export function analyzeSitePeriods(
  readings: GlucoseReading[],
  treatments: Treatment[],
  boluses: Treatment[],
  carbs: Treatment[]
): SitePeriod[] {
  const siteChanges = extractSiteChanges(treatments);
  if (siteChanges.length === 0) return [];

  const sorted = [...readings].sort((a, b) => a.date - b.date);
  const periods: SitePeriod[] = [];

  for (let i = 0; i < siteChanges.length; i++) {
    const start = siteChanges[i].time;
    const end = i < siteChanges.length - 1 ? siteChanges[i + 1].time : Date.now();
    const ageDays = Math.round(((end - start) / 86_400_000) * 10) / 10;

    // Get readings during this site period
    const periodReadings = sorted.filter((r) => r.date >= start && r.date < end);
    if (periodReadings.length < 12) continue;

    const values = periodReadings.map((r) => r.sgv);
    const avg = Math.round(values.reduce((s, v) => s + v, 0) / values.length);
    const inRange = values.filter((v) => v >= 70 && v <= 180).length;
    const low = values.filter((v) => v < 70).length;
    const high = values.filter((v) => v > 180).length;

    // ISF during this period — correction boluses (no carbs nearby)
    const periodBoluses = boluses.filter((b) => {
      const bt = treatmentTime(b);
      return bt >= start && bt < end && (b.insulin || 0) > 0;
    });
    const periodCorrections = periodBoluses.filter((b) => {
      const bt = treatmentTime(b);
      return !carbs.some((c) => Math.abs(treatmentTime(c) - bt) < 30 * 60_000);
    });

    let totalISF = 0;
    let isfCount = 0;
    let effectiveCount = 0;
    for (const corr of periodCorrections) {
      const ct = treatmentTime(corr);
      const pre = sorted.find((r) => Math.abs(r.date - ct) < 10 * 60_000);
      const post = sorted.find(
        (r) => Math.abs(r.date - (ct + 120 * 60_000)) < 10 * 60_000
      );
      if (pre && post && pre.sgv > 100) {
        const drop = pre.sgv - post.sgv;
        const isf = drop / (corr.insulin || 1);
        totalISF += isf;
        isfCount++;
        if (drop > 10) effectiveCount++;
      }
    }

    // Compare first 24h vs last 24h to detect degradation
    const first24h = periodReadings.filter(
      (r) => r.date < start + 24 * 60 * 60_000
    );
    const last24h = periodReadings.filter(
      (r) => r.date >= end - 24 * 60 * 60_000
    );
    const first24hAvg =
      first24h.length > 0
        ? Math.round(
            first24h.reduce((s, r) => s + r.sgv, 0) / first24h.length
          )
        : avg;
    const last24hAvg =
      last24h.length > 0
        ? Math.round(
            last24h.reduce((s, r) => s + r.sgv, 0) / last24h.length
          )
        : avg;

    periods.push({
      siteChangeTime: start,
      siteChangeDate: siteChanges[i].date,
      notes: siteChanges[i].notes,
      endTime: end,
      ageDays,
      avgGlucose: avg,
      tir: Math.round((inRange / values.length) * 100),
      lowPercent: Math.round((low / values.length) * 100),
      highPercent: Math.round((high / values.length) * 100),
      readingCount: values.length,
      avgISF: isfCount > 0 ? Math.round(totalISF / isfCount) : 0,
      correctionCount: isfCount,
      effectiveRate:
        isfCount > 0 ? Math.round((effectiveCount / isfCount) * 100) : 0,
      first24hAvg,
      last24hAvg,
      degradation: last24hAvg - first24hAvg,
    });
  }

  return periods;
}

// ── Bolus Response Analysis ──

export interface BolusResponse {
  bolusTime: number;
  insulin: number;
  carbsWithBolus: number | null;
  preBolus: number; // glucose at bolus time
  glucoseAt30: number | null;
  glucoseAt60: number | null;
  glucoseAt120: number | null;
  glucoseAt180: number | null;
  peakGlucose: number;
  peakTimeMin: number; // minutes after bolus
  nadirGlucose: number;
  nadirTimeMin: number;
  trajectory: { minutesAfter: number; sgv: number }[];
}

/** Find glucose reading closest to a timestamp within a tolerance window */
function findClosestReading(
  readings: GlucoseReading[],
  targetTime: number,
  toleranceMs: number = 10 * 60_000 // ±10 min
): GlucoseReading | null {
  let closest: GlucoseReading | null = null;
  let minDiff = Infinity;
  for (const r of readings) {
    const diff = Math.abs(r.date - targetTime);
    if (diff < minDiff && diff <= toleranceMs) {
      minDiff = diff;
      closest = r;
    }
  }
  return closest;
}

/** Analyze glucose response to each bolus */
export function analyzeBolusResponses(
  readings: GlucoseReading[],
  boluses: Treatment[],
  carbs: Treatment[]
): BolusResponse[] {
  const sorted = [...readings].sort((a, b) => a.date - b.date);
  const responses: BolusResponse[] = [];

  for (const bolus of boluses) {
    const bTime = treatmentTime(bolus);
    const insulin = bolus.insulin || 0;
    if (insulin <= 0) continue;

    // Find carbs within ±15 min of bolus
    const matchingCarb = carbs.find(
      (c) => Math.abs(treatmentTime(c) - bTime) < 15 * 60_000
    );

    // Get pre-bolus glucose
    const preBolus = findClosestReading(sorted, bTime);
    if (!preBolus) continue;

    // Build 4-hour trajectory after bolus
    const trajectory: { minutesAfter: number; sgv: number }[] = [];
    let peakGlucose = preBolus.sgv;
    let peakTimeMin = 0;
    let nadirGlucose = preBolus.sgv;
    let nadirTimeMin = 0;

    for (const r of sorted) {
      const minAfter = (r.date - bTime) / 60_000;
      if (minAfter < -5 || minAfter > 240) continue; // -5 min to +4 hours
      trajectory.push({ minutesAfter: Math.round(minAfter), sgv: r.sgv });

      if (minAfter > 0) {
        if (r.sgv > peakGlucose) {
          peakGlucose = r.sgv;
          peakTimeMin = Math.round(minAfter);
        }
        if (r.sgv < nadirGlucose) {
          nadirGlucose = r.sgv;
          nadirTimeMin = Math.round(minAfter);
        }
      }
    }

    responses.push({
      bolusTime: bTime,
      insulin,
      carbsWithBolus: matchingCarb?.carbs ?? null,
      preBolus: preBolus.sgv,
      glucoseAt30: findClosestReading(sorted, bTime + 30 * 60_000)?.sgv ?? null,
      glucoseAt60: findClosestReading(sorted, bTime + 60 * 60_000)?.sgv ?? null,
      glucoseAt120: findClosestReading(sorted, bTime + 120 * 60_000)?.sgv ?? null,
      glucoseAt180: findClosestReading(sorted, bTime + 180 * 60_000)?.sgv ?? null,
      peakGlucose,
      peakTimeMin,
      nadirGlucose,
      nadirTimeMin,
      trajectory,
    });
  }

  return responses;
}

// ── Basal Adequacy Analysis ──

export interface BasalPeriodAnalysis {
  startHour: number;
  endHour: number;
  label: string;
  avgGlucoseChange: number; // mg/dL per hour during fasting
  fastingPeriods: number; // how many fasting stretches we found
  totalMinutes: number;
  verdict: "adequate" | "too_low" | "too_high" | "insufficient_data";
  currentBasalRate: number | null;
}

/** Analyze basal adequacy by finding fasting periods (no bolus/carbs for 4+ hours) */
export function analyzeBasalAdequacy(
  readings: GlucoseReading[],
  boluses: Treatment[],
  carbs: Treatment[],
  basals: Treatment[]
): BasalPeriodAnalysis[] {
  const sorted = [...readings].sort((a, b) => a.date - b.date);

  // Create a set of "non-fasting" timestamps — any time within 4 hours of a bolus or carb
  const nonFastingPeriods: { start: number; end: number }[] = [];
  for (const t of [...boluses, ...carbs]) {
    const time = treatmentTime(t);
    nonFastingPeriods.push({ start: time, end: time + 4 * 60 * 60_000 });
  }

  function isFasting(time: number): boolean {
    return !nonFastingPeriods.some((p) => time >= p.start && time <= p.end);
  }

  // Analyze 3-hour time blocks
  const blocks = [
    { startHour: 0, endHour: 3, label: "12a–3a" },
    { startHour: 3, endHour: 6, label: "3a–6a" },
    { startHour: 6, endHour: 9, label: "6a–9a" },
    { startHour: 9, endHour: 12, label: "9a–12p" },
    { startHour: 12, endHour: 15, label: "12p–3p" },
    { startHour: 15, endHour: 18, label: "3p–6p" },
    { startHour: 18, endHour: 21, label: "6p–9p" },
    { startHour: 21, endHour: 24, label: "9p–12a" },
  ];

  return blocks.map(({ startHour, endHour, label }) => {
    // Find fasting readings in this time block
    const blockReadings = sorted.filter((r) => {
      const h = localHour(r.date);
      return h >= startHour && h < endHour && isFasting(r.date);
    });

    if (blockReadings.length < 6) {
      // Need at least 30 minutes of fasting data
      return {
        startHour,
        endHour,
        label,
        avgGlucoseChange: 0,
        fastingPeriods: 0,
        totalMinutes: 0,
        verdict: "insufficient_data" as const,
        currentBasalRate: findBasalRateForHour(basals, startHour),
      };
    }

    // Calculate average rate of change per hour during fasting
    let totalChange = 0;
    let segments = 0;
    for (let i = 1; i < blockReadings.length; i++) {
      const dt = (blockReadings[i].date - blockReadings[i - 1].date) / 3_600_000; // hours
      if (dt > 0 && dt < 0.5) {
        // Only count consecutive readings (<30 min apart)
        const dg = blockReadings[i].sgv - blockReadings[i - 1].sgv;
        totalChange += dg / dt;
        segments++;
      }
    }

    const avgChange = segments > 0 ? totalChange / segments : 0;
    const totalMinutes = Math.round(
      (blockReadings[blockReadings.length - 1].date - blockReadings[0].date) / 60_000
    );

    let verdict: BasalPeriodAnalysis["verdict"];
    if (Math.abs(avgChange) <= 10) verdict = "adequate"; // ±10 mg/dL/hr is fine
    else if (avgChange > 10) verdict = "too_low"; // rising = basal too low
    else verdict = "too_high"; // falling = basal too high

    return {
      startHour,
      endHour,
      label,
      avgGlucoseChange: Math.round(avgChange),
      fastingPeriods: segments,
      totalMinutes,
      verdict,
      currentBasalRate: findBasalRateForHour(basals, startHour),
    };
  });
}

// ── Basal Fasting Trajectories (for visualization) ──

export interface FastingTrajectory {
  blockLabel: string;
  startHour: number;
  date: string; // YYYY-MM-DD
  baseline: number; // glucose at start
  points: { minutesIn: number; delta: number }[]; // change from baseline
  durationMin: number;
  driftPerHour: number; // mg/dL per hour
}

/** Extract individual fasting trajectories for charting */
export function extractFastingTrajectories(
  readings: GlucoseReading[],
  boluses: Treatment[],
  carbs: Treatment[]
): FastingTrajectory[] {
  const sorted = [...readings].sort((a, b) => a.date - b.date);

  // Build non-fasting windows: 4h after any bolus or carb
  const nonFasting: { start: number; end: number }[] = [];
  for (const t of [...boluses, ...carbs]) {
    const time = treatmentTime(t);
    nonFasting.push({ start: time - 30 * 60_000, end: time + 4 * 60 * 60_000 });
  }

  function isFasting(time: number): boolean {
    return !nonFasting.some((p) => time >= p.start && time <= p.end);
  }

  // Find contiguous fasting stretches of 1+ hour
  const trajectories: FastingTrajectory[] = [];
  let currentStretch: GlucoseReading[] = [];

  for (const r of sorted) {
    if (isFasting(r.date)) {
      // Check continuity — readings should be within 10 min of each other
      if (
        currentStretch.length === 0 ||
        r.date - currentStretch[currentStretch.length - 1].date < 15 * 60_000
      ) {
        currentStretch.push(r);
      } else {
        if (currentStretch.length >= 12) finalizeStretch(currentStretch);
        currentStretch = [r];
      }
    } else {
      if (currentStretch.length >= 12) finalizeStretch(currentStretch);
      currentStretch = [];
    }
  }
  if (currentStretch.length >= 12) finalizeStretch(currentStretch);

  function finalizeStretch(stretch: GlucoseReading[]) {
    const startTime = stretch[0].date;
    const endTime = stretch[stretch.length - 1].date;
    const durationMin = (endTime - startTime) / 60_000;
    if (durationMin < 60) return; // need at least 1 hour

    const baseline = stretch[0].sgv;
    const startHour = localHour(startTime);
    const dateStr = localDateKey(startTime);

    // Determine block label
    let blockLabel: string;
    if (startHour >= 0 && startHour < 3) blockLabel = "12a–3a";
    else if (startHour < 6) blockLabel = "3a–6a";
    else if (startHour < 9) blockLabel = "6a–9a";
    else if (startHour < 12) blockLabel = "9a–12p";
    else if (startHour < 15) blockLabel = "12p–3p";
    else if (startHour < 18) blockLabel = "3p–6p";
    else if (startHour < 21) blockLabel = "6p–9p";
    else blockLabel = "9p–12a";

    const points = stretch.map((r) => ({
      minutesIn: Math.round((r.date - startTime) / 60_000),
      delta: r.sgv - baseline,
    }));

    // Limit to 4 hours
    const capped = points.filter((p) => p.minutesIn <= 240);

    const lastPt = capped[capped.length - 1];
    const driftPerHour =
      lastPt && lastPt.minutesIn > 0
        ? Math.round((lastPt.delta / (lastPt.minutesIn / 60)) * 10) / 10
        : 0;

    trajectories.push({
      blockLabel,
      startHour,
      date: dateStr,
      baseline,
      points: capped,
      durationMin: Math.round(Math.min(durationMin, 240)),
      driftPerHour,
    });
  }

  return trajectories;
}

function findBasalRateForHour(
  basals: Treatment[],
  hour: number
): number | null {
  // Find the most recent basal rate active during this hour
  const targetMinute = hour * 60;
  for (const b of basals) {
    const d = new Date(treatmentTime(b));
    const bMin = localHour(d) * 60 + d.getMinutes();
    if (Math.abs(bMin - targetMinute) < 60) {
      return b.rate || b.absolute || null;
    }
  }
  return null;
}

// ── Carb Ratio Analysis ──

export interface CarbRatioResult {
  mealTime: number;
  carbs: number;
  insulin: number;
  effectiveRatio: number; // carbs / insulin
  preMeal: number;
  glucoseAt2h: number | null;
  outcome: "low" | "in_range" | "high" | "very_high";
  timeOfDay: string;
}

/** Analyze carb-to-insulin ratio effectiveness */
export function analyzeCarbRatios(
  readings: GlucoseReading[],
  boluses: Treatment[],
  carbs: Treatment[]
): CarbRatioResult[] {
  const sorted = [...readings].sort((a, b) => a.date - b.date);
  const results: CarbRatioResult[] = [];

  for (const carb of carbs) {
    const cTime = treatmentTime(carb);
    const carbGrams = carb.carbs || 0;
    if (carbGrams <= 0) continue;

    // Find bolus within ±15 min
    const matchingBolus = boluses.find(
      (b) => Math.abs(treatmentTime(b) - cTime) < 15 * 60_000
    );
    if (!matchingBolus || !matchingBolus.insulin) continue;

    const insulin = matchingBolus.insulin;
    const preMeal = findClosestReading(sorted, cTime);
    const at2h = findClosestReading(sorted, cTime + 120 * 60_000);

    if (!preMeal) continue;

    const glucoseAt2h = at2h?.sgv ?? null;
    let outcome: CarbRatioResult["outcome"];
    if (glucoseAt2h === null) outcome = "in_range";
    else if (glucoseAt2h < 70) outcome = "low";
    else if (glucoseAt2h <= 180) outcome = "in_range";
    else if (glucoseAt2h <= 250) outcome = "high";
    else outcome = "very_high";

    const hour = localHour(cTime);
    let timeOfDay: string;
    if (hour >= 6 && hour < 10) timeOfDay = "Breakfast";
    else if (hour >= 10 && hour < 14) timeOfDay = "Lunch";
    else if (hour >= 14 && hour < 17) timeOfDay = "Snack";
    else if (hour >= 17 && hour < 22) timeOfDay = "Dinner";
    else timeOfDay = "Late Night";

    results.push({
      mealTime: cTime,
      carbs: carbGrams,
      insulin,
      effectiveRatio: Math.round((carbGrams / insulin) * 10) / 10,
      preMeal: preMeal.sgv,
      glucoseAt2h,
      outcome,
      timeOfDay,
    });
  }

  return results;
}

// ── Merged Meal Events (combine boluses within 30-min window) ──

export interface MealEvent {
  startTime: number;
  endTime: number;
  totalInsulin: number;
  totalCarbs: number;
  bolusCount: number;
  preMeal: number;
  trajectory: { minutesAfter: number; sgv: number }[];
  glucoseAt60: number | null;
  glucoseAt120: number | null;
  glucoseAt180: number | null;
  peakGlucose: number;
  peakTimeMin: number;
  timeOfDay: string;
  source: "carb_entry" | "bolus_inferred"; // how this meal was detected
}

/** Merge boluses within a 30-minute window into single meal events */
export function analyzeMealEvents(
  readings: GlucoseReading[],
  boluses: Treatment[],
  carbs: Treatment[]
): MealEvent[] {
  const sorted = [...readings].sort((a, b) => a.date - b.date);

  // STRATEGY: Detect meals from TWO sources:
  // 1. Carb entries (explicit meals — always reliable when present)
  // 2. Large boluses (>=3U) during meal hours WITHOUT carb entries nearby
  //    (catches breakfasts where carbs weren't logged on the pump)
  //
  // Dedup: any meal anchor within 3 hours of another is merged.

  interface MealAnchor {
    time: number;
    carbs: number;
    source: "carb_entry" | "bolus_inferred";
  }

  const anchors: MealAnchor[] = [];

  // Source 1: Carb entries
  for (const c of carbs) {
    if ((c.carbs || 0) > 0) {
      anchors.push({
        time: treatmentTime(c),
        carbs: c.carbs || 0,
        source: "carb_entry",
      });
    }
  }

  // Source 2: Large boluses without nearby carb entries
  // A bolus >= 3U during meal hours (6-10, 11-14, 17-21) without carbs = inferred meal
  const mealHours = [
    [6, 10],   // Breakfast
    [11, 14],  // Lunch
    [17, 21],  // Dinner
  ];

  for (const b of boluses) {
    if ((b.insulin || 0) < 3) continue;
    const bt = treatmentTime(b);
    const hour = localHour(bt);
    const isMealHour = mealHours.some(([s, e]) => hour >= s && hour < e);
    if (!isMealHour) continue;

    // Check if there's already a carb entry nearby (within 30 min)
    const hasCarbs = carbs.some((c) => {
      const ct = treatmentTime(c);
      return Math.abs(ct - bt) < 30 * 60_000 && (c.carbs || 0) > 0;
    });
    if (hasCarbs) continue; // already captured by source 1

    // Check if there's already an anchor nearby (avoid duplicates)
    const hasAnchor = anchors.some((a) => Math.abs(a.time - bt) < 30 * 60_000);
    if (hasAnchor) continue;

    anchors.push({
      time: bt,
      carbs: 0, // unknown carbs
      source: "bolus_inferred",
    });
  }

  // Sort by time and dedup within 3-hour windows
  anchors.sort((a, b) => a.time - b.time);
  const dedupedAnchors: MealAnchor[] = [];
  for (const anchor of anchors) {
    const overlap = dedupedAnchors.find(
      (existing) => Math.abs(existing.time - anchor.time) < 3 * 60 * 60_000
    );
    if (overlap) {
      // Prefer carb_entry over bolus_inferred; keep higher carbs
      if (
        anchor.source === "carb_entry" && overlap.source === "bolus_inferred"
      ) {
        const idx = dedupedAnchors.indexOf(overlap);
        dedupedAnchors[idx] = anchor;
      } else if (anchor.carbs > overlap.carbs) {
        const idx = dedupedAnchors.indexOf(overlap);
        dedupedAnchors[idx] = anchor;
      }
    } else {
      dedupedAnchors.push(anchor);
    }
  }

  return dedupedAnchors.map((anchor) => {
    const mealTime = anchor.time;
    const mealCarbs = anchor.carbs;

    // Find all boluses within ±30 min
    const nearbyBoluses = boluses.filter((b) => {
      const bt = treatmentTime(b);
      return Math.abs(bt - mealTime) < 30 * 60_000 && (b.insulin || 0) > 0;
    });

    // Total insulin associated with this meal
    const totalInsulin = nearbyBoluses.reduce((s, b) => s + (b.insulin || 0), 0);

    // Build trajectory from meal time
    const trajectory: { minutesAfter: number; sgv: number }[] = [];
    let peakGlucose = 0;
    let peakTimeMin = 0;

    const preMeal = findClosestReading(sorted, mealTime);

    for (const r of sorted) {
      const minAfter = (r.date - mealTime) / 60_000;
      if (minAfter < -5 || minAfter > 240) continue;
      trajectory.push({ minutesAfter: Math.round(minAfter), sgv: r.sgv });
      if (minAfter > 0 && r.sgv > peakGlucose) {
        peakGlucose = r.sgv;
        peakTimeMin = Math.round(minAfter);
      }
    }

    const hour = localHour(mealTime);
    let timeOfDay: string;
    if (hour >= 6 && hour < 10) timeOfDay = "Breakfast";
    else if (hour >= 10 && hour < 14) timeOfDay = "Lunch";
    else if (hour >= 14 && hour < 17) timeOfDay = "Snack";
    else if (hour >= 17 && hour < 22) timeOfDay = "Dinner";
    else timeOfDay = "Late Night";

    return {
      startTime: mealTime,
      endTime: mealTime,
      totalInsulin: Math.round(totalInsulin * 100) / 100,
      totalCarbs: mealCarbs,
      bolusCount: nearbyBoluses.length,
      preMeal: preMeal?.sgv || 0,
      trajectory,
      glucoseAt60: findClosestReading(sorted, mealTime + 60 * 60_000)?.sgv ?? null,
      glucoseAt120: findClosestReading(sorted, mealTime + 120 * 60_000)?.sgv ?? null,
      glucoseAt180: findClosestReading(sorted, mealTime + 180 * 60_000)?.sgv ?? null,
      peakGlucose,
      peakTimeMin,
      timeOfDay,
      source: anchor.source,
    };
  });
}

// ── Insulin Sensitivity Factor (ISF) by Time of Day ──

export interface ISFDataPoint {
  time: number; // epoch ms of the correction
  hour: number;
  insulin: number;
  preBolus: number;
  glucoseAt2h: number;
  drop: number; // pre - 2h
  isf: number; // drop / insulin (mg/dL per unit)
  effective: boolean; // did glucose actually drop?
  negative: boolean; // glucose ROSE after correction — possible site failure
  siteAgeHours: number | null; // hours since last site change
}

export interface ISFByPeriod {
  period: string;
  label: string;
  avgISF: number;
  medianISF: number;
  dataPoints: ISFDataPoint[];
  effectiveRate: number; // % of corrections that worked
}

/** Calculate observed ISF from correction boluses (no carbs nearby) */
export function analyzeISF(
  readings: GlucoseReading[],
  boluses: Treatment[],
  carbs: Treatment[],
  allTreatments?: Treatment[]
): { dataPoints: ISFDataPoint[]; byPeriod: ISFByPeriod[] } {
  const sorted = [...readings].sort((a, b) => a.date - b.date);
  const siteChanges = allTreatments ? extractSiteChanges(allTreatments) : [];

  // Find correction boluses: insulin with no carbs within ±30 min
  const corrections = boluses.filter((b) => {
    if (!b.insulin || b.insulin <= 0) return false;
    const bt = treatmentTime(b);
    return !carbs.some((c) => Math.abs(treatmentTime(c) - bt) < 30 * 60_000);
  });

  const dataPoints: ISFDataPoint[] = [];

  for (const corr of corrections) {
    const ct = treatmentTime(corr);
    const pre = findClosestReading(sorted, ct);
    const post = findClosestReading(sorted, ct + 120 * 60_000);
    if (!pre || !post || pre.sgv < 100) continue;

    const drop = pre.sgv - post.sgv;
    const isf = Math.round(drop / (corr.insulin || 1));

    dataPoints.push({
      time: ct,
      hour: localHour(ct),
      insulin: corr.insulin || 0,
      preBolus: pre.sgv,
      glucoseAt2h: post.sgv,
      drop,
      isf,
      effective: drop > 10,
      negative: drop < 0, // glucose rose despite correction
      siteAgeHours: getSiteAgeAt(siteChanges, ct),
    });
  }

  // Group by time period
  const periods = [
    { period: "overnight", label: "Overnight (12a-6a)", startH: 0, endH: 6 },
    { period: "morning", label: "Morning (6a-12p)", startH: 6, endH: 12 },
    { period: "afternoon", label: "Afternoon (12p-6p)", startH: 12, endH: 18 },
    { period: "evening", label: "Evening (6p-12a)", startH: 18, endH: 24 },
  ];

  const byPeriod: ISFByPeriod[] = periods.map(({ period, label, startH, endH }) => {
    const pts = dataPoints.filter((d) => d.hour >= startH && d.hour < endH);
    if (pts.length === 0) {
      return { period, label, avgISF: 0, medianISF: 0, dataPoints: pts, effectiveRate: 0 };
    }
    const isfs = pts.map((d) => d.isf).sort((a, b) => a - b);
    const effective = pts.filter((d) => d.effective).length;
    return {
      period,
      label,
      avgISF: Math.round(isfs.reduce((s, v) => s + v, 0) / isfs.length),
      medianISF: isfs[Math.floor(isfs.length / 2)],
      dataPoints: pts,
      effectiveRate: Math.round((effective / pts.length) * 100),
    };
  });

  return { dataPoints, byPeriod };
}

// ── Out-of-Range Episode Clustering ──

export interface OutOfRangeEpisode {
  startTime: number;
  endTime: number;
  durationMin: number;
  type: "high" | "low";
  peakValue: number; // highest for highs, lowest for lows
  avgValue: number;
  hourOfDay: number;
  dayOfWeek: string;
  // Context: what was happening before/during
  insulinBefore2h: number; // total insulin in 2h before episode
  carbsBefore2h: number;
  basalRateDuring: number | null;
  controlIQCorrections: number; // auto-corrections during episode
  readings: number;
}

export interface EpisodeCluster {
  label: string;
  episodes: OutOfRangeEpisode[];
  commonHour: number;
  commonDay: string | null;
  avgDuration: number;
  avgPeak: number;
  possibleCause: string;
}

/** Find contiguous out-of-range episodes and cluster by characteristics */
export function analyzeOutOfRangeEpisodes(
  readings: GlucoseReading[],
  boluses: Treatment[],
  carbs: Treatment[],
  basals: Treatment[]
): { episodes: OutOfRangeEpisode[]; clusters: EpisodeCluster[] } {
  const sorted = [...readings].sort((a, b) => a.date - b.date);
  const episodes: OutOfRangeEpisode[] = [];

  // Find contiguous high (>250 for 30+ min) and low (<70 for 15+ min) periods
  let currentEpisode: { type: "high" | "low"; readings: GlucoseReading[] } | null = null;

  for (const r of sorted) {
    const isHigh = r.sgv > 250;
    const isLow = r.sgv < 70;

    if (isHigh || isLow) {
      const type = isHigh ? "high" : "low";
      if (currentEpisode && currentEpisode.type === type) {
        currentEpisode.readings.push(r);
      } else {
        if (currentEpisode) finalizeEpisode(currentEpisode);
        currentEpisode = { type, readings: [r] };
      }
    } else {
      if (currentEpisode) finalizeEpisode(currentEpisode);
      currentEpisode = null;
    }
  }
  if (currentEpisode) finalizeEpisode(currentEpisode);

  function finalizeEpisode(ep: { type: "high" | "low"; readings: GlucoseReading[] }) {
    const dur = (ep.readings[ep.readings.length - 1].date - ep.readings[0].date) / 60_000;
    const minDur = ep.type === "high" ? 30 : 15;
    if (dur < minDur || ep.readings.length < 3) return;

    const startTime = ep.readings[0].date;
    const endTime = ep.readings[ep.readings.length - 1].date;
    const values = ep.readings.map((r) => r.sgv);
    const dt = new Date(startTime);

    // Context: insulin and carbs in 2h before
    const windowStart = startTime - 2 * 60 * 60_000;
    const insulinBefore = boluses
      .filter((b) => {
        const t = treatmentTime(b);
        return t >= windowStart && t <= startTime;
      })
      .reduce((s, b) => s + (b.insulin || 0), 0);
    const carbsBefore = carbs
      .filter((c) => {
        const t = treatmentTime(c);
        return t >= windowStart && t <= startTime;
      })
      .reduce((s, c) => s + (c.carbs || 0), 0);

    // Control-IQ auto-corrections during episode
    const autoCorr = boluses.filter((b) => {
      const t = treatmentTime(b);
      return (
        t >= startTime &&
        t <= endTime &&
        b.enteredBy?.includes("tconnectsync") &&
        (b.insulin || 0) > 0
      );
    }).length;

    // Most recent basal rate
    const recentBasal = basals.find((b) => {
      const t = treatmentTime(b);
      return t <= startTime && t >= startTime - 60 * 60_000;
    });

    episodes.push({
      startTime,
      endTime,
      durationMin: Math.round(dur),
      type: ep.type,
      peakValue: ep.type === "high" ? maxOf(values) : minOf(values),
      avgValue: Math.round(values.reduce((s, v) => s + v, 0) / values.length),
      hourOfDay: localHour(dt),
      dayOfWeek: dt.toLocaleDateString("en-US", { weekday: "short" }),
      insulinBefore2h: Math.round(insulinBefore * 100) / 100,
      carbsBefore2h: carbsBefore,
      basalRateDuring: recentBasal?.rate || recentBasal?.absolute || null,
      controlIQCorrections: autoCorr,
      readings: ep.readings.length,
    });
  }

  // Cluster episodes by time-of-day similarity
  const clusters: EpisodeCluster[] = [];

  // Group highs by 4-hour blocks
  const highEps = episodes.filter((e) => e.type === "high");
  const blocks = [
    { label: "Overnight Highs (12a-6a)", startH: 0, endH: 6 },
    { label: "Morning Highs (6a-12p)", startH: 6, endH: 12 },
    { label: "Afternoon Highs (12p-6p)", startH: 12, endH: 18 },
    { label: "Evening Highs (6p-12a)", startH: 18, endH: 24 },
  ];

  for (const block of blocks) {
    const eps = highEps.filter(
      (e) => e.hourOfDay >= block.startH && e.hourOfDay < block.endH
    );
    if (eps.length < 2) continue;

    const avgCorr = eps.reduce((s, e) => s + e.controlIQCorrections, 0) / eps.length;
    const avgInsulin = eps.reduce((s, e) => s + e.insulinBefore2h, 0) / eps.length;
    const avgCarbs = eps.reduce((s, e) => s + e.carbsBefore2h, 0) / eps.length;

    let possibleCause = "";
    if (avgCorr > 3 && eps.some((e) => e.durationMin > 120)) {
      possibleCause =
        "Control-IQ delivering multiple corrections with poor effect — possible site absorption issue or insulin resistance";
    } else if (avgCarbs > 30 && avgInsulin < 3) {
      possibleCause = "High carb intake with relatively low insulin coverage";
    } else if (block.startH === 0 && avgCorr > 2) {
      possibleCause =
        "Overnight resistance pattern — may correlate with growth hormone dose, high-fat dinner, or aging infusion site";
    } else {
      possibleCause = "Recurring pattern in this time window — review with endo";
    }

    // Find most common day
    const dayCounts = new Map<string, number>();
    eps.forEach((e) => dayCounts.set(e.dayOfWeek, (dayCounts.get(e.dayOfWeek) || 0) + 1));
    const topDay = [...dayCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const commonDay = topDay && topDay[1] >= eps.length * 0.5 ? topDay[0] : null;

    clusters.push({
      label: block.label,
      episodes: eps,
      commonHour: Math.round(eps.reduce((s, e) => s + e.hourOfDay, 0) / eps.length),
      commonDay,
      avgDuration: Math.round(eps.reduce((s, e) => s + e.durationMin, 0) / eps.length),
      avgPeak: Math.round(eps.reduce((s, e) => s + e.peakValue, 0) / eps.length),
      possibleCause,
    });
  }

  // Same for lows
  const lowEps = episodes.filter((e) => e.type === "low");
  const lowBlocks = [
    { label: "Overnight Lows (12a-6a)", startH: 0, endH: 6 },
    { label: "Daytime Lows (6a-6p)", startH: 6, endH: 18 },
    { label: "Evening Lows (6p-12a)", startH: 18, endH: 24 },
  ];

  for (const block of lowBlocks) {
    const eps = lowEps.filter(
      (e) => e.hourOfDay >= block.startH && e.hourOfDay < block.endH
    );
    if (eps.length < 2) continue;

    let possibleCause = "";
    if (block.startH === 0) {
      possibleCause =
        "Overnight lows may indicate: basal rate too high, missed growth hormone dose (reduces insulin resistance), or overcorrection from evening bolus";
    } else {
      possibleCause = "Recurring low pattern — review basal rate and bolus timing with endo";
    }

    clusters.push({
      label: block.label,
      episodes: eps,
      commonHour: Math.round(eps.reduce((s, e) => s + e.hourOfDay, 0) / eps.length),
      commonDay: null,
      avgDuration: Math.round(eps.reduce((s, e) => s + e.durationMin, 0) / eps.length),
      avgPeak: Math.round(eps.reduce((s, e) => s + e.peakValue, 0) / eps.length),
      possibleCause,
    });
  }

  return { episodes, clusters };
}

// ── Growth Hormone Correlation ──
//
// Some patients take growth hormone (GH) at night. GH increases insulin
// resistance. When a dose is MISSED, the NEXT DAY the patient is more
// insulin-sensitive than their pump settings expect → daytime lows despite
// eating carbs normally. The signal is NOT overnight lows — it's next-day
// daytime lows with carbs on board.

export interface DaySummary {
  date: string; // YYYY-MM-DD
  dayOfWeek: string;
  // Daytime metrics (6 AM - 10 PM)
  daytimeAvg: number;
  daytimeMin: number;
  daytimeLowReadings: number; // count of readings <70
  daytimeLowPercent: number;
  daytimeCarbs: number; // total carbs logged
  daytimeBoluses: number; // total insulin
  lowsDespiteCarbs: boolean; // had lows within 3h of eating — key GH miss signal
  // Overnight metrics (previous night, 10 PM - 6 AM)
  overnightAvg: number;
  overnightMin: number;
  overnightHighPercent: number;
  overnightCorrections: number;
  overnightCorrectionInsulin: number;
  // Classification
  classification: "normal" | "suspect_missed_gh" | "suspect_resistance" | "mixed";
  ghMissConfidence: "none" | "low" | "medium" | "high";
  reasoning: string;
}

/** Analyze day-by-day patterns to detect potential missed growth hormone doses */
export function analyzeGrowthHormoneCorrelation(
  readings: GlucoseReading[],
  boluses: Treatment[],
  carbs?: Treatment[]
): DaySummary[] {
  const sorted = [...readings].sort((a, b) => a.date - b.date);
  const carbList = carbs || [];

  // Group readings by calendar date
  const byDate = new Map<string, GlucoseReading[]>();
  for (const r of sorted) {
    const key = localDateKey(r.date);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(r);
  }

  // First pass: compute average daily insulin for comparison
  let totalInsulinAllDays = 0;
  let daysWithInsulin = 0;
  for (const [date] of byDate) {
    const dayStart = new Date(date + "T06:00:00").getTime();
    const dayEnd = new Date(date + "T22:00:00").getTime();
    const dayInsulin = boluses
      .filter((b) => { const t = treatmentTime(b); return t >= dayStart && t <= dayEnd && (b.insulin || 0) > 0; })
      .reduce((s, b) => s + (b.insulin || 0), 0);
    if (dayInsulin > 0) {
      totalInsulinAllDays += dayInsulin;
      daysWithInsulin++;
    }
  }
  const avgDailyInsulin = daysWithInsulin > 0 ? Math.round((totalInsulinAllDays / daysWithInsulin) * 10) / 10 : 0;

  const summaries: DaySummary[] = [];

  for (const [date, dayReadings] of byDate) {
    if (dayReadings.length < 24) continue; // need at least 2 hours of data

    // Split into daytime (6 AM - 10 PM) and overnight (previous night: 10 PM - 6 AM)
    const daytime = dayReadings.filter((r) => {
      const h = localHour(r.date);
      return h >= 6 && h < 22;
    });
    const overnight = dayReadings.filter((r) => {
      const h = localHour(r.date);
      return h < 6; // Early morning hours = previous night's GH window
    });

    if (daytime.length < 12) continue;

    const dtValues = daytime.map((r) => r.sgv);
    const daytimeAvg = Math.round(dtValues.reduce((s, v) => s + v, 0) / dtValues.length);
    const daytimeMin = minOf(dtValues);
    const daytimeLowReadings = dtValues.filter((v) => v < 70).length;
    const daytimeLowPercent = Math.round((daytimeLowReadings / dtValues.length) * 100);

    // Daytime carbs and insulin
    const dayStart = new Date(date + "T06:00:00").getTime();
    const dayEnd = new Date(date + "T22:00:00").getTime();

    const daytimeCarbs = carbList
      .filter((c) => {
        const t = treatmentTime(c);
        return t >= dayStart && t <= dayEnd;
      })
      .reduce((s, c) => s + (c.carbs || 0), 0);

    const daytimeBoluses = boluses
      .filter((b) => {
        const t = treatmentTime(b);
        return t >= dayStart && t <= dayEnd && (b.insulin || 0) > 0;
      })
      .reduce((s, b) => s + (b.insulin || 0), 0);

    // KEY SIGNAL: Did lows happen within 3 hours of eating?
    // This distinguishes "missed GH" lows (low despite food) from fasting lows (just bad basal)
    // Count how many low readings occurred within 3h of eating
    // A single post-meal low is common (bolus timing, carb miscount).
    // A TRUE missed GH pattern shows MULTIPLE lows despite carbs throughout the day.
    let lowsDespiteCarbsCount = 0;
    const daytimeLows = daytime.filter((r) => r.sgv < 70);
    for (const low of daytimeLows) {
      const hadCarbsBefore = carbList.some((c) => {
        const ct = treatmentTime(c);
        return ct < low.date && ct > low.date - 3 * 60 * 60_000;
      });
      if (hadCarbsBefore) {
        lowsDespiteCarbsCount++;
      }
    }
    // Require at least 3 low readings near meals to flag — avoids false positives
    // from a single post-meal dip
    const lowsDespiteCarbs = lowsDespiteCarbsCount >= 3;

    // Overnight (previous night) metrics
    const onValues = overnight.length > 0 ? overnight.map((r) => r.sgv) : [];
    const overnightAvg = onValues.length > 0
      ? Math.round(onValues.reduce((s, v) => s + v, 0) / onValues.length) : 0;
    const overnightMin = onValues.length > 0 ? minOf(onValues) : 0;
    const overnightHighPercent = onValues.length > 0
      ? Math.round(onValues.filter((v) => v > 180).length / onValues.length * 100) : 0;

    const overnightStart = overnight.length > 0 ? overnight[0].date : dayStart - 6 * 60 * 60_000;
    const overnightEnd = overnight.length > 0 ? overnight[overnight.length - 1].date : dayStart;
    const overnightBoluses = boluses.filter((b) => {
      const t = treatmentTime(b);
      return t >= overnightStart && t <= overnightEnd && (b.insulin || 0) > 0;
    });
    const overnightCorrInsulin = overnightBoluses.reduce((s, b) => s + (b.insulin || 0), 0);

    // Classification logic — corrected for actual GH mechanism
    // A missed GH dose = next day the body is more insulin-sensitive.
    // Signals: multiple lows near meals, AND/OR less insulin needed than usual.
    const lowInsulinDay = avgDailyInsulin > 0 && daytimeBoluses < avgDailyInsulin * 0.7;
    let classification: DaySummary["classification"];
    let ghMissConfidence: DaySummary["ghMissConfidence"];
    let reasoning: string;

    if (lowsDespiteCarbs && daytimeLowPercent >= 10) {
      // Multiple daytime lows despite eating = signal for missed GH
      classification = "suspect_missed_gh";
      if ((daytimeLowPercent >= 20 && daytimeCarbs > 50) || (lowsDespiteCarbs && lowInsulinDay)) {
        ghMissConfidence = "high";
        reasoning = `${daytimeLowReadings} low readings (${lowsDespiteCarbsCount} near meals) despite ${daytimeCarbs}g carbs.${lowInsulinDay ? ` Only ${daytimeBoluses.toFixed(1)}U insulin used (avg ${avgDailyInsulin.toFixed(1)}U) — needed less insulin than usual.` : ""} Persistent lows despite eating is consistent with increased insulin sensitivity from missed growth hormone.`;
      } else if (daytimeLowPercent >= 15) {
        ghMissConfidence = "medium";
        reasoning = `Daytime lows (${daytimeLowPercent}%, ${lowsDespiteCarbsCount} near meals) with ${daytimeCarbs}g carbs consumed. Pattern suggests higher-than-expected insulin sensitivity.`;
      } else {
        ghMissConfidence = "low";
        reasoning = `Multiple daytime lows near meals (${lowsDespiteCarbsCount} occurrences). Possible missed GH but could also be aggressive bolusing.`;
      }
    } else if (
      overnightHighPercent > 40 &&
      overnightBoluses.length > 3 &&
      overnightCorrInsulin > 3
    ) {
      classification = "suspect_resistance";
      ghMissConfidence = "none";
      reasoning = `Overnight highs (${overnightHighPercent}% above 180) despite ${overnightBoluses.length} corrections (${overnightCorrInsulin.toFixed(1)}U). Insulin resistance pattern — may indicate site issue, high-fat dinner, or illness.`;
    } else if (daytimeLowPercent >= 10 && !lowsDespiteCarbs) {
      classification = "mixed";
      ghMissConfidence = "low";
      reasoning = `Daytime lows (${daytimeLowPercent}%) but not clearly linked to meals. Could be basal rate issue rather than GH miss.`;
    } else {
      classification = "normal";
      ghMissConfidence = "none";
      reasoning = `Normal day — ${daytimeAvg} avg, ${daytimeLowPercent}% lows.`;
    }

    const dt = new Date(date + "T12:00:00");
    summaries.push({
      date,
      dayOfWeek: dt.toLocaleDateString("en-US", { weekday: "short" }),
      daytimeAvg,
      daytimeMin,
      daytimeLowReadings,
      daytimeLowPercent,
      daytimeCarbs,
      daytimeBoluses: Math.round(daytimeBoluses * 10) / 10,
      lowsDespiteCarbs,
      overnightAvg,
      overnightMin,
      overnightHighPercent,
      overnightCorrections: overnightBoluses.length,
      overnightCorrectionInsulin: Math.round(overnightCorrInsulin * 10) / 10,
      classification,
      ghMissConfidence,
      reasoning,
    });
  }

  return summaries.sort((a, b) => b.date.localeCompare(a.date));
}
