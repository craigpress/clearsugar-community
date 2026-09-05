// ClearSugar — Phase 1 loop-gap low-glucose trigger (P1.3 TS port)
//
// Faithful TypeScript port of the VALIDATED Python prototype
// `scripts/phase1_trigger_proto.py` (config `roc_sat@70`) — the operating
// point chosen: ROC base + CIQ basal-SUSPENSION saturation gate at
// threshold 70 (~0.69 false-wakes/night, ~64% severe-low catch).
//
// The advisor is a RESIDUAL advisor on top of Control-IQ (see advisor-types.ts):
// it fires ONLY when even the loop doing its optimistic best still ends low.
// It never doses the pump — carb grams only.
//
// A low alert fires (returns an AdvisoryAction) iff ALL hold:
//   0. NOT ALREADY LOW (added 2026-07-28): current BG >= threshold. Below the
//      threshold both gates below pass unconditionally, so the trigger had no
//      specificity mechanism at all there — see the comment at the check.
//   0b. Current BG <= MAX_TRIGGER_BG (added 2026-07-28): a 30-min slope
//      extrapolation from further away is noise, not physiology.
//   1. ROC base: ROC-extrapolated 30-min projection crosses below threshold 70.
//   2. CIQ saturation gate: re-project assuming optimistic CIQ basal SUSPENSION
//      (best case for avoiding a low — strips withheld basal IOB, raising the
//      trajectory). Suppress if that best-case path stays >= threshold.
//   3. Compression/sensor veto: suppress if the current reading matches the
//      overnight compression-low signature (>40 mg/dL drop in <=15 min from a
//      CV<10% stable window) or a sensor warmup/noise jump.
//   3b. Hypo-floor confirmation (added 2026-07-28): the insulin already
//      delivered must on its own reach FLOOR_CONFIRM_BG within 30 min.
//
// Severity/tier (changed 2026-07-28): T4_critical requires BOTH the ROC and the
// CIQ-optimistic projection to fall below 55, not the more alarmist of the two.
// T4 is the only tier that survives the overnight downgrade, so this is the
// constant that decides whether the house gets woken.
//
// Primitives are reused verbatim from physiological-model.ts so the TS rollout
// mirrors the Python (whose cs_physio.py mirrors physiological-model.ts at zero
// residual). The CIQ basal suspension is injected by appending synthetic
// `Temp Basal` (rate 0 / reduced) treatments and feeding them through the
// EXISTING calculateIOB temp-basal-delta path — the same mechanism the Python
// uses with calc_iob's work_tw list.

import type { GlucoseReading, Treatment, PumpProfile } from "../types";
import type { AdvisorInput, AdvisoryAction, DeliveryTier } from "./advisor-types";
import {
  estimateRateOfChange,
  calculateIOB,
  calculateCOB,
  calculateAutosens,
} from "./physiological-model";
import { getCiqMode, lowThresholdForMode, EXERCISE_LOW_MODULATION } from "./ciq-modes";
import { predictHypoRisk } from "./hypo-risk";

const MIN = 60_000;
const FIVE_MIN_MS = 5 * MIN;

// ── Validated constants (ported 1:1 from the Python) ────────────────────────
// Operating point / thresholds (phase1_trigger_proto.py argparse defaults +
// chosen config `roc_sat@70`).
const HORIZON_MIN = 30; // --horizon
const EVENT_LOW = 70; // --event-low (the chosen threshold)
const SEVERE_LOW = 55; // --severe-low (instantaneous floor)

// ── Specificity gates added 2026-07-28 ───────────────────────────────────────
// Measured on 284 days / 78,014 anchors / 703 low episodes (180 severe) by
// `scripts/advisor-levers.backtest.ts`, which reproduces production's delivery
// model (2h cooldown + worsening bypass; only T4 survives the 22:00–05:00 sleep
// downgrade). Baseline as shipped: 3.25 pushes/day, 0.334 FALSE WAKES/night.
// With all three gates below: 1.89 pushes/day, 0.120 false wakes/night — a 64%
// cut — while severe-episode EARLY catch RISES 28.3% → 30.0% and median lead
// time goes 8 → 15 min. Strictly better on every axis, which is why these are
// gates and not a sensitivity trade.
//
// This is deliberately safe to tighten: four independent emitters still cover
// any low these suppress (Dexcom's own alarm, the server low/urgentLow push,
// the iOS backstop, and HA's never-gated urgent_low — see docs/ALERTS.md §1).
// If any of those is ever gated or snoozed, revisit these constants.

/**
 * Above this BG the trigger stays silent.
 *
 * `estimateRateOfChange` is an OLS slope over a 15-minute window (4 readings).
 * Its sampling error extrapolated across the 30-minute horizon is ~2.7σ, i.e.
 * 13–21 mg/dL of pure projection noise at Dexcom's σ≈5–8. Reaching below 70
 * from BG 100 therefore needs ROC ≤ −5 mg/dL/5min, which is a 1-in-9 noise
 * excursion — and measured over 284 days those fires are wrong 84% of the time
 * (75% at BG 90–99, versus 28% at BG 60–69). There is no physiology being
 * detected up there, only slope noise.
 */
const MAX_TRIGGER_BG = 90;

/**
 * The IOB-only hypo floor must independently agree a low is coming.
 *
 * `predictHypoRisk` answers "where does BG go on insulin already delivered, if
 * nothing else happens" — no carbs, no momentum. It is far too alarmist to be
 * an alert of its own (it projects below 70 on 27% of all readings, because it
 * has no carb term and a meal bolus therefore always looks like a crash), but
 * as a SECOND OPINION it is exactly the right shape: it can only ever remove an
 * alert, and what it removes are the ROC excursions with no insulin behind
 * them. Confirmation costs 4.4 points of severe catch and buys a further 33%
 * off the false-wake rate.
 */
const FLOOR_CONFIRM_BG = 55;
const FLOOR_CONFIRM_HORIZON_MIN = 30;
// Glucose can't fall below the sensor/physiological floor. ROC × optimistic-CIQ
// can extrapolate a steep drop past zero, which would both print an absurd
// "heading to ~-268" and inflate the carb deficit/magnitude. Clamp the projected
// nadir here. 39 < SEVERE_LOW, so severe-low detection is unaffected.
const NADIR_FLOOR = 39;
const NIGHT_START_HOUR = 22; // --night-start (local)
const NIGHT_END_HOUR = 7; // --night-end (local)

// CIQ fit params (docs/phase0-ciq-fit.json -> fitted_params; CIQ dict in the Python).
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

// ── Profile helpers ─────────────────────────────────────────────────────────

function getActiveProfile(profile: PumpProfile) {
  return profile.store[profile.defaultProfile];
}

/**
 * Look up a time-scheduled value (ISF, CR, basal) for a given timestamp.
 * Faithful to the (private) getScheduledValue() in physiological-model.ts:
 * picks the last segment whose timeAsSeconds <= seconds-of-day, using host
 * LOCAL time-of-day (Date.getHours()).  See DIVERGENCE note in the module
 * report: the Python's cs_physio.get_scheduled_value used a fixed EDT offset
 * because it had no host-TZ runtime; the .ts primitives this module reuses use
 * host-local time, so we match the .ts (the actual TS production behavior).
 */
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

export function isNight(atTime: number): boolean {
  const hod = new Date(atTime).getHours();
  // night window wraps midnight: [NIGHT_START_HOUR, 24) U [0, NIGHT_END_HOUR)
  if (NIGHT_START_HOUR <= NIGHT_END_HOUR) {
    return hod >= NIGHT_START_HOUR && hod < NIGHT_END_HOUR;
  }
  return hod >= NIGHT_START_HOUR || hod < NIGHT_END_HOUR;
}

// ── CIQ-optimistic rollout (P0.4 spec, low-side basal SUSPENSION) ────────────

/**
 * Re-run the momentum-free forward model, but at each 5-min step inject the
 * MOST help CIQ could plausibly give: for LOWS that means SUSPENDING basal
 * (rate 0 below 70, and full suspension in the 70..110 ramp — optimistic
 * low-side), which withholds future basal insulin and RAISES the trajectory
 * vs the as-delivered path.
 *
 * Implementation mirrors `ciq_optimistic_rollout` in phase1_trigger_proto.py:
 * synthesize forward Temp Basal treatments (rate vs scheduled) for each step
 * whose optimistic predicted BG is in the suspend/ramp regime, append them to a
 * working treatment list, and feed that list through calculateIOB — the SAME
 * temp-basal-delta path predictPhysiological already uses. The negative
 * delta_rate removes future basal IOB, lifting BG. Optimistic auto-correction
 * boluses above 150 are also injected for spec fidelity (irrelevant to the low
 * gate, kept for symmetry with the Python).
 *
 * Returns the MINIMUM optimistic-CIQ BG over the horizon, or null when the
 * trail is too short to project. The gate suppresses the alert when this min
 * stays >= threshold (even CIQ's best avoids the low).
 */
export function ciqOptimisticRollout(
  trail: GlucoseReading[],
  treatments: Treatment[],
  profile: PumpProfile,
  horizonMin: number = HORIZON_MIN
): number | null {
  if (trail.length < 2) return null;

  const sorted = [...trail].sort((a, b) => b.date - a.date);
  const latest = sorted[0];
  const now = latest.date;
  const active = getActiveProfile(profile);
  const sensSched = active?.sens ?? [];
  const crSched = active?.carbratio ?? [];
  const basalSched = active?.basal ?? [];

  // autosens ratio — same computation predictPhysiological uses.
  const ar = calculateAutosens(trail, treatments, profile);

  const steps = Math.floor(horizonMin / 5);
  let prevSgv = latest.sgv;

  // mutable working treatment list we append synthetic CIQ suspensions to,
  // exactly like the Python's `work_tw`.
  const workTw: Treatment[] = [...treatments];
  let minBg = prevSgv;
  let lastCorrMs = -1e15;
  let corrThisHour: { t: number; dose: number }[] = [];

  for (let step = 1; step <= steps; step++) {
    const futureTime = now + step * FIVE_MIN_MS;

    // IOB effect from current working treatment list (incl. injected CIQ
    // suspensions from prior steps) — same delta math as predictPhysiological.
    const iobNow = calculateIOB(workTw, profile, futureTime);
    const iobPrev = calculateIOB(workTw, profile, futureTime - FIVE_MIN_MS);
    const insulinAbsorbed = iobPrev - iobNow;
    const profileISF = getScheduledValue(sensSched, futureTime);
    const isf = profileISF * ar;
    const iobEffect = -insulinAbsorbed * isf;

    const cobNow = calculateCOB(workTw, futureTime);
    const cobPrev = calculateCOB(workTw, futureTime - FIVE_MIN_MS);
    const carbsAbsorbed = cobPrev - cobNow;
    const cr = getScheduledValue(crSched, futureTime);
    const cobEffect = cr > 0 ? (carbsAbsorbed / cr) * isf : 0;

    // momentum-free
    const predicted = Math.round(
      Math.max(39, Math.min(401, prevSgv + iobEffect + cobEffect))
    );

    // ── OPTIMISTIC CIQ ACTION for the NEXT step, keyed on predicted BG ──
    const scheduledBasal = getScheduledValue(basalSched, futureTime);
    if (scheduledBasal > 0) {
      const bg = predicted;
      let mult: number;
      if (bg < CIQ.suspend_floor_bg) {
        mult = 0.0;
      } else if (bg < 110) {
        mult = 0.0; // optimistic low-side: assume full suspension in ramp
      } else if (bg < 150) {
        mult = 1.25;
      } else if (bg < 180) {
        mult = 2.2;
      } else {
        mult = 2.95;
      }
      mult = Math.min(mult, CIQ.max_basal_multiplier);
      const rate = Math.min(
        mult * scheduledBasal,
        CIQ.max_basal_rate_u_hr,
        CIQ.abs_rate_hard_cap_u_hr
      );
      const deltaRate = rate - scheduledBasal;
      if (deltaRate < 0) {
        // suspension/reduction -> withhold basal -> raises BG.
        // synthesize a temp-basal treatment over this 5-min step, fed through
        // the existing calculateIOB temp-basal-delta path.
        workTw.push({
          _id: `ciq-${futureTime}`,
          eventType: "Temp Basal",
          created_at: new Date(futureTime).toISOString(),
          enteredBy: "ciq-rollout",
          mills: futureTime,
          utcOffset: 0,
          duration: 5, // minutes
          absolute: rate,
        });
      }
    }

    // optimistic auto-correction (high-side; kept for spec fidelity)
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
          _id: `ciq-corr-${futureTime}`,
          eventType: "Bolus",
          created_at: new Date(futureTime).toISOString(),
          enteredBy: "ciq-rollout",
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

  return minBg;
}

// ── Compression / sensor veto (P0.3 signature) ───────────────────────────────

/**
 * True => suppress. The current reading matches the overnight compression-low
 * signature: a rapid >40 mg/dL drop within the last <=15 min, coming OUT OF a
 * CV<10% stable window (15..45 min ago). Faithful port of compression_veto().
 */
export function compressionVeto(trail: GlucoseReading[]): boolean {
  if (trail.length < 5) return false;
  const sr = [...trail].sort((a, b) => a.date - b.date); // ascending
  const nowT = sr[sr.length - 1].date;
  const nowV = sr[sr.length - 1].sgv;

  const win15 = sr.filter((r) => nowT - r.date <= 15 * MIN);
  if (win15.length < 3) return false;
  const drop = Math.max(...win15.map((r) => r.sgv)) - nowV;
  if (drop <= 40) return false;

  const pre = sr
    .filter((r) => 15 * MIN < nowT - r.date && nowT - r.date <= 45 * MIN)
    .map((r) => r.sgv);
  if (pre.length < 3) return false;
  const m = pre.reduce((s, v) => s + v, 0) / pre.length;
  if (m <= 0) return false;
  const sd = Math.sqrt(pre.reduce((s, v) => s + (v - m) ** 2, 0) / pre.length);
  const cv = sd / m;
  return cv < 0.1;
}

/**
 * Sensor warmup / hard-noise veto: an implausible jump between consecutive
 * readings (> 80 mg/dL per 5-min step) is a warmup/dropout artifact, not real.
 * Faithful port of warmup_veto().
 */
export function warmupVeto(trail: GlucoseReading[]): boolean {
  if (trail.length < 2) return false;
  const sr = [...trail].sort((a, b) => a.date - b.date);
  const a = sr[sr.length - 2];
  const b = sr[sr.length - 1];
  const dt = (b.date - a.date) / MIN;
  if (dt <= 0 || dt > 12) return false;
  return Math.abs(b.sgv - a.sgv) / (dt / 5.0) > 80;
}

// ── Carb magnitude (sensitive side: round UP) ────────────────────────────────

/**
 * Grams of fast carbs to lift the projected deficit (target - projectedMin)
 * back over the threshold, given ISF and CR. Rounded UP (sensitive side).
 *   deficit_mgdl = target - projectedMin
 *   units_to_offset = deficit_mgdl / ISF        (insulin equiv to neutralize)
 *   grams = units_to_offset * CR                (carbs that raise BG by deficit)
 * Using CR directly: grams that raise BG by `deficit` = deficit / (ISF/CR).
 */
function carbsForDeficit(deficitMgdl: number, isf: number, cr: number): number {
  if (deficitMgdl <= 0 || isf <= 0 || cr <= 0) return 0;
  const carbRaisePerGram = isf / cr; // mg/dL raised per gram of carb
  if (carbRaisePerGram <= 0) return 0;
  return Math.ceil(deficitMgdl / carbRaisePerGram);
}

// ── Main trigger ─────────────────────────────────────────────────────────────

/**
 * Evaluate the validated loop-gap low-glucose trigger.
 *
 * Returns an AdvisoryAction (carbs / low_carbs / impending_low) when the
 * validated pipeline fires, else null.
 */
export function evaluateLowTrigger(
  input: AdvisorInput,
  opts?: { exerciseLowModulation?: boolean }
): AdvisoryAction | null {
  const { readings, treatments, profile, now } = input;
  if (readings.length < 2) return null;

  // newest-first trail
  const sorted = [...readings].sort((a, b) => b.date - a.date);
  const latest = sorted[0];
  const curSgv = latest.sgv;
  const t = latest.date;

  // Option 3 (GATED): during Exercise mode, raise the low-event threshold so
  // exercise-induced lows are caught earlier. Default OFF (EXERCISE_LOW_MODULATION)
  // → eventLow == EVENT_LOW == the validated roc_sat@70 behavior, unchanged. The
  // backtest passes exerciseLowModulation:true to measure the on-vs-off delta.
  const modOn = opts?.exerciseLowModulation ?? EXERCISE_LOW_MODULATION;
  const eventLow = modOn
    ? lowThresholdForMode(EVENT_LOW, getCiqMode(treatments, t), true)
    : EVENT_LOW;

  // 0. NOT ALREADY LOW. Without this the trigger has no specificity mechanism
  //    at all below the threshold: `rocMin` is `min(curSgv, …) ≤ curSgv`, and
  //    `ciqOptimisticRollout` seeds its minimum with the current reading, so
  //    when curSgv < eventLow BOTH gates pass unconditionally. Measured over
  //    284 days that was 54% of all fires — every one of them lead-time 0, at
  //    the tier the message tiers on, with an `orElse` that "predicts" the
  //    reading it was given ("heading to ~52" at a flat 52). Those are not
  //    early warnings; they are a fourth threshold alarm behind three that
  //    already fired, on the one emitter that ignores snooze.
  if (curSgv < eventLow) return null;

  // 0b. Too far from the threshold for a 30-min slope extrapolation to mean
  //     anything. See MAX_TRIGGER_BG.
  if (curSgv > MAX_TRIGGER_BG) return null;

  // 1. ROC base: ROC-extrapolated horizon-min projection.
  const roc5 = estimateRateOfChange(readings); // mg/dL per 5 min
  const persistRocEnd = curSgv + roc5 * (HORIZON_MIN / 5.0);
  const rocMin = Math.min(curSgv, persistRocEnd);

  const rocAlert = rocMin < eventLow;
  if (!rocAlert) return null;

  // 2. CIQ saturation gate: suppress if optimistic-CIQ best case stays >= thr.
  const ciqMinRaw = ciqOptimisticRollout(readings, treatments, profile, HORIZON_MIN);
  const ciqMin = ciqMinRaw === null ? rocMin : ciqMinRaw; // degenerate -> no-op gate
  const gateOk = ciqMin < eventLow;
  if (!gateOk) return null;

  // 3. Compression / sensor veto suppresses the wake (after fire decision).
  if (compressionVeto(readings) || warmupVeto(readings)) return null;

  // 3b. Hypo-floor confirmation: the insulin already delivered must, on its
  //     own, be enough to drive BG under FLOOR_CONFIRM_BG. A falling trend with
  //     no insulin behind it is a slope excursion, not an impending low.
  const floorConfirm = predictHypoRisk(readings, treatments, profile, {
    horizonMinutes: FLOOR_CONFIRM_HORIZON_MIN,
    lowThreshold: FLOOR_CONFIRM_BG,
  });
  if (floorConfirm.minutesToLow === null) return null;

  // ── Build the AdvisoryAction ───────────────────────────────────────────────
  const active = getActiveProfile(profile);
  const isfRaw = active ? getScheduledValue(active.sens, t) : 0;
  const crRaw = active ? getScheduledValue(active.carbratio, t) : 0;
  const isf = isfRaw > 0 ? isfRaw : CIQ.auto_correction_isf; // flat-70 fallback
  const cr = crRaw > 0 ? crRaw : 10; // conservative default CR

  // Carb magnitude sized off the deepest credible deficit: prefer the
  // optimistic-CIQ floor (the residual gap CIQ cannot close); fall back to ROC.
  // Clamp the nadir to the physiological floor (see NADIR_FLOOR): caps the
  // carb deficit and keeps the displayed projection credible. Severe detection
  // below uses this clamped value but 39 < SEVERE_LOW so it is unaffected.
  const projectedMin = Math.max(NADIR_FLOOR, Math.min(ciqMin, rocMin));
  const deficit = eventLow - projectedMin; // mg/dL below threshold
  // The deficit-based estimate is kept for the audit/eval trail but is NOT shown
  // as the dose yet: it under-doses vs the standard rescue (it covers only the
  // gap below 70, not the ongoing IOB-driven drop). Per decision #8 (qualitative
  // ~10-15g for v1, promote once the FeedbackStore validates the calc) the shown
  // magnitude is the standard rescue, sized up for severe.
  const deficitEstimateGrams = carbsForDeficit(deficit, isf, cr);

  // lead time: minutes until the ROC-projected < threshold crossing.
  // roc5 < 0 when falling; crossing at curSgv + roc5*(m/5) = EVENT_LOW.
  let leadTimeMin = 0;
  if (curSgv >= eventLow && roc5 < 0) {
    const stepsToCross = (curSgv - eventLow) / -roc5; // in 5-min steps
    leadTimeMin = Math.max(0, Math.round(stepsToCross * 5));
  }
  leadTimeMin = Math.min(leadTimeMin, HORIZON_MIN);

  // T4_critical is the ONLY tier that survives the overnight downgrade in
  // `/api/advisor/check` — it is, precisely, the thing that wakes the house. It
  // was awarded on `min(rocMin, ciqMin) < 55`: the fire decision ANDs the two
  // projections (conservative), but the tier decision took the MORE alarmist of
  // the two, so a single noisy tick could escalate a passive night banner into
  // a wake. Measured: 2.59 severe-labelled alerts/day against 0.63 real severe
  // lows/day, only 9% of them followed by a real BG<55.
  //
  // Requiring BOTH projections to agree cuts false wakes 39% on its own and
  // RAISES severe early catch, because the tier feeds the cooldown's
  // worsening-bypass — fewer spurious escalations means fewer wasted pushes.
  const severe = Math.max(rocMin, ciqMin) < SEVERE_LOW;

  // Tiering (recalibrated 2026-06-26): a severe-projected low is the only
  // night event — T4_critical (loudest PHONE push; there is no house alarm or
  // siren in this system). Every
  // other impending low is T2_actionable. The night wake-gate in the firing path
  // non-T4 night fires to passive; a deepening low re-fires and escalates to T4
  // on the next 5-min tick, so a worsening night low still gets the wake.
  const tier: DeliveryTier = severe ? "T4_critical" : "T2_actionable";

  const crossEta = new Date(t + leadTimeMin * MIN);
  const hh = String(crossEta.getHours()).padStart(2, "0");
  const mm = String(crossEta.getMinutes()).padStart(2, "0");

  // Standard rescue dose (15g rule), sized up for severe lows. Qualitative for
  // v1 per decision #8; the deficit-model estimate rides along in the evidence.
  const magnitudeGrams = severe ? 20 : 15;

  const orElse =
    `Heading to ~${Math.round(projectedMin)} by ${hh}:${mm}, ` +
    `even with the pump's basal off.`;
  const headline = `${magnitudeGrams}g fast carbs now`;

  // staleness
  const cgmStaleMin = Math.max(0, Math.round((now - latest.date) / MIN));
  let lastPumpMs: number | null = null;
  for (const tr of treatments) {
    const tm = tr.mills || new Date(tr.created_at).getTime();
    if (tm > 0 && (lastPumpMs === null || tm > lastPumpMs)) lastPumpMs = tm;
  }
  const pumpStaleMin =
    lastPumpMs === null ? null : Math.max(0, Math.round((now - lastPumpMs) / MIN));

  // confidence: lower on sparse data / long stale gap.
  let confidence = 0.85;
  if (readings.length < 12) confidence -= 0.2; // < 1h of CGM
  if (cgmStaleMin > 10) confidence -= 0.2;
  if (severe) confidence = Math.min(0.95, confidence + 0.1);
  confidence = Math.max(0.3, Math.min(0.95, confidence));

  const evidence = [
    `ROC ${roc5.toFixed(1)} mg/dL/5min -> 30-min proj ${Math.round(rocMin)}`,
    `CIQ-optimistic (basal suspended) floor ${Math.round(ciqMin)} < ${EVENT_LOW}`,
    severe
      ? `severe: BOTH projections < ${SEVERE_LOW} (ROC ${Math.round(rocMin)}, CIQ-optimistic ${Math.round(ciqMin)})`
      : `below event low ${EVENT_LOW}, not severe (worse projection ${Math.round(Math.max(rocMin, ciqMin))} >= ${SEVERE_LOW})`,
    `IOB floor confirms: reaches ${floorConfirm.nadir} in ${floorConfirm.minutesToLow}min on insulin alone`,
    `lead ${leadTimeMin}min to <${EVENT_LOW} crossing`,
    `deficit-model carb estimate ${deficitEstimateGrams}g (unvalidated; showing ${magnitudeGrams}g standard rescue per v1 policy)`,
  ];

  return {
    id: "impending_low",
    actionType: "carbs",
    actionClass: "low_carbs",
    rootCause: "impending_low",
    tier,
    severity: severe ? "urgent" : "moderate",
    leadTimeMin,
    orElse,
    magnitudeGrams,
    headline,
    confidence,
    staleness: { pumpStaleMin, cgmStaleMin },
    evidence,
    generatedAt: now,
  };
}
