// ClearSugar — Demo-mode synthetic data generator
//
// When DEMO_MODE=true, nightscout.ts routes every Nightscout API call through
// demoFetch() instead of hitting the network. This file owns the entire
// synthetic dataset: 14 days of 5-min CGM entries, matching treatments
// (meal boluses, corrections, temp basals, site changes, sensor starts), a
// plausible pump profile, a status doc, and a fresh devicestatus/pump-state
// doc — all deterministic given (seed, now) so screenshots are reproducible
// within a session and no real patient data is ever involved.
//
// No names anywhere — device strings are "demo-cgm" / "demo-pump".

import type {
  GlucoseReading,
  Treatment,
  PumpProfile,
  NightscoutStatus,
  PumpState,
  TrendDirection,
} from "./types";

/** Fixed seed — change only if you want a different (still deterministic) demo dataset. */
const SEED = 424242;

const FIVE_MIN_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const WINDOW_DAYS = 14;
const POINTS = WINDOW_DAYS * (DAY_MS / FIVE_MIN_MS); // 4032

const DEFAULT_PROFILE_NAME = "Demo";
const DIA_HOURS = 5;

export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "true";
}

// ── PRNG (mulberry32) — deterministic, no external dependency ──

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform random in [min, max) using the given PRNG. */
function rand(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function roundTo(v: number, step: number): number {
  return Math.round(v / step) * step;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Fractional local hour-of-day, e.g. 7:30am -> 7.5 */
function localHourFrac(ms: number): number {
  const d = new Date(ms);
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

function localMidnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ── Schedule helpers (mirrors physiological-model.ts's getScheduledValue) ──

type ScheduleEntry = { time: string; value: number; timeAsSeconds: number };

function hhmm(secondsOfDay: number): string {
  const h = Math.floor(secondsOfDay / 3600);
  const m = Math.floor((secondsOfDay % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function scheduleEntry(hour: number, value: number): ScheduleEntry {
  const secs = hour * 3600;
  return { time: hhmm(secs), value: round1(value), timeAsSeconds: secs };
}

function scheduledValue(schedule: ScheduleEntry[], atMs: number): number {
  const secondsOfDay = Math.floor((atMs - localMidnight(atMs)) / 1000);
  let value = schedule[0].value;
  for (const entry of schedule) {
    if (entry.timeAsSeconds <= secondsOfDay) value = entry.value;
    else break;
  }
  return value;
}

// ── Direction / trend mapping (Nightscout convention) ──

function directionFromDelta(delta: number | null): { direction: TrendDirection; trend: number } {
  if (delta === null) return { direction: "Flat", trend: 4 };
  if (delta >= 15) return { direction: "DoubleUp", trend: 1 };
  if (delta >= 10) return { direction: "SingleUp", trend: 2 };
  if (delta >= 5) return { direction: "FortyFiveUp", trend: 3 };
  if (delta > -5) return { direction: "Flat", trend: 4 };
  if (delta > -10) return { direction: "FortyFiveDown", trend: 5 };
  if (delta > -15) return { direction: "SingleDown", trend: 6 };
  return { direction: "DoubleDown", trend: 7 };
}

// ── Meal / low event model ──

interface MealEvent {
  atMs: number;
  carbs: number;
  insulin: number;
  preBg: number;
  kind: "meal" | "snack";
}

interface CorrectionEvent {
  atMs: number;
  insulin: number;
  automatic: boolean;
}

interface LowEvent {
  atMs: number;
  troughDepth: number; // mg/dL below the local baseline at the trough
  troughMinutesOut: number; // minutes from atMs to trough
}

/** Bateman-like single-peak absorption curve, normalized to peak 1.0 at t = tp. */
function batemanShape(minutesSince: number, tp: number, horizonMin: number): number {
  if (minutesSince < 0 || minutesSince > horizonMin) return 0;
  const x = minutesSince / tp;
  return x * Math.exp(1 - x);
}

interface DemoDataset {
  entries: GlucoseReading[]; // newest first
  treatments: Treatment[]; // newest first
  profile: PumpProfile;
  status: NightscoutStatus;
  pumpState: PumpState;
}

function buildDataset(seed: number, anchorMs: number): DemoDataset {
  const rng = mulberry32(seed);
  const startMs = anchorMs - (POINTS - 1) * FIVE_MIN_MS;
  const windowStartDay = localMidnight(startMs);
  const dayCount = Math.ceil((anchorMs - windowStartDay) / DAY_MS) + 1;

  // ── Profile (basal / carb ratio / ISF schedules) ──
  const basalSchedule: ScheduleEntry[] = [
    scheduleEntry(0, rand(rng, 0.85, 1.0)),
    scheduleEntry(4, rand(rng, 1.0, 1.2)),
    scheduleEntry(9, rand(rng, 0.85, 1.0)),
    scheduleEntry(15, rand(rng, 0.8, 0.95)),
    scheduleEntry(21, rand(rng, 0.9, 1.05)),
  ];
  const carbRatioSchedule: ScheduleEntry[] = [
    scheduleEntry(0, rand(rng, 9, 11)),
    scheduleEntry(7, rand(rng, 8, 9.5)),
    scheduleEntry(12, rand(rng, 9, 11)),
    scheduleEntry(18, rand(rng, 8.5, 10)),
  ];
  const sensSchedule: ScheduleEntry[] = [
    scheduleEntry(0, rand(rng, 43, 48)),
    scheduleEntry(6, rand(rng, 40, 45)),
    scheduleEntry(12, rand(rng, 45, 50)),
    scheduleEntry(18, rand(rng, 42, 47)),
  ];
  const targetLowSchedule: ScheduleEntry[] = [scheduleEntry(0, 70)];
  const targetHighSchedule: ScheduleEntry[] = [scheduleEntry(0, 180)];
  const timezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";

  const profile: PumpProfile = {
    _id: "demo-profile-1",
    defaultProfile: DEFAULT_PROFILE_NAME,
    startDate: iso(windowStartDay - 30 * DAY_MS),
    created_at: iso(windowStartDay - 30 * DAY_MS),
    store: {
      [DEFAULT_PROFILE_NAME]: {
        dia: DIA_HOURS,
        carbratio: carbRatioSchedule,
        sens: sensSchedule,
        basal: basalSchedule,
        target_low: targetLowSchedule,
        target_high: targetHighSchedule,
        timezone,
        units: "mg/dl",
      },
    },
  };

  function basalAt(ms: number): number {
    return scheduledValue(basalSchedule, ms);
  }
  function carbRatioAt(ms: number): number {
    return scheduledValue(carbRatioSchedule, ms);
  }
  function isfAt(ms: number): number {
    return scheduledValue(sensSchedule, ms);
  }

  // Baseline BG curve by time of day: gentle dawn-phenomenon rise, otherwise flat.
  function baselineAt(ms: number): number {
    const h = localHourFrac(ms);
    return 112 + 12 * Math.sin(((h - 3) / 24) * 2 * Math.PI);
  }

  // ── Per-day events: meals, corrections, site changes, sensor starts, lows ──
  const meals: MealEvent[] = [];
  const corrections: CorrectionEvent[] = [];
  const siteChanges: number[] = [];
  const sensorStarts: number[] = [];
  const lows: LowEvent[] = [];

  const mealSlots: { hour: number; jitter: number }[] = [
    { hour: 7.5, jitter: 0.75 },
    { hour: 12.25, jitter: 0.75 },
    { hour: 18.5, jitter: 0.75 },
  ];

  for (let day = -1; day <= dayCount; day++) {
    const dayStart = windowStartDay + day * DAY_MS;

    for (const slot of mealSlots) {
      const atMs = dayStart + Math.round((slot.hour + rand(rng, -slot.jitter, slot.jitter)) * HOUR_MS);
      if (atMs < startMs - 4 * HOUR_MS || atMs > anchorMs) continue;
      const carbs = roundTo(rand(rng, 30, 80), 5);
      const preBg = baselineAt(atMs) + rand(rng, -10, 10);
      const target = 110;
      const cr = carbRatioAt(atMs);
      const isf = isfAt(atMs);
      const insulin = clamp(
        round1(carbs / cr + (preBg - target) / isf),
        1,
        8
      );
      meals.push({ atMs, carbs, insulin, preBg, kind: "meal" });
    }

    // Occasional snack (no bolus math beyond a smaller carb+insulin pair)
    if (rng() < 0.25) {
      const atMs = dayStart + Math.round(rand(rng, 15, 20.5) * HOUR_MS);
      if (atMs >= startMs - 2 * HOUR_MS && atMs <= anchorMs) {
        const carbs = roundTo(rand(rng, 15, 30), 5);
        const preBg = baselineAt(atMs) + rand(rng, -10, 10);
        const insulin = clamp(round1(carbs / carbRatioAt(atMs)), 0.5, 4);
        meals.push({ atMs, carbs, insulin, preBg, kind: "snack" });
      }
    }

    // Manual correction bolus most days
    if (rng() < 0.6) {
      const atMs = dayStart + Math.round(rand(rng, 9, 22) * HOUR_MS);
      if (atMs >= startMs && atMs <= anchorMs) {
        corrections.push({ atMs, insulin: round1(rand(rng, 1, 3)), automatic: false });
      }
    }

    // CIQ automatic micro-correction boluses, a few per day
    const autoCount = Math.floor(rand(rng, 1, 4));
    for (let i = 0; i < autoCount; i++) {
      const atMs = dayStart + Math.round(rand(rng, 0, 24) * HOUR_MS);
      if (atMs >= startMs && atMs <= anchorMs) {
        corrections.push({ atMs, insulin: round1(rand(rng, 0.1, 0.6)), automatic: true });
      }
    }

    // Infusion site change roughly every 3 days
    if (day >= 0 && day % 3 === 0) {
      const atMs = dayStart + Math.round(rand(rng, 8, 10) * HOUR_MS);
      if (atMs >= startMs && atMs <= anchorMs) siteChanges.push(atMs);
    }

    // CGM sensor start roughly every 10 days
    if (day >= 0 && day % 10 === 0) {
      const atMs = dayStart + Math.round(rand(rng, 7, 9) * HOUR_MS);
      if (atMs >= startMs && atMs <= anchorMs) sensorStarts.push(atMs);
    }

    // ~2 mild lows per week
    if (rng() < 2 / 7) {
      const atMs = dayStart + Math.round(rand(rng, 1, 23) * HOUR_MS);
      if (atMs >= startMs && atMs <= anchorMs) {
        lows.push({
          atMs,
          troughDepth: rand(rng, 40, 52), // baseline(~112-124) minus this lands in 65-75
          troughMinutesOut: rand(rng, 15, 30),
        });
      }
    }
  }

  // ── CGM entries ──
  const chronoValues: number[] = new Array(POINTS);
  let noise = 0;
  for (let i = 0; i < POINTS; i++) {
    const t = startMs + i * FIVE_MIN_MS;
    let v = baselineAt(t);

    for (const meal of meals) {
      const dtMin = (t - meal.atMs) / 60_000;
      if (dtMin < 0 || dtMin > 240) continue;
      const peakRise = clamp(meal.carbs * (meal.kind === "meal" ? 2.6 : 1.8), 20, 140);
      v += peakRise * batemanShape(dtMin, 60, 240);
      // Occasional post-meal correction descent — insulin overshoot dips
      // toward the low-normal range 2.5-3.5h after the meal.
      if (meal.insulin > 3 && dtMin >= 90) {
        const dipDepth = 12 + (meal.insulin - 3) * 3;
        v -= dipDepth * batemanShape(dtMin - 90, 60, 150);
      }
    }

    for (const low of lows) {
      const dtMin = (t - low.atMs) / 60_000;
      if (dtMin < 0 || dtMin > 90) continue;
      v -= low.troughDepth * batemanShape(dtMin, low.troughMinutesOut, 90);
    }

    // AR(1) jitter for CGM-like noise
    noise = 0.85 * noise + (rng() - 0.5) * 6;
    v += noise;

    chronoValues[i] = Math.round(clamp(v, 45, 300));
  }

  const chronoEntries: GlucoseReading[] = new Array(POINTS);
  for (let i = 0; i < POINTS; i++) {
    const t = startMs + i * FIVE_MIN_MS;
    const sgv = chronoValues[i];
    const delta = i === 0 ? null : sgv - chronoValues[i - 1];
    const { direction, trend } = directionFromDelta(delta);
    chronoEntries[i] = {
      _id: `demo${t.toString(16)}`,
      sgv,
      date: t,
      dateString: iso(t),
      direction,
      trend,
      device: "demo-cgm",
      type: "sgv",
      mills: t,
      delta,
    };
  }

  function sgvNear(ms: number): number {
    const idx = clamp(Math.round((ms - startMs) / FIVE_MIN_MS), 0, POINTS - 1);
    return chronoValues[idx];
  }

  // ── Treatments ──
  const treatments: Treatment[] = [];
  const ENTERED_BY = "Pump (tconnectsync)";

  for (const meal of meals) {
    treatments.push({
      _id: `demo-meal-${meal.atMs}`,
      eventType: "Combo Bolus",
      created_at: iso(meal.atMs),
      enteredBy: ENTERED_BY,
      mills: meal.atMs,
      utcOffset: -new Date(meal.atMs).getTimezoneOffset(),
      insulin: meal.insulin,
      carbs: meal.carbs,
      glucose: Math.round(meal.preBg),
    });
  }

  for (const corr of corrections) {
    treatments.push({
      _id: `demo-corr-${corr.atMs}-${corr.automatic ? "auto" : "man"}`,
      eventType: "Combo Bolus",
      created_at: iso(corr.atMs),
      enteredBy: ENTERED_BY,
      mills: corr.atMs,
      utcOffset: -new Date(corr.atMs).getTimezoneOffset(),
      insulin: corr.insulin,
      carbs: null,
      glucose: Math.round(sgvNear(corr.atMs)),
      notes: corr.automatic ? "Automatic Bolus" : "Standard Bolus (Override)",
    });
  }

  for (const atMs of siteChanges) {
    treatments.push({
      _id: `demo-site-${atMs}`,
      eventType: "Site Change",
      created_at: iso(atMs),
      enteredBy: ENTERED_BY,
      mills: atMs,
      utcOffset: -new Date(atMs).getTimezoneOffset(),
      notes: "",
    });
  }

  for (const atMs of sensorStarts) {
    treatments.push({
      _id: `demo-sensor-${atMs}`,
      eventType: "Sensor Start",
      created_at: iso(atMs),
      enteredBy: ENTERED_BY,
      mills: atMs,
      utcOffset: -new Date(atMs).getTimezoneOffset(),
      reason: "CGM Session Joined",
    });
  }

  // Temp basals every 15 min across the window, rate modulated by current BG.
  const BASAL_STEP_MIN = 15;
  for (let t = startMs; t <= anchorMs; t += BASAL_STEP_MIN * 60_000) {
    const bg = sgvNear(t);
    const base = basalAt(t);
    let modifier = clamp(1 + (bg - 120) / 150, 0.2, 2.0);
    if (bg < 70) modifier = 0; // CIQ suspends near/at low
    const rate = roundTo(base * modifier, 0.05);
    treatments.push({
      _id: `demo-basal-${t}`,
      eventType: "Temp Basal",
      created_at: iso(t),
      enteredBy: ENTERED_BY,
      mills: t,
      utcOffset: -new Date(t).getTimezoneOffset(),
      rate,
      absolute: rate,
      duration: 30,
      reason: "Algorithm",
    });
  }

  treatments.sort((a, b) => b.mills - a.mills);

  // ── Status ──
  const status: NightscoutStatus = {
    status: "ok",
    name: "ClearSugar Demo",
    version: "demo-1.0.0",
    serverTime: iso(anchorMs),
    apiEnabled: true,
    settings: {
      units: "mg/dl",
      timeFormat: 12,
      customTitle: "ClearSugar Demo",
      theme: "default",
      thresholds: { bgHigh: 250, bgTargetTop: 180, bgTargetBottom: 70, bgLow: 70 },
    },
  };

  // ── Pump state / devicestatus (fresh within the last few minutes) ──
  const pumpStateAt = anchorMs - Math.round(rand(rng, 30, 240) * 1000); // 0.5-4 min ago
  const dia300 = DIA_HOURS * 60;
  let iob = 0;
  for (const t of treatments) {
    if (!t.insulin || t.insulin <= 0) continue;
    const ageMin = (pumpStateAt - t.mills) / 60_000;
    if (ageMin >= 0 && ageMin < dia300) {
      iob += t.insulin * Math.max(0, 1 - ageMin / dia300);
    }
  }
  const last24hInsulin = treatments
    .filter((t) => t.insulin && t.insulin > 0 && pumpStateAt - t.mills < DAY_MS)
    .reduce((s, t) => s + (t.insulin || 0), 0);
  const avgBasal =
    basalSchedule.reduce((s, e) => s + e.value, 0) / basalSchedule.length;
  const tdd = round1(last24hInsulin + avgBasal * 24);

  const pumpState: PumpState = {
    device: "demo-pump",
    created_at: iso(pumpStateAt),
    mills: pumpStateAt,
    pump: {
      clock: iso(pumpStateAt),
      iob: {
        iob: round1(iob),
        timestamp: iso(pumpStateAt),
        mills: pumpStateAt,
        eventCode: 66,
      },
    },
    controlIQ: {
      tdd,
      weightLb: 150,
      closedLoop: true,
      sleepSchedule: {
        startMin: 22 * 60,
        endMin: 5 * 60,
        enabled: true,
        activeDays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      },
      basalLimitUHr: 3.0,
      maxBolusU: 15,
      profileTargetMgdl: 112.5,
      serialNumber: "DEMO-0000001",
      softwareVersion: "1.0-demo",
    },
  };

  return {
    entries: chronoEntries.slice().reverse(), // newest first, matches Nightscout API order
    treatments,
    profile,
    status,
    pumpState,
  };
}

// ── Module-memory cache, bucketed to the same 5-min cadence as real CGM data ──

let cachedAnchorMs: number | null = null;
let cachedDataset: DemoDataset | null = null;

function getDataset(now: number): DemoDataset {
  const anchorMs = Math.floor(now / FIVE_MIN_MS) * FIVE_MIN_MS;
  if (cachedDataset && cachedAnchorMs === anchorMs) return cachedDataset;
  cachedDataset = buildDataset(SEED, anchorMs);
  cachedAnchorMs = anchorMs;
  return cachedDataset;
}

// ── fetchNS() interception point ──

/**
 * Serves synthetic data in place of every Nightscout REST call nightscout.ts
 * makes. Dispatches purely on the request path (+ the handful of query params
 * nightscout.ts actually sends), so every exported nightscout.ts function
 * works unmodified in demo mode.
 */
export function demoFetch<T>(path: string, params?: URLSearchParams): T {
  const dataset = getDataset(Date.now());

  if (path.endsWith("entries.json")) {
    const count = Number(params?.get("count") ?? 288);
    const sinceRaw = params?.get("find[date][$gte]");
    const since = sinceRaw ? Number(sinceRaw) : null;
    let entries = dataset.entries;
    if (since !== null && Number.isFinite(since)) {
      entries = entries.filter((e) => e.date >= since);
    }
    return entries.slice(0, count) as unknown as T;
  }

  if (path.endsWith("treatments.json")) {
    const count = Number(params?.get("count") ?? 100);
    const sinceRaw = params?.get("find[created_at][$gte]");
    const enteredByRegex = params?.get("find[enteredBy][$regex]");
    let treatments = dataset.treatments;
    if (sinceRaw) {
      const since = Date.parse(sinceRaw);
      if (Number.isFinite(since)) {
        treatments = treatments.filter((t) => t.mills >= since);
      }
    }
    if (enteredByRegex) {
      const needle = enteredByRegex.toLowerCase();
      treatments = treatments.filter((t) => t.enteredBy.toLowerCase().includes(needle));
    }
    return treatments.slice(0, count) as unknown as T;
  }

  if (path.endsWith("profile.json")) {
    const count = Number(params?.get("count") ?? 10);
    return [dataset.profile].slice(0, Math.max(1, count)) as unknown as T;
  }

  if (path.endsWith("status.json")) {
    return dataset.status as unknown as T;
  }

  if (path.endsWith("devicestatus.json")) {
    const count = Number(params?.get("count") ?? 1);
    return [dataset.pumpState].slice(0, Math.max(1, count)) as unknown as T;
  }

  throw new Error(`demo-data: no handler for Nightscout path "${path}"`);
}
