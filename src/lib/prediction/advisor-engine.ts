// ClearSugar — Action-Advisor unified evaluator (the ActionNeedEvaluator)
//
// Composes the validated advisory producers into one deterministic pass and
// enforces the cross-cutting Hard Safety Rules that must NOT be scattered:
//   HSR #1 — a failing-site / absorption-deficit veto suppresses ALL insulin
//            advice (you never tell a human to add insulin that isn't absorbing).
//   HSR #2 — never emit insulin-suggesting or site-failure advice on stale pump
//            data; downgrade to a single "verify manually" notice instead.
//
// This module is NOT wired to the push path. Wiring it into /api/alerts/check
// (and gating it behind the phase0_eval proving ground) is the live step and is
// deliberately separate. See docs/ADVISOR_CONCEPT_2026-06-19.md §0c.

import type { Treatment } from "../types";
import type { AdvisoryAction, AdvisorInput } from "./advisor-types";
import { evaluateLowTrigger } from "./loop-gap-trigger";
import { evaluateSiteFailure } from "./site-failure-advisor";
import { evaluateHighTrigger } from "./high-trigger";

/** actionTypes that put insulin into the body — vetoed by failing-site / staleness. */
const INSULIN_ACTION_TYPES = new Set<AdvisoryAction["actionType"]>(["correct_by_pen"]);

/**
 * Pump data older than this is "stale": missing insulin is asymmetrically
 * dangerous, so this is tighter than the 30-min CGM/pump-status threshold.
 */
const PUMP_STALE_MIN = 25;

/** Most-recent pump-origin treatment age in minutes (the tconnectsync sync proxy). */
function pumpStalenessMin(treatments: Treatment[], now: number): number | null {
  let latest = -Infinity;
  for (const t of treatments) {
    if (!/tconnectsync/i.test(t.enteredBy ?? "")) continue;
    const ms = t.mills || (t.created_at ? new Date(t.created_at).getTime() : 0);
    if (Number.isFinite(ms) && ms <= now && ms > latest) latest = ms;
  }
  if (!isFinite(latest) || latest <= 0) return null;
  return (now - latest) / 60_000;
}

export interface AdvisorResult {
  actions: AdvisoryAction[];
  /** True when a failing-site absorption-deficit signature currently holds. */
  siteFailureVeto: boolean;
  /** Minutes since the last pump treatment, or null if unknown. */
  pumpStaleMin: number | null;
  /** True when staleness suppressed insulin/site advice. */
  staleSuppressed: boolean;
}

/**
 * Run the full advisory pass. Returns the actions the family should see, with
 * the safety vetoes already applied. Pure + deterministic — the LLM/explainer
 * and the delivery/escalation policy sit OUTSIDE this.
 */
export function evaluateAdvisories(input: AdvisorInput): AdvisorResult {
  const { treatments, now } = input;
  const pumpStaleMin = pumpStalenessMin(treatments, now);
  const stale = pumpStaleMin === null || pumpStaleMin > PUMP_STALE_MIN;

  const site = evaluateSiteFailure(input); // HSR #1 veto source + site advisory
  const low = evaluateLowTrigger(input); // CGM-driven, not insulin
  const high = evaluateHighTrigger(input); // CIQ-capped sustained hyper (insulin advice)

  if (stale) {
    // HSR #2 — stale PUMP data: we can't trust IOB or tell a failing site from an
    // unsynced pump, so insulin/site advice is suppressed. BUT the impending-low
    // → carbs path is CGM-driven (fresh) and isn't insulin, so it still stands.
    // We only surface a stale notice when staleness actually MASKS a high-side
    // advisory (a real missed alert) — routine tconnectsync lag with nothing
    // pending stays SILENT (no notice, no log).
    const out: AdvisoryAction[] = [];
    if (low) out.push(low);
    // HSR #2 — a high-side pen correction is insulin advice: on stale pump data
    // we can't trust IOB, so it's suppressed and surfaced only as a stale notice.
    const masked = site.advisory ?? high;
    if (masked) out.push(staleNotice(pumpStaleMin, now, masked));
    return {
      actions: dedupSort(out),
      siteFailureVeto: site.veto,
      pumpStaleMin,
      staleSuppressed: masked !== null,
    };
  }

  const actions: AdvisoryAction[] = [];
  if (site.advisory) actions.push(site.advisory);
  if (low) actions.push(low);
  if (high) actions.push(high); // gated by HSR #1 below (correct_by_pen is insulin)

  // HSR #1 — drop any insulin-suggesting action when the site veto is active.
  // (No current producer emits one; this enforces the rule for future hyper /
  // correction advisories so the invariant lives in one place.)
  const gated = site.veto
    ? actions.filter((a) => !INSULIN_ACTION_TYPES.has(a.actionType))
    : actions;

  return {
    actions: dedupSort(gated),
    siteFailureVeto: site.veto,
    pumpStaleMin,
    staleSuppressed: false,
  };
}

/** Dedup by id (root-cause keyed), keep the higher-severity instance, sort desc. */
function dedupSort(list: AdvisoryAction[]): AdvisoryAction[] {
  const byId = new Map<string, AdvisoryAction>();
  for (const a of list) {
    const prev = byId.get(a.id);
    if (!prev || severityRank(a.severity) > severityRank(prev.severity)) byId.set(a.id, a);
  }
  return [...byId.values()].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

function severityRank(s: AdvisoryAction["severity"]): number {
  return ["info", "low", "moderate", "high", "urgent"].indexOf(s);
}

/**
 * Emitted ONLY when stale pump data masks a real high-side advisory — i.e. the
 * advisor would have warned but can't trust the data. This is the "missed alert"
 * case; routine staleness with nothing pending produces no notice at all.
 */
function staleNotice(pumpStaleMin: number | null, now: number, masked: AdvisoryAction): AdvisoryAction {
  const stale = pumpStaleMin === null ? null : Math.round(pumpStaleMin);
  return {
    id: "stale_data",
    actionType: "fingerstick_verify",
    actionClass: "verify",
    rootCause: "stale_data",
    // T1_nudge (passive) since 2026-07-19, was T2_actionable. 30-day outcome
    // harvest: n=25, 48% false_alarm_self_resolved, 0% ciq_absorbed — it never
    // describes a real glucose event, and it was 20% of all pushes. Staleness
    // itself is already covered by six other detectors (iOS >15min stale, iOS
    // >30min pump-stale, the iOS 25-min dead-man watchdog, and three HA
    // watchdogs), several of which keep working when this server is the thing
    // that died. Passive keeps the "something may be developing behind stale
    // data" signal visible in notification centre without interrupting.
    tier: "T1_nudge",
    severity: "moderate",
    leadTimeMin: 0,
    orElse:
      `A possible ${masked.rootCause.replace(/_/g, " ")} was developing, but pump data is ` +
      `${stale === null ? "unavailable" : stale + " min stale"}. Check BG and the site manually.`,
    magnitudeGrams: null,
    headline: "Check BG — pump data stale",
    confidence: 1,
    staleness: { pumpStaleMin: stale, cgmStaleMin: null },
    evidence: [
      `masked advisory: ${masked.id} — ${masked.headline}`,
      stale === null ? "no trustworthy pump timestamp" : `last pump treatment ${stale} min ago (> ${PUMP_STALE_MIN} min)`,
    ],
    generatedAt: now,
  };
}
