// ClearSugar — Phase 1 CIQ-capped sustained-hyper trigger (Option 1, P1.5)
//
// The residual HIGH-side advisor specified in docs/ADVISOR_CONCEPT_2026-06-19.md
// (§2a + Hard Rules): "CIQ-capped sustained hyper → manual correction
// (saturation-proven, nadir-floored)". It fires ONLY when Control-IQ, modeled at
// its MOST aggressive plausible continuation (max basal toward the fitted cap +
// auto-corrections at fraction 1.0), still cannot bring a sustained high back
// toward range within the horizon — i.e. the loop is saturated and a HUMAN pen
// correction is the only remaining lever. It never states a unit count (insulin
// is direction-only; the pump bolus calculator owns the number) and never doses.
//
// SAFETY (this producer is UNVALIDATED — no phase0_eval-style proving ground yet):
//   • The whole advisor defaults to SHADOW (ADVISOR_SHADOW), so nothing pushes.
//   • AND while HIGH_TRIGGER_VALIDATED is false, the emitted tier is forced to
//     T0_silent, so even a LIVE advisor only logs/harvests this advisory and can
//     never push it. It runs live-silent to build an outcome record; only after
//     backtest validation do we raise the tier. Belt AND suspenders.
//
// Hard-rule interplay (enforced in advisor-engine.ts, not here):
//   HSR #1 — a failing-site / absorption-deficit veto suppresses this insulin
//            advice entirely (correct_by_pen is in INSULIN_ACTION_TYPES). You
//            never recommend insulin into a site that isn't absorbing.
//   HSR #2 — stale pump data suppresses it (can't trust IOB/site).
//
// Design-doc invariants honored HERE:
//   • Worst-case CIQ continuation: model CIQ CONTINUING to dose (max basal +
//     auto-corrections), never ceasing — so we don't over-recommend insulin.
//   • Nadir-floor + autosens pinned most-sensitive: the optimistic-CIQ rollout
//     uses a sensitive autosens (insulin modeled at MORE effect), and we require
//     its projected MIN to stay above a hard floor — so the case where onboard +
//     CIQ insulin is already going to bring BG down (or low) does NOT fire.
//   • Night: RAISE the bar for hyper (let CIQ ride overnight). Higher BG gate.

import type { GlucoseReading, Treatment, PumpProfile } from "../types";
import type { AdvisorInput, AdvisoryAction, DeliveryTier } from "./advisor-types";
import {
  estimateRateOfChange,
  calculateIOB,
  calculateCOB,
  calculateAutosens,
} from "./physiological-model";
import { isPumpSleep } from "./ciq-modes";

const MIN = 60_000;
const FIVE_MIN_MS = 5 * MIN;

// ── Fitted CIQ params (same source as loop-gap-trigger: phase0-ciq-fit.json). ──
// Reusing the VALIDATED fit rather than the pump's configured LIMITS on purpose:
// the pump's basal-limit (15 U/hr) ≫ observed max delivery (7.68 U/hr), so using
// the configured limit would OVER-state CIQ's insulin help and wrongly SUPPRESS
// real high alerts. The fit reflects what CIQ actually does.
const CIQ = {
  max_basal_multiplier: 4.0,
  max_basal_rate_u_hr: 4.87,
  abs_rate_hard_cap_u_hr: 7.68,
  suspend_floor_bg: 70,
  auto_correction_fraction: 1.0,
  auto_correction_threshold_bg: 150,
  auto_correction_max_per_hour: 1.5,
  auto_correction_isf: 70.0,
  auto_correction_min_interval_min: 60,
} as const;

// ── Trigger constants (UNVALIDATED — tuned conservatively, pending backtest) ───
const HIGH_HORIZON_MIN = 60; // highs evolve slower than lows — longer projection
const HIGH_EVENT_BG_DAY = 250; // sustained-high gate (day)
const HIGH_EVENT_BG_NIGHT = 270; // raise the bar overnight (let CIQ ride)
const SUSTAINED_MIN = 30; // must have been high this long (not a transient spike)
const SUSTAINED_SLACK = 25; // trailing-window min must be ≥ gate − slack
const HIGH_RESOLVE_BG = 180; // optimistic CIQ must FAIL to get end-BG below this
const NADIR_FLOOR_HIGH = 100; // optimistic-CIQ min must stay above this (no over-dose)
const AUTOSENS_SENSITIVE_PIN = 1.2; // pin autosens ≥ this (model insulin at MORE effect)
const RECENT_CORRECTION_VETO_MIN = 20; // a manual/auto correction just given → wait a cycle
const COB_VETO_G = 12; // a meal still absorbing → CIQ + meal bolus are handling it

/**
 * Master switch. While false, the advisory tier is forced to T0_silent so this
 * producer runs live-silent (log + outcome-harvest) but never pushes.
 *
 * ENABLED 2026-07-01 on the strength of the 30-day backtest
 * (docs/phase1-high-trigger-backtest.json: 5 fires, 5/5 followed by a real
 * correction, 0 false alarms). Live safeguards remain: direction-only (never a
 * unit count), nadir-floored, HSR site + stale vetoes, ~1 fire / 6 days, and the
 * night wake-gate keeps it passive during the pump Sleep window (no house wake).
 */
export const HIGH_TRIGGER_VALIDATED = true;

// ── Profile helpers (local, matching loop-gap-trigger's pattern) ───────────────

function getActiveProfile(profile: PumpProfile) {
  return profile.store[profile.defaultProfile];
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
    if (entry.timeAsSeconds <= secondsOfDay) value = entry.value;
    else break;
  }
  return value;
}

// ── CIQ-optimistic HIGH-side rollout ──────────────────────────────────────────

export interface HighRollout {
  /** Lowest optimistic-CIQ BG over the horizon (nadir-floor guard). */
  minBg: number;
  /** Optimistic-CIQ BG at the horizon end (did it get back toward range?). */
  endBg: number;
}

/**
 * Forward-project BG assuming CIQ delivers the MOST insulin it plausibly can:
 * max basal (toward the fitted cap) at every step PLUS auto-correction boluses
 * at fraction 1.0 above threshold. Unlike the low-side rollout (which models
 * basal SUSPENSION and only injects negative-delta temps), this injects the
 * POSITIVE basal delta — the extra insulin that actually pulls a high down —
 * and pins autosens to the most-sensitive plausible value so CIQ's help is not
 * under-estimated (conservative on the insulin-recommendation side).
 *
 * If even THIS aggressive continuation leaves end-BG high, CIQ is saturated.
 */
export function ciqHighRollout(
  trail: GlucoseReading[],
  treatments: Treatment[],
  profile: PumpProfile,
  horizonMin: number = HIGH_HORIZON_MIN
): HighRollout | null {
  if (trail.length < 2) return null;

  const sorted = [...trail].sort((a, b) => b.date - a.date);
  const latest = sorted[0];
  const now = latest.date;
  const active = getActiveProfile(profile);
  const sensSched = active?.sens ?? [];
  const crSched = active?.carbratio ?? [];
  const basalSched = active?.basal ?? [];

  // Pin autosens to the most-sensitive plausible value (design-doc nadir rule):
  // insulin modeled at MORE effect ⇒ CIQ resolves more highs ⇒ we fire LESS,
  // never over-recommending insulin.
  const ar = Math.max(calculateAutosens(trail, treatments, profile), AUTOSENS_SENSITIVE_PIN);

  const steps = Math.floor(horizonMin / 5);
  let prevSgv = latest.sgv;
  const workTw: Treatment[] = [...treatments];
  let minBg = prevSgv;
  let lastCorrMs = -1e15;
  let corrThisHour: { t: number; dose: number }[] = [];

  for (let step = 1; step <= steps; step++) {
    const futureTime = now + step * FIVE_MIN_MS;

    const iobNow = calculateIOB(workTw, profile, futureTime);
    const iobPrev = calculateIOB(workTw, profile, futureTime - FIVE_MIN_MS);
    const insulinAbsorbed = iobPrev - iobNow;
    const isf = getScheduledValue(sensSched, futureTime) * ar;
    const iobEffect = -insulinAbsorbed * isf;

    const cobNow = calculateCOB(workTw, futureTime);
    const cobPrev = calculateCOB(workTw, futureTime - FIVE_MIN_MS);
    const carbsAbsorbed = cobPrev - cobNow;
    const cr = getScheduledValue(crSched, futureTime);
    const cobEffect = cr > 0 ? (carbsAbsorbed / cr) * isf : 0;

    const predicted = Math.round(Math.max(39, Math.min(401, prevSgv + iobEffect + cobEffect)));

    // Optimistic CIQ basal for the next step, keyed on predicted BG.
    const scheduledBasal = getScheduledValue(basalSched, futureTime);
    if (scheduledBasal > 0) {
      const bg = predicted;
      let mult: number;
      if (bg < CIQ.suspend_floor_bg) mult = 0.0;
      else if (bg < 110) mult = 0.0; // CIQ suspends as it approaches normal
      else if (bg < 150) mult = 1.25;
      else if (bg < 180) mult = 2.2;
      else mult = 2.95;
      mult = Math.min(mult, CIQ.max_basal_multiplier);
      const rate = Math.min(
        mult * scheduledBasal,
        CIQ.max_basal_rate_u_hr,
        CIQ.abs_rate_hard_cap_u_hr
      );
      const deltaRate = rate - scheduledBasal;
      // Inject EITHER direction: positive delta (extra basal, the high-side help)
      // OR negative (suspension near normal). Both feed calculateIOB's temp-basal
      // delta path; positive delta adds IOB and pulls BG down.
      if (deltaRate !== 0) {
        workTw.push({
          _id: `ciqhi-${futureTime}`,
          eventType: "Temp Basal",
          created_at: new Date(futureTime).toISOString(),
          enteredBy: "ciq-high-rollout",
          mills: futureTime,
          utcOffset: 0,
          duration: 5,
          absolute: rate,
        });
      }
    }

    // Optimistic auto-correction bolus (the other high-side lever).
    if (
      predicted >= CIQ.auto_correction_threshold_bg &&
      futureTime - lastCorrMs >= CIQ.auto_correction_min_interval_min * MIN
    ) {
      corrThisHour = corrThisHour.filter((c) => futureTime - c.t < 60 * MIN);
      const injected = corrThisHour.reduce((s, c) => s + c.dose, 0);
      let dose =
        (CIQ.auto_correction_fraction * (predicted - 110)) / CIQ.auto_correction_isf;
      dose = Math.min(dose, CIQ.auto_correction_max_per_hour - injected);
      if (dose > 0) {
        workTw.push({
          _id: `ciqhi-corr-${futureTime}`,
          eventType: "Bolus",
          created_at: new Date(futureTime).toISOString(),
          enteredBy: "ciq-high-rollout",
          mills: futureTime,
          utcOffset: 0,
          insulin: dose,
        });
        lastCorrMs = futureTime;
        corrThisHour.push({ t: futureTime, dose });
      }
    }

    if (predicted < minBg) minBg = predicted;
    prevSgv = predicted;
  }

  return { minBg, endBg: prevSgv };
}

// ── veto helpers ───────────────────────────────────────────────────────────────

/** Trailing-window minimum SGV over the last `windowMin` minutes (inclusive). */
function trailingMin(trail: GlucoseReading[], nowT: number, windowMin: number): number | null {
  const win = trail.filter((r) => nowT - r.date <= windowMin * MIN && r.date <= nowT);
  if (win.length < 3) return null;
  return Math.min(...win.map((r) => r.sgv));
}

/** A recent human OR CIQ correction bolus (insulin just delivered → wait a cycle). */
function recentCorrection(treatments: Treatment[], nowT: number): boolean {
  return treatments.some((t) => {
    const tm = t.mills || Date.parse(t.created_at);
    return (
      typeof t.insulin === "number" &&
      (t.insulin ?? 0) > 0 &&
      Number.isFinite(tm) &&
      nowT - tm <= RECENT_CORRECTION_VETO_MIN * MIN &&
      tm <= nowT
    );
  });
}

// ── Main trigger ───────────────────────────────────────────────────────────────

/**
 * Evaluate the CIQ-capped sustained-hyper trigger. Returns an AdvisoryAction
 * (correct_by_pen / high_correction / ciq_capped_high) when even optimistic CIQ
 * cannot resolve a sustained high within the horizon, else null.
 *
 * NOTE: the returned tier is T0_silent while HIGH_TRIGGER_VALIDATED is false.
 */
export function evaluateHighTrigger(input: AdvisorInput): AdvisoryAction | null {
  const { readings, treatments, profile, now } = input;
  if (readings.length < 3) return null;

  const sorted = [...readings].sort((a, b) => b.date - a.date);
  const latest = sorted[0];
  const curSgv = latest.sgv;
  const t = latest.date;

  // Overnight (pump Sleep window) raises the hyper bar — let CIQ ride a genuine
  // high rather than risk an asleep over-correction (design-doc night policy).
  const night = isPumpSleep(t, input.pumpState?.controlIQ?.sleepSchedule);
  const eventBg = night ? HIGH_EVENT_BG_NIGHT : HIGH_EVENT_BG_DAY;

  // 1. Currently high.
  if (curSgv < eventBg) return null;

  // 2. Sustained — the last SUSTAINED_MIN minutes have held high (not a spike
  //    CIQ is about to catch). Needs enough trailing data to judge.
  const tmin = trailingMin(readings, t, SUSTAINED_MIN);
  if (tmin === null || tmin < eventBg - SUSTAINED_SLACK) return null;

  // 3. Not already dropping meaningfully (if it is, insulin is working → wait).
  const roc5 = estimateRateOfChange(readings); // mg/dL / 5min
  if (roc5 <= -3) return null;

  // 4. A meal still absorbing, or a correction just delivered → CIQ + that
  //    insulin are handling it; don't recommend stacking. Wait a cycle.
  if (calculateCOB(treatments, t) >= COB_VETO_G) return null;
  if (recentCorrection(treatments, t)) return null;

  // 5. SATURATION-PROVEN + NADIR-FLOOR: even the most aggressive plausible CIQ
  //    continuation (max basal + auto-corrections, sensitive autosens) still
  //    leaves end-BG high AND never drives BG near a low. Only then is a human
  //    correction the residual lever.
  const roll = ciqHighRollout(readings, treatments, profile, HIGH_HORIZON_MIN);
  if (!roll) return null;
  if (roll.endBg < HIGH_RESOLVE_BG) return null; // CIQ resolves it → suppress
  if (roll.minBg < NADIR_FLOOR_HIGH) return null; // onboard/CIQ insulin will bring it down → suppress

  // ── Build the advisory (insulin is DIRECTION-ONLY; no unit count, no grams) ──
  const cgmStaleMin = Math.max(0, Math.round((now - latest.date) / MIN));
  let lastPumpMs: number | null = null;
  for (const tr of treatments) {
    const tm = tr.mills || Date.parse(tr.created_at);
    if (Number.isFinite(tm) && tm > 0 && (lastPumpMs === null || tm > lastPumpMs)) lastPumpMs = tm;
  }
  const pumpStaleMin =
    lastPumpMs === null ? null : Math.max(0, Math.round((now - lastPumpMs) / MIN));

  const veryHigh = curSgv >= 300;
  const severity: AdvisoryAction["severity"] = veryHigh ? "high" : "moderate";
  // Computed delivery tier: actionable, not a wake event. The night wake-gate in
  // the firing path already drops any non-T4 night advisory to passive, so an
  // overnight high never wakes the house. While UNVALIDATED, force T0_silent.
  const computedTier: DeliveryTier = "T2_actionable";
  const tier: DeliveryTier = HIGH_TRIGGER_VALIDATED ? computedTier : "T0_silent";

  let confidence = 0.7;
  if (readings.length < 12) confidence -= 0.2;
  if (cgmStaleMin > 10) confidence -= 0.2;
  if (veryHigh) confidence += 0.1;
  confidence = Math.max(0.3, Math.min(0.9, confidence));

  // Headline becomes the push title, so it stays short enough to survive a lock
  // screen; orElse is the body and carries the evidence. Sentence case
  // throughout — see the sibling advisories in loop-gap-trigger and
  // site-failure-advisor.
  const orElse =
    `BG ~${Math.round(curSgv)} and holding. Control-IQ is dosing its hardest and still ` +
    `projects ~${Math.round(roll.endBg)} in ${HIGH_HORIZON_MIN} min. Use the pump bolus calculator.`;
  const headline = "Manual correction needed";

  const evidence = [
    `curBG ${Math.round(curSgv)} ≥ gate ${eventBg}${night ? " (night bar)" : ""}`,
    `sustained: ${SUSTAINED_MIN}-min trailing min ${Math.round(tmin)} ≥ ${eventBg - SUSTAINED_SLACK}`,
    `ROC ${roc5.toFixed(1)} mg/dL/5min (not dropping)`,
    `CIQ-optimistic (max basal + auto-corr, autosens≥${AUTOSENS_SENSITIVE_PIN}) end ${Math.round(roll.endBg)} ≥ ${HIGH_RESOLVE_BG}, min ${Math.round(roll.minBg)} ≥ ${NADIR_FLOOR_HIGH}`,
    HIGH_TRIGGER_VALIDATED ? "validated" : "UNVALIDATED → tier forced T0_silent (shadow log only)",
  ];

  return {
    id: "ciq_capped_high",
    actionType: "correct_by_pen",
    actionClass: "high_correction",
    rootCause: "ciq_capped_high",
    tier,
    severity,
    leadTimeMin: 0, // already high; the action is now
    orElse,
    magnitudeGrams: null, // insulin — never a unit count, never grams
    headline,
    confidence,
    staleness: { pumpStaleMin, cgmStaleMin },
    evidence,
    generatedAt: now,
  };
}
