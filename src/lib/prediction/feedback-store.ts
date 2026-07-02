// ClearSugar — Outcome-harvest + FeedbackData store (Phase 1, P1.6)
//
// When an advisory fires we log it immediately (recordFired). 1–3h later a
// follow-up timer (harvest route) reads Nightscout and records the OUTCOME plus
// a three-way resolution attribution. This is BOTH the safety audit trail AND
// the n-of-1 training set for Phase-3 ML — it needs NO human button input, the
// resolution is auto-derived from observed Nightscout data.
//
// Decoupled from Phase-2 routing on purpose: ML labels must never be hostage to
// button plumbing. "no_response" is a recorded signal, not null.
//
// The attribution is OUTCOME-anchored, not behavior-anchored: we ask "did the
// bad outcome happen and what closed the gap?", not "did a human press a button?".

import { loadJSON, saveJSON } from "../local-store";
import type {
  AdvisoryAction,
  FeedbackRecord,
  ResolutionAttribution,
} from "./advisor-types";
import type { GlucoseReading, Treatment } from "../types";

const FEEDBACK_KEY = "advisor/feedback.json";

/** Horizon over which an outcome is harvested after an advisory fires. */
export const HARVEST_HORIZON_MS = 3 * 60 * 60 * 1000; // 3h

// ── Glycemic thresholds (mg/dL) used to decide "toward range" / "bad outcome" ──
const LOW_THRESHOLD = 70;
const HIGH_THRESHOLD = 180;
/** A low is "recovered" once BG climbs back above this. */
const LOW_RECOVERY = 80;
/** A high is "recovered" once BG drops back below this. */
const HIGH_RECOVERY = 180;
/** Minimum carbs (g) that count as a real rescue treatment for a low. */
const RESCUE_CARB_MIN_G = 5;

// ── Persistence ───────────────────────────────────────────────────────────────

/** Load all feedback records (empty array if none yet). */
export async function loadFeedback(): Promise<FeedbackRecord[]> {
  return loadJSON<FeedbackRecord[]>(FEEDBACK_KEY, []);
}

/** Persist the full feedback record list. */
export async function saveFeedback(records: FeedbackRecord[]): Promise<void> {
  await saveJSON(FEEDBACK_KEY, records);
}

/**
 * Append a freshly-fired advisory to the feedback log with an empty outcome.
 * humanResponse starts as "no_response" (a recorded signal, not null) and
 * harvestedAt is null until the follow-up timer fills it in.
 */
export async function recordFired(
  advisory: AdvisoryAction,
  ciqMode: string | null = null
): Promise<void> {
  const records = await loadFeedback();
  const record: FeedbackRecord = {
    actionId: advisory.id,
    firedAt: advisory.generatedAt,
    advisory,
    ciqMode,
    humanResponse: "no_response",
    outcomeTrajectory: [],
    resolutionAttribution: "unresolved",
    harvestedAt: null,
  };
  records.push(record);
  await saveFeedback(records);
}

// ── Treatment classification helpers (pure) ────────────────────────────────────

function treatmentTime(t: Treatment): number {
  return typeof t.mills === "number" && t.mills > 0
    ? t.mills
    : Date.parse(t.created_at);
}

/** A Control-IQ algorithmic temp basal — the pump acting on its own. */
function isCiqAlgorithmBasal(t: Treatment): boolean {
  return t.eventType === "Temp Basal" && t.reason === "Algorithm";
}

/** A human-entered correction/manual bolus (insulin that is NOT an algo basal). */
function isManualCorrection(t: Treatment): boolean {
  return (
    !isCiqAlgorithmBasal(t) &&
    typeof t.insulin === "number" &&
    (t.insulin ?? 0) > 0
  );
}

/** A meaningful rescue-carb entry (≥5g). */
function isRescueCarb(t: Treatment): boolean {
  return typeof t.carbs === "number" && (t.carbs ?? 0) >= RESCUE_CARB_MIN_G;
}

function isSiteChange(t: Treatment): boolean {
  return t.eventType === "Site Change";
}

/**
 * Does a treatment in the window count as the *relevant* human action for this
 * advisory's root cause?  Low → carbs. failing_site → site change OR manual
 * correction (you fix the site or you correct around it). high → manual
 * correction.
 */
function isRelevantHumanAction(
  rootCause: AdvisoryAction["rootCause"],
  t: Treatment
): boolean {
  switch (rootCause) {
    case "impending_low":
    case "rebound_low":
      return isRescueCarb(t);
    case "failing_site":
      return isSiteChange(t) || isManualCorrection(t);
    case "ciq_capped_high":
      return isManualCorrection(t);
    default:
      // sensor_quality / ketone_risk / stale_data: a manual correction or site
      // change is the closest "human acted" signal available.
      return isManualCorrection(t) || isSiteChange(t);
  }
}

// ── Trajectory + outcome helpers (pure) ────────────────────────────────────────

/** Is this a "low-type" advisory (recovery means BG rising back up)? */
function isLowAdvisory(rootCause: AdvisoryAction["rootCause"]): boolean {
  return rootCause === "impending_low" || rootCause === "rebound_low";
}

/** Is this a "high-type" advisory (recovery means BG dropping back down)? */
function isHighAdvisory(rootCause: AdvisoryAction["rootCause"]): boolean {
  return rootCause === "ciq_capped_high" || rootCause === "failing_site";
}

/**
 * Did BG return toward range over the window?  For a low advisory the trajectory
 * must climb back above LOW_RECOVERY; for a high advisory it must fall back below
 * HIGH_RECOVERY.  For anything else, "in range at the end" suffices.
 */
function bgReturnedTowardRange(
  rootCause: AdvisoryAction["rootCause"],
  trajectory: { t: number; sgv: number }[]
): boolean {
  if (trajectory.length === 0) return false;
  const last = trajectory[trajectory.length - 1].sgv;
  if (isLowAdvisory(rootCause)) {
    return trajectory.some((p) => p.sgv >= LOW_RECOVERY);
  }
  if (isHighAdvisory(rootCause)) {
    return trajectory.some((p) => p.sgv <= HIGH_RECOVERY);
  }
  return last >= LOW_THRESHOLD && last <= HIGH_THRESHOLD;
}

/**
 * Did the predicted bad outcome ever materialize?  Low → BG actually went <70.
 * High → BG actually stayed/went >180.  This is what separates a real event
 * that got resolved from a false alarm that never happened.
 */
function badOutcomeMaterialized(
  rootCause: AdvisoryAction["rootCause"],
  trajectory: { t: number; sgv: number }[]
): boolean {
  if (trajectory.length === 0) return false;
  if (isLowAdvisory(rootCause)) {
    return trajectory.some((p) => p.sgv < LOW_THRESHOLD);
  }
  if (isHighAdvisory(rootCause)) {
    return trajectory.some((p) => p.sgv > HIGH_THRESHOLD);
  }
  return false;
}

// ── Core attribution (PURE — unit-tested) ──────────────────────────────────────

/**
 * Attribute the resolution of a fired advisory from observed Nightscout data.
 *
 * Decision rules (OUTCOME-anchored, evaluated in priority order):
 *
 *   human_acted              — a RELEVANT human treatment appears in
 *                              (firedAt, firedAt+3h]  AND BG returns toward range.
 *   false_alarm_self_resolved — the predicted bad outcome NEVER materialized and
 *                              no relevant human action was taken (regardless of
 *                              routine CIQ basal activity).
 *   ciq_absorbed             — the bad outcome DID begin to materialize, NO
 *                              relevant human treatment, but Control-IQ
 *                              (reason=Algorithm) temp-basal activity exists in
 *                              the window AND BG returns toward range.
 *   unresolved               — the bad outcome occurred / persisted with no
 *                              resolution.
 *
 * Human-vs-CIQ disambiguation: human_acted is checked first and requires a
 * *relevant* human treatment (carbs for a low, correction/site for a high/site).
 * Only when no such treatment exists do we credit CIQ — so a window containing
 * both a human rescue and routine algo basals attributes to the human, never to
 * CIQ. CIQ basals are present in essentially every window, so they can only be
 * the *residual* explanation once human action is ruled out.
 *
 * False-alarm-vs-CIQ disambiguation: false_alarm is checked BEFORE ciq_absorbed.
 * Crediting CIQ requires the bad outcome to have actually begun (materialized) —
 * otherwise, since algo basals exist in nearly every window, CIQ would absorb
 * every benign prediction and false alarms would never be labeled. A prediction
 * whose bad outcome never happened is a false alarm, not a CIQ save.
 */
export function attributeResolution(
  record: FeedbackRecord,
  readingsAfter: GlucoseReading[],
  treatmentsAfter: Treatment[]
): {
  trajectory: { t: number; sgv: number }[];
  attribution: ResolutionAttribution;
} {
  const firedAt = record.firedAt;
  const windowEnd = firedAt + HARVEST_HORIZON_MS;
  const rootCause = record.advisory.rootCause;

  // Sample the BG trajectory over (firedAt, firedAt+3h], oldest→newest.
  const trajectory = readingsAfter
    .filter((r) => r.date > firedAt && r.date <= windowEnd)
    .sort((a, b) => a.date - b.date)
    .map((r) => ({ t: r.date, sgv: r.sgv }));

  // Treatments strictly after the fire, within the window.
  const windowTreatments = treatmentsAfter.filter((t) => {
    const tt = treatmentTime(t);
    return Number.isFinite(tt) && tt > firedAt && tt <= windowEnd;
  });

  const humanActed = windowTreatments.some((t) =>
    isRelevantHumanAction(rootCause, t)
  );
  const ciqActive = windowTreatments.some(isCiqAlgorithmBasal);
  const returned = bgReturnedTowardRange(rootCause, trajectory);
  const materialized = badOutcomeMaterialized(rootCause, trajectory);

  let attribution: ResolutionAttribution;
  if (humanActed && returned) {
    attribution = "human_acted";
  } else if (!humanActed && !materialized) {
    // Bad outcome never happened and no human acted → false alarm, even if
    // routine CIQ basals are present (they almost always are).
    attribution = "false_alarm_self_resolved";
  } else if (!humanActed && materialized && ciqActive && returned) {
    // Bad outcome began, no human acted, CIQ was active, and BG recovered.
    attribution = "ciq_absorbed";
  } else {
    attribution = "unresolved";
  }

  return { trajectory, attribution };
}
