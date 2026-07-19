// ClearSugar — Failing-site absorption-deficit advisor (Phase 1 P1.4)
//
// Faithful TS port of the validated Python prototype
// (scripts/phase1_site_failure_proto.py + docs/phase1-site-failure.json).
// DO NOT redesign — the constants and signal below were tuned on 90 days /
// 37 site changes / 2 ketone episodes. Both ketones fire (incl. the Jun-12
// archetype: an overnight uncorrected high with NO human response), FP 0.93/wk
// with the meal veto.
//
// The signal — insulin_effect_deficit per 30-min window:
//   absorbed = IOB(t0) + delivered_in_window − IOB(t1)   (UNCLAMPED by autosens)
//   expected_drop = absorbed * ISF                         (flat profile sens ~70)
//   actual_drop   = BG(t0) − BG(t1)
// A site-failure VOTE for a window requires: BG elevated (start or end > 200),
// meaningful absorbed insulin (expected_drop ≥ 40 mg/dL), and the insulin not
// working (actual_drop < 50% of expected_drop).
//
// Why `delivered_in_window` is load-bearing: a naive IOB(t0)−IOB(t1) delta
// SILENTLY MISSES site failures because Control-IQ pushes high temp basals
// during highs (fresh delivery lifts IOB(t1) and masks the deficit). The
// validation scored the June-12 archetype as 0 without it. We count boluses
// landing in-window PLUS temp-basal delivery ABOVE scheduled basal (prorated by
// overlap) — the extra units CIQ actually pushed.
//
// Meal-confounder veto is ANNOUNCED-CARB ONLY: cob_rise (COB +>5g across the
// window) or recent_carb (≥5g carb treatment within 90 min). There is NO
// pre-rise / unannounced-carb veto: at a failing site the BG rises BECAUSE the
// insulin is not absorbing, so a rapid rise is the failure SIGNATURE, not a carb
// tell. The deficit test already requires meaningful absorbed insulin, which is
// what separates failure (rise despite insulin) from carbs (rise with little
// insulin effect). A pre-rise veto was tested and REJECTED — it suppressed the
// Jun-12 onset.

import type { Treatment, PumpProfile } from "../types";
import { calculateIOB, calculateCOB } from "./physiological-model";
import type { AdvisorInput, AdvisoryAction } from "./advisor-types";

// ── Tunable thresholds (validated defaults — match the Python) ──
const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

const WINDOW_MIN = 30; // one voting window
const BG_HIGH = 200; // mg/dL — only judge failure when elevated
const DEFICIT_FRAC = 0.5; // actual_drop must be < 50% of expected to vote
const MIN_EXPECTED_DROP = 40; // mg/dL of expected effect (~0.57u at ISF 70) to vote
const CONSEC_WINDOWS = 3; // consecutive voting windows -> firing (~90min sustained)

// Meal-confounder veto knobs (announced carbs only)
const VETO_COB_RISE = 5.0; // g: COB increase across window -> veto
const VETO_CARB_LOOKBACK_MIN = 90; // recent carb treatment within this -> veto
const VETO_CARB_GRAMS = 5.0; // carbs treatment >= this counts

const BG_TOLERANCE_MS = 8 * MIN_MS; // nearest-sgv match tolerance

// ── Profile helpers (faithful to the private getScheduledValue in
// physiological-model.ts; re-implemented here because that helper is not
// exported and delivered_in_window needs the scheduled basal directly). ──

function treatmentTime(t: Treatment): number {
  return t.mills || new Date(t.created_at).getTime();
}

function getScheduledValue(
  schedule: { time: string; value: number; timeAsSeconds: number }[],
  atTime: number
): number {
  if (schedule.length === 0) return 0;
  const d = new Date(atTime);
  const secondsOfDay = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  let value = schedule[0].value;
  for (const entry of schedule) {
    if (entry.timeAsSeconds <= secondsOfDay) {
      value = entry.value;
    } else {
      break;
    }
  }
  return value;
}

function getActiveProfile(profile: PumpProfile) {
  return profile.store[profile.defaultProfile];
}

// ── Signal primitives ──

/** Nearest sgv to targetMs within tolerance. */
function bgAt(
  readingsSorted: { date: number; sgv: number }[],
  dates: number[],
  targetMs: number,
  tolMs = BG_TOLERANCE_MS
): number | null {
  // bisect_left
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < targetMs) lo = mid + 1;
    else hi = mid;
  }
  let best: { dt: number; sgv: number } | null = null;
  for (const j of [lo - 1, lo]) {
    if (j >= 0 && j < readingsSorted.length) {
      const dt = Math.abs(readingsSorted[j].date - targetMs);
      if (dt <= tolMs && (best === null || dt < best.dt)) {
        best = { dt, sgv: readingsSorted[j].sgv };
      }
    }
  }
  return best ? best.sgv : null;
}

/**
 * Insulin DELIVERED in [t0, t1): boluses landing in-window plus Control-IQ
 * temp-basal delivery ABOVE scheduled basal, prorated by overlap. This is what
 * makes the absorbed measure honest during an active high — IOB(t0)−IOB(t1)
 * alone undercounts absorption when fresh insulin is delivered mid-window
 * (delivery lifts IOB(t1)), which is exactly the failing-site case.
 */
function deliveredInWindow(
  treatments: Treatment[],
  basalSched: { time: string; value: number; timeAsSeconds: number }[],
  t0: number,
  t1: number
): number {
  let d = 0;
  for (const t of treatments) {
    const ins = t.insulin;
    if (ins && ins > 0) {
      const tm = treatmentTime(t);
      if (t0 <= tm && tm < t1) {
        d += ins;
      }
    }
    if (t.eventType === "Temp Basal" && t.duration && t.duration > 0) {
      const st = treatmentTime(t);
      const et = st + t.duration * 60_000;
      const rate = t.absolute ?? t.rate ?? 0;
      const ovS = Math.max(st, t0);
      const ovE = Math.min(et, t1);
      if (ovE > ovS) {
        const sched = getScheduledValue(basalSched, st);
        d += (rate - sched) * ((ovE - ovS) / HOUR_MS);
      }
    }
  }
  return d;
}

export interface SiteFailureWindow {
  t0: number;
  t1: number;
  bg0: number;
  bg1: number;
  absorbed: number;
  expectedDrop: number;
  actualDrop: number;
  isf: number;
  rawVote: boolean;
  veto: "cob_rise" | "recent_carb" | null;
  vote: boolean;
}

/**
 * Evaluate ONE 30-min voting window ending at t1. Returns null when BG samples
 * are missing at either endpoint.
 */
function evaluateWindow(
  readingsSorted: { date: number; sgv: number }[],
  dates: number[],
  treatments: Treatment[],
  profile: PumpProfile,
  t0: number,
  t1: number
): SiteFailureWindow | null {
  const bg0 = bgAt(readingsSorted, dates, t0);
  const bg1 = bgAt(readingsSorted, dates, t1);
  if (bg0 === null || bg1 === null) return null;

  const active = getActiveProfile(profile);
  const basalSched = active.basal;
  const sens = active.sens;

  const iob0 = calculateIOB(treatments, profile, t0);
  const iob1 = calculateIOB(treatments, profile, t1);
  const delivered = deliveredInWindow(treatments, basalSched, t0, t1);
  // absorbed = on-board at start + delivered in-window − on-board at end.
  // UNCLAMPED by autosens. Counts insulin pushed AND metabolized during an
  // active high (the failing-site signature).
  const absorbed = iob0 + delivered - iob1;
  const isf = getScheduledValue(sens, Math.floor((t0 + t1) / 2));
  const expectedDrop = absorbed * isf;
  const actualDrop = bg0 - bg1;

  const elevated = bg0 > BG_HIGH || bg1 > BG_HIGH;
  const meaningful = expectedDrop >= MIN_EXPECTED_DROP;
  const deficit = actualDrop < DEFICIT_FRAC * expectedDrop;

  const rawVote = elevated && meaningful && deficit;

  // ── meal-confounder veto (announced carbs only) ──
  let veto: "cob_rise" | "recent_carb" | null = null;
  if (rawVote) {
    const cob0 = calculateCOB(treatments, t0);
    const cob1 = calculateCOB(treatments, t1);
    if (cob1 - cob0 > VETO_COB_RISE) {
      veto = "cob_rise";
    } else {
      const lb = t1 - VETO_CARB_LOOKBACK_MIN * MIN_MS;
      const recentCarb = treatments.some((t) => {
        const c = t.carbs ?? 0;
        if (c < VETO_CARB_GRAMS) return false;
        const tm = treatmentTime(t);
        return tm >= lb && tm <= t1;
      });
      if (recentCarb) veto = "recent_carb";
      // NOTE: a "rapid pre-window rise" veto was tested and REJECTED — at a
      // failing site BG rises BECAUSE insulin is not absorbing, so a rapid rise
      // is the SIGNATURE of failure, not evidence of carbs. Only the
      // announced-carb vetoes (cob_rise, recent_carb) remain.
    }
  }

  return {
    t0,
    t1,
    bg0,
    bg1,
    absorbed,
    expectedDrop,
    actualDrop,
    isf,
    rawVote,
    veto,
    vote: rawVote && veto === null,
  };
}

/**
 * Result of evaluating the site-failure signature at `now`.
 *
 *  - `veto` is true whenever the absorption-deficit signature CURRENTLY holds
 *    (the most recent window votes after the meal veto). This gates ALL insulin
 *    advice elsewhere (Hard Safety Rule #1): even a single strong deficit window
 *    vetoes, conservatively. The 3-consecutive-window rule gates the ADVISORY
 *    (the actual alert), not the veto.
 *  - `advisory` is non-null only when the SUSTAINED signature fires (≥3
 *    consecutive voting windows ending at the current window).
 */
export interface SiteFailureResult {
  veto: boolean;
  advisory: AdvisoryAction | null;
}

export function evaluateSiteFailure(input: AdvisorInput): SiteFailureResult {
  const { treatments, profile, now } = input;

  const readingsSorted = input.readings
    .filter((r) => typeof r.sgv === "number")
    .map((r) => ({ date: r.date, sgv: r.sgv }))
    .sort((a, b) => a.date - b.date);

  if (readingsSorted.length < 2) {
    return { veto: false, advisory: null };
  }
  const dates = readingsSorted.map((r) => r.date);
  const wMs = WINDOW_MIN * MIN_MS;

  // Evaluate the trailing run of consecutive windows ending at `now`. We walk
  // backwards window-by-window so we can both (a) decide the current veto from
  // the most-recent window and (b) measure how many consecutive windows have
  // voted, matching find_firings' coalescing in the prototype.
  const recent: SiteFailureWindow[] = [];
  // Walk back far enough to cover the consecutive-window requirement plus slack.
  const maxBack = CONSEC_WINDOWS + 4;
  for (let k = 0; k < maxBack; k++) {
    const t1 = now - k * wMs;
    const t0 = t1 - wMs;
    if (t0 < dates[0]) break;
    const w = evaluateWindow(readingsSorted, dates, treatments, profile, t0, t1);
    if (w === null) break; // missing BG breaks the run (matches the Python skip)
    recent.push(w); // recent[0] is the current (most-recent) window
  }

  if (recent.length === 0) {
    return { veto: false, advisory: null };
  }

  const current = recent[0];

  // Count consecutive voting windows from `now` backwards.
  let consec = 0;
  for (const w of recent) {
    if (w.vote) consec++;
    else break;
  }

  // Veto: conservative — the current window holds an absorption deficit.
  const veto = current.vote;

  if (consec < CONSEC_WINDOWS) {
    return { veto, advisory: null };
  }

  // ── Sustained signature fires → build the change-site advisory ──
  // Use the oldest of the consecutive run as the firing start for lead time.
  const run = recent.slice(0, consec);
  const firingStart = run[run.length - 1].t0;
  const leadTimeMin = Math.max(0, Math.round((now - firingStart) / MIN_MS));

  const bgNow = Math.round(current.bg1);
  const iobNow = calculateIOB(treatments, profile, now);
  const iobStr = (Math.round(iobNow * 10) / 10).toFixed(1);

  const totalAbsorbed = run.reduce((s, w) => s + w.absorbed, 0);
  const totalExpected = run.reduce((s, w) => s + w.expectedDrop, 0);
  const totalActual = run.reduce((s, w) => s + w.actualDrop, 0);

  const evidence = [
    `Absorption deficit sustained ${run.length} windows (~${run.length * WINDOW_MIN} min).`,
    `Expected drop ${Math.round(totalExpected)} mg/dL from ${(Math.round(totalAbsorbed * 100) / 100).toFixed(2)}u absorbed, actual ${Math.round(totalActual)} mg/dL.`,
    `BG ${bgNow} mg/dL with ${iobStr} u on board and not responding.`,
    `ISF ${Math.round(current.isf)} mg/dL/u; deficit threshold ${Math.round(DEFICIT_FRAC * 100)}% of expected.`,
  ];

  const advisory: AdvisoryAction = {
    id: "failing_site",
    actionType: "change_site",
    actionClass: "site_change",
    rootCause: "failing_site",
    tier: "T3_urgent",
    severity: "high",
    leadTimeMin,
    orElse: `BG ${bgNow} and not responding to ${iobStr}U on board. Correct by pen if needed.`,
    magnitudeGrams: null, // direction only — NEVER an insulin number
    headline: "Consider a site change — insulin not absorbing",
    confidence: 0.8,
    staleness: { pumpStaleMin: null, cgmStaleMin: null },
    evidence,
    generatedAt: now,
  };

  return { veto: true, advisory };
}
