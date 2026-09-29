/**
 * ClearSugar — meal-logging types
 *
 * Phase 1 of docs/MEAL_LOGGING_PLAN_2026-09-04.md (section 3). The carb fact
 * itself lives in Nightscout so every downstream consumer (COB, predictions,
 * advisor, ML training, Live Activity) sees it; everything that is *about* the
 * meal but not a carb fact lives in a `MealLog` row beside it.
 *
 * `src/lib/types.ts` is owned elsewhere, so the one Nightscout field Phase 1
 * needs and `Treatment` does not yet carry (`foodType`) is added here as an
 * intersection rather than by editing that file.
 */

import type { NewTreatment } from "@/lib/nightscout";

/** How fast the carbs absorb. Drives the COB curve: rescue uses the 30-minute
 *  span, snack/meal the 180-minute default. */
export type CarbClass = "rescue" | "snack" | "meal";

/** Why carbs were eaten without a bolus. Mirrored to Nightscout as `foodType`. */
export type CarbReason = "low" | "forgot_bolus" | "other";

/** Where the row came from. Only `user_logged` exists in Phase 1. */
export type MealSource = "pump_bolus" | "user_logged" | "photo_estimated";

/** Answer to "when did you eat relative to the bolus?" (feature B, Phase 2). */
export type EatTiming =
  | "before_bolus"
  | "with_bolus"
  | "5"
  | "15"
  | "30"
  | "60plus"
  | "unknown";

/** Which detector opened the episode (feature B, Phase 2). */
export type PromptTrigger = "pump_bolus" | "glucose_rise";

export interface NutritionEstimate {
  estimateId?: string;
  promptVersion?: string;
  notes?: string;
  followUp?: string;
  carbs: { low: number; mid: number; high: number };
  protein?: number;
  fat?: number;
  fiber?: number;
  giClass?: "low" | "medium" | "high";
  /** 0..1, model-reported and then clamped by our validator. */
  confidence: number;
  items?: { name: string; portion: string; carbs: number }[];
  model: string;
  provider: string;
  estimatedAt: number;
  rawResponse: string;
}

export interface MealLog {
  schemaVersion?: 1;
  eatenAtSource?: "client_reported" | "server_received";
  carbGramsSource?: "user_entered" | "ai_estimate_accepted" | "ai_estimate_edited";
  childId?: string;
  isTest?: boolean;
  id: string;
  createdAt: number;
  eatenAt: number;
  /** One meal = one episode, whichever trigger saw it first. */
  episodeId: string;
  trigger?: PromptTrigger;
  riseDetectedAt?: number;
  /** Set when a later pump bolus was paired to this episode. */
  reconciledAt?: number;
  source: MealSource;
  carbClass: CarbClass;
  reason?: CarbReason;
  description?: string;
  /** Grams are only set for feature A (uncovered carbs). */
  grams?: number;
  nutrition?: NutritionEstimate;
  photoId?: string;
  bolusId?: string;
  pumpEventId?: string;
  minutesBolusToEat?: number;
  eatTiming?: EatTiming;
  /** Set once mirrored to Nightscout so a retry cannot double-write. */
  nightscoutId?: string | null;
  /** Authentik subject of whoever logged it. */
  enteredBySub: string;
  /** Device-minted idempotency key; replaying it returns the same row. */
  clientId: string;
}

/**
 * A Nightscout treatment document ClearSugar is about to write for a meal.
 * `foodType` is a Nightscout-standard field that `Treatment` does not declare
 * yet; `postTreatment` passes the document through verbatim, so widening it
 * here is enough.
 */
export type MealTreatment = NewTreatment & { foodType?: string; _id?: string };

// ─── Phase 2 (feature B: post-bolus / glucose-rise prompts) ────────────────────
//
// Section 4c of docs/MEAL_LOGGING_PLAN_2026-09-04.md. One meal = one episode,
// whichever trigger saw it first; the episode is the idempotency unit that keeps
// a single meal from producing two prompts (risk 3, prompt fatigue).

/** Which detector opened the episode. Superset of `PromptTrigger`: an "eating
 *  now" tap opens an episode but never prompts. */
export type EpisodeTrigger = PromptTrigger | "eating_now";

/**
 * Episode lifecycle:
 *   open        — recorded, not yet prompted (or shadow mode, which never prompts)
 *   prompted    — a push was delivered to at least one patient device
 *   answered    — a reply arrived
 *   reconciled  — a pump meal bolus was paired to a rise/eating episode
 *   expired     — TTL elapsed with no reply
 *   closed      — answered "no, I did not eat" (a kept negative label)
 */
export type EpisodeStatus =
  | "open"
  | "prompted"
  | "answered"
  | "reconciled"
  | "expired"
  | "closed";

/** How the patient answered a prompt. */
export type ReplyKind = "chip" | "text" | "photo" | "dismiss";

export interface EpisodeReply {
  kind: ReplyKind;
  ateSomething?: boolean;
  bolused?: boolean;
  eatTiming?: EatTiming;
  text?: string;
  photoId?: string;
  nutrition?: NutritionEstimate;
}

export interface MealEpisode {
  schemaVersion?: 1;
  childId?: string;
  isTest?: boolean;
  eatingAtSource?: "client_reported" | "server_received";
  eatingReportedAt?: number;
  bolusLinkSource?: "pump_trigger" | "time_window";
  delaySource?: "reported_time_minus_pump_time" | "reported_category";
  id: string;
  openedAt: number;
  expiresAt: number;
  trigger: EpisodeTrigger;
  status: EpisodeStatus;
  /** From the pump treatment, once one is known. */
  bolusId?: string;
  pumpEventId?: string;
  bolusAt?: number;
  bolusInsulin?: number;
  bolusCarbs?: number;
  /** From the CGM trace (glucose_rise trigger). */
  riseDetectedAt?: number;
  /** Start of the detection window — the time the prompt copy quotes as
   *  "rising since". Not in the section-4c shape; `riseDetectedAt` is the
   *  moment of detection, which is up to 30 minutes later. */
  riseSinceAt?: number;
  riseFromMgdl?: number;
  riseToMgdl?: number;
  /** From an "eating now" tap. */
  eatingAt?: number;
  promptedAt?: number;
  shadowPromptedAt?: number;
  promptCount: number;
  lastPromptKind?: "bolus" | "rise";
  answeredAt?: number;
  /** Set when a later pump meal bolus was paired into this episode, mirroring
   *  `MealLog.reconciledAt`. */
  reconciledAt?: number;
  reply?: EpisodeReply;
  /** Minutes from bolus to first bite: negative = ate before bolusing. */
  minutesBolusToEat?: number;
  mealLogId?: string;
  /** True when MEAL_PROMPT_SHADOW was on, so no push was attempted. */
  shadow: boolean;
  /** Device-minted idempotency key for POST /api/meals/eating. Not in the
   *  section-4c shape; required to make that route's documented replay work. */
  clientId?: string;
}

/**
 * Cross-episode prompt state (`meals/prompt-state.json`): the shared daily cap
 * counter (decision 3) and the rise-trigger suppression a "No" reply sets
 * (decision 3a). Kept out of the episode shards so a tick reads one small file.
 */
export interface PromptState {
  /** Patient-local date key ("YYYY-MM-DD") the counter belongs to. */
  dayKey: string;
  shadowPromptCount?: number;
  /** Prompts delivered on `dayKey`, shared by both triggers. */
  promptCount: number;
  /** Epoch ms until which the glucose-rise trigger is suppressed. */
  riseSuppressedUntil?: number;
  /** Date key of the last photo prune, so it runs at most once a day. */
  photoPruneDayKey?: string;
  /** Photos deleted by that prune (observability only). */
  photoPruneDeleted?: number;
}

// ─── Phase 3 (feature C: photo nutrition) ──────────────────────────────────────

/**
 * A meal treatment that also carries the Nightscout-standard macronutrient
 * fields, set when a confirmed vision estimate supplied them.
 *
 * `Treatment` in `src/lib/types.ts` does not declare `protein`/`fat`/`fiber`
 * yet and that file is owned elsewhere; `postTreatment` passes its document
 * through verbatim, so widening the write type here is enough for the round
 * trip to be lossless. Read-side consumers gain the fields when `Treatment`
 * does (plan section 3).
 */
export type MealTreatmentWithNutrition = MealTreatment & {
  protein?: number;
  fat?: number;
  fiber?: number;
};
