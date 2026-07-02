// ClearSugar — Action-Advisor shared contract
//
// The advisor is a RESIDUAL advisor on top of Control-IQ: it speaks only to the
// gap CIQ cannot close, names a human action + lead time + the concrete "or else",
// and NEVER doses the pump (carb grams only; insulin is direction-only). See
// docs/ADVISOR_CONCEPT_2026-06-19.md and docs/PHASE0_FINDINGS_2026-06-19.md.
//
// This module is the type contract every advisor module codes against. It is NOT
// wired to the push path until each producer is harness-validated.

import type { GlucoseReading, Treatment, PumpProfile, PumpState } from "../types";
import type { AlertInterruptionLevel } from "../apns";

/** The human action an advisory asks for. Insulin is never a unit count. */
export type AdvisoryActionType =
  | "carbs"
  | "correct_by_pen"
  | "change_site"
  | "change_sensor"
  | "fingerstick_verify"
  | "wake_check"
  | "hold";

/** Delivery loudness, decoupled from clinical severity (Phase 0 finding). */
export type DeliveryTier =
  | "T0_silent" // in-app log only, never pushed
  | "T1_nudge" // non-waking banner, batched
  | "T2_actionable" // banner + sound, time-sensitive
  | "T3_urgent" // wake-worthy phone push
  | "T4_critical"; // highest wake tier (severe) — loudest phone push; NO house alarm

export type AdvisorSeverity = "info" | "low" | "moderate" | "high" | "urgent";

/**
 * Coarse class for cooldown keying. Cooldown is keyed on (actionClass, rootCause)
 * and applies only to unchanged/improving situations — a worsening situation or a
 * changed action bypasses cooldown (Hard Safety Rule #8).
 */
export type ActionClass =
  | "low_carbs"
  | "high_correction"
  | "site_change"
  | "sensor"
  | "verify"
  | "info";

export type AdvisorRootCause =
  | "impending_low"
  | "rebound_low"
  | "ciq_capped_high"
  | "failing_site"
  | "sensor_quality"
  | "ketone_risk"
  | "stale_data";

/** A single advisory the family may act on. Produced deterministically. */
export interface AdvisoryAction {
  /** Stable id for dedup/cooldown, e.g. `${rootCause}`. */
  id: string;
  actionType: AdvisoryActionType;
  actionClass: ActionClass;
  rootCause: AdvisorRootCause;
  tier: DeliveryTier;
  severity: AdvisorSeverity;
  /** Minutes of lead before the bad outcome becomes unavoidable at safe-max action. */
  leadTimeMin: number;
  /** The concrete bad outcome justifying the alert (the "or else") — shown in the body. */
  orElse: string;
  /** Carb grams ONLY. Insulin is direction-only — never a unit count. null when N/A. */
  magnitudeGrams: number | null;
  /** Action-first headline, e.g. "~10g fast carbs now" / "manual correction now". */
  headline: string;
  /** Confidence 0..1 — gates escalation; cold-start / sparse data lowers it. */
  confidence: number;
  /** Whether this advice was computed on stale data (drives suppression, HSR #2). */
  staleness: { pumpStaleMin: number | null; cgmStaleMin: number | null };
  /** Evidence strings for the audit trail + the LLM explainer (never the dose source). */
  evidence: string[];
  generatedAt: number;
}

/** Everything an advisor producer needs. */
export interface AdvisorInput {
  readings: GlucoseReading[];
  treatments: Treatment[];
  profile: PumpProfile;
  now: number;
  /**
   * Latest pump-state doc (pump IOB + real Control-IQ settings) from NS
   * devicestatus. Optional/nullable — every consumer MUST degrade to
   * profile-derived defaults when it is absent, so existing validated behavior
   * is unchanged whenever the pump-state job hasn't published.
   */
  pumpState?: PumpState | null;
}

/** Tier → iOS interruption-level (T4 = loudest phone push; no house siren / Apple Critical). */
export const TIER_INTERRUPTION: Record<DeliveryTier, AlertInterruptionLevel> = {
  T0_silent: "passive",
  T1_nudge: "passive",
  T2_actionable: "active",
  T3_urgent: "time-sensitive",
  T4_critical: "time-sensitive",
};

/** Tiers that never produce a push (in-app only). */
export const SILENT_TIERS: ReadonlySet<DeliveryTier> = new Set<DeliveryTier>(["T0_silent"]);

// ── Feedback / outcome-harvest (the n-of-1 label stream + safety audit trail) ──

export type ResolutionAttribution =
  | "human_acted"
  | "ciq_absorbed"
  | "false_alarm_self_resolved"
  | "unresolved";

export type HumanResponse =
  | "acted"
  | "dismissed"
  | "snoozed"
  | "did_something_else"
  | "no_response";

/** One fired advisory + its harvested outcome. Outcome-anchored, not behavior-anchored. */
export interface FeedbackRecord {
  actionId: string;
  firedAt: number;
  advisory: AdvisoryAction;
  ciqMode: string | null;
  humanResponse: HumanResponse;
  /** BG trajectory sampled over the following 1–3h, harvested by the follow-up timer. */
  outcomeTrajectory: { t: number; sgv: number }[];
  resolutionAttribution: ResolutionAttribution;
  /** null until the follow-up timer harvests the outcome. */
  harvestedAt: number | null;
}
