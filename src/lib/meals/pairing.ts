/**
 * ClearSugar — episode/bolus pairing and reply mapping (section 4a / 4c)
 *
 * Two jobs, both pure:
 *
 *  1. **Pairing.** A rise or "eating now" episode is joined to the pump meal
 *     bolus that lands in its window, up to an hour later, when the tconnectsync
 *     batch finally arrives. The reply becomes that bolus's annotation and the
 *     bolus trigger must not prompt again for the same pump event (risk 3).
 *
 *  2. **Reply mapping.** `minutesBolusToEat` is the whole point of feature B, so
 *     where it comes from matters: a MEASURED delay (an "eating now" tap against
 *     the bolus time) always beats the chip the patient picked, and the chip
 *     beats nothing. A reply NEVER writes carbs (risk 1) — only feature A does.
 */

import { treatmentTime } from "@/lib/time";
import { validateEstimate, attachProvenance } from "./nutrition-validate";
import type { Treatment } from "@/lib/types";
import type {
  EatTiming,
  EpisodeReply,
  MealEpisode,
  NutritionEstimate,
  ReplyKind,
} from "./types";

const MIN = 60_000;

/** A "No" reply suppresses the rise trigger for an hour (decision 3a). */
export const NO_REPLY_SUPPRESSION_MIN = 60;

export const REPLY_KINDS: ReplyKind[] = ["chip", "text", "photo", "dismiss"];
export const EAT_TIMINGS: EatTiming[] = [
  "before_bolus",
  "with_bolus",
  "5",
  "15",
  "30",
  "60plus",
  "unknown",
];

export const MAX_REPLY_TEXT_LEN = 280;
export const MAX_ID_LEN = 64;

/**
 * Chip → minutes from bolus to first bite (section 4c).
 *
 * `before_bolus` is -10: the patient ate first and dosed after, and the sign is
 * the fact worth keeping. `unknown` maps to null, not 0 — "I don't remember" is
 * not "simultaneous", and a 0 would poison the Phase 4 feature.
 */
export function minutesFromEatTiming(eatTiming: EatTiming | undefined): number | null {
  switch (eatTiming) {
    case "before_bolus":
      return -10;
    case "with_bolus":
      return 0;
    case "5":
      return 5;
    case "15":
      return 15;
    case "30":
      return 30;
    case "60plus":
      return 60;
    default:
      return null;
  }
}

/** Measured delay from an "eating now" tap against a known bolus time. */
export function measuredMinutesBolusToEat(
  episode: Pick<MealEpisode, "eatingAt" | "bolusAt">
): number | null {
  const { eatingAt, bolusAt } = episode;
  if (typeof eatingAt !== "number" || typeof bolusAt !== "number") return null;
  if (!Number.isFinite(eatingAt) || !Number.isFinite(bolusAt)) return null;
  return Math.round((eatingAt - bolusAt) / MIN);
}

/**
 * Join a pump meal bolus onto an episode the other trigger opened.
 *
 * Returns a NEW episode object (never mutates): status `reconciled`, the pump
 * facts copied off the treatment, and `minutesBolusToEat` recomputed from the
 * eating tap now that a bolus time exists. An already-answered episode keeps its
 * reply — reconciliation annotates, it does not overwrite.
 */
export function pairEpisodeWithBolus(
  episode: MealEpisode,
  bolusTreatment: Treatment,
  nowMs: number = Date.now()
): MealEpisode {
  const bolusAt = treatmentTime(bolusTreatment);
  const paired: MealEpisode = {
    ...episode,
    status: "reconciled",
    bolusLinkSource: "time_window",
    bolusId: bolusTreatment._id,
    pumpEventId: bolusTreatment.pump_event_id,
    bolusAt: Number.isFinite(bolusAt) ? bolusAt : episode.bolusAt,
    bolusInsulin: bolusTreatment.insulin ?? undefined,
    bolusCarbs: bolusTreatment.carbs ?? undefined,
    reply: episode.reply,
  };
  const measured = measuredMinutesBolusToEat(paired);
  const fromChip = minutesFromEatTiming(paired.reply?.eatTiming);
  const resolved = measured ?? fromChip ?? paired.minutesBolusToEat ?? null;
  if (resolved !== null) paired.minutesBolusToEat = resolved;
  if (measured !== null) paired.delaySource = "reported_time_minus_pump_time";
  else if (fromChip !== null) paired.delaySource = "reported_category";
  paired.reconciledAt = nowMs;
  return paired;
}

// ── Reply mapping ─────────────────────────────────────────────────────────────

export interface ReplyInput {
  episodeId: string;
  kind: ReplyKind;
  ateSomething?: boolean;
  bolused?: boolean;
  eatTiming?: EatTiming;
  text?: string;
  photoId?: string;
  nutrition?: NutritionEstimate;
  /** Links a reply to a MealLog the client wrote via POST /api/meals. */
  mealLogId?: string;
}

export type ReplyValidation =
  | { ok: true; value: ReplyInput }
  | { ok: false; errors: string[] };

function isPlausibleNutrition(v: unknown): v is NutritionEstimate {
  // Structural check only. The clamping validator lives in
  // meals/nutrition-validate.ts (feature C) and owns the plausibility rules; a
  // reply must not silently accept a shape the estimate route would reject.
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const n = v as Record<string, unknown>;
  const carbs = n.carbs as Record<string, unknown> | undefined;
  if (!carbs || typeof carbs !== "object") return false;
  const nums = [carbs.low, carbs.mid, carbs.high, n.confidence];
  if (!nums.every((x) => typeof x === "number" && Number.isFinite(x))) return false;
  return typeof n.model === "string" && typeof n.provider === "string";
}

/** Validate a POST /api/meals/reply body. Reports every problem, not the first. */
export function validateReplyInput(body: unknown): ReplyValidation {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  let episodeId = "";
  if (typeof b.episodeId !== "string") errors.push("episodeId must be a string");
  else {
    episodeId = b.episodeId.trim();
    if (!episodeId) errors.push("episodeId must not be empty");
    else if (episodeId.length > MAX_ID_LEN) {
      errors.push(`episodeId must be at most ${MAX_ID_LEN} characters`);
    }
  }

  const kind = b.kind as ReplyKind;
  if (typeof b.kind !== "string" || !REPLY_KINDS.includes(kind)) {
    errors.push(`kind must be one of ${REPLY_KINDS.join(", ")}`);
  }

  for (const flag of ["ateSomething", "bolused"] as const) {
    if (b[flag] !== undefined && typeof b[flag] !== "boolean") {
      errors.push(`${flag} must be a boolean`);
    }
  }

  let eatTiming: EatTiming | undefined;
  if (b.eatTiming !== undefined) {
    if (typeof b.eatTiming !== "string" || !EAT_TIMINGS.includes(b.eatTiming as EatTiming)) {
      errors.push(`eatTiming must be one of ${EAT_TIMINGS.join(", ")}`);
    } else {
      eatTiming = b.eatTiming as EatTiming;
    }
  }

  let text: string | undefined;
  if (b.text !== undefined) {
    if (typeof b.text !== "string") errors.push("text must be a string");
    else if (b.text.length > MAX_REPLY_TEXT_LEN) {
      errors.push(`text must be at most ${MAX_REPLY_TEXT_LEN} characters`);
    } else {
      const trimmed = b.text.trim();
      if (trimmed) text = trimmed;
    }
  }

  const ids: Record<string, string | undefined> = {};
  for (const field of ["photoId", "mealLogId"] as const) {
    if (b[field] === undefined) continue;
    if (typeof b[field] !== "string") errors.push(`${field} must be a string`);
    else if ((b[field] as string).length > MAX_ID_LEN) {
      errors.push(`${field} must be at most ${MAX_ID_LEN} characters`);
    } else {
      const trimmed = (b[field] as string).trim();
      if (trimmed) ids[field] = trimmed;
    }
  }

  let nutrition: NutritionEstimate | undefined;
  if (b.nutrition !== undefined) {
    if (!isPlausibleNutrition(b.nutrition)) {
      errors.push("nutrition must be a NutritionEstimate from /api/meals/estimate");
    } else {
      const validated = validateEstimate(b.nutrition);
      if (!validated.ok) errors.push("nutrition must be a valid estimate");
      else nutrition = attachProvenance(validated.value, b.nutrition, Date.now());
    }
  }

  if (kind === "photo" && !ids.photoId) errors.push("kind 'photo' requires photoId");

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      episodeId,
      kind,
      ateSomething: b.ateSomething as boolean | undefined,
      bolused: b.bolused as boolean | undefined,
      eatTiming,
      text,
      photoId: ids.photoId,
      mealLogId: ids.mealLogId,
      nutrition,
    },
  };
}

export interface AppliedReply {
  episode: MealEpisode;
  /** Set when the reply was "no, I did not eat": suppress the rise trigger. */
  riseSuppressedUntil?: number;
}

/**
 * Apply a validated reply to an episode.
 *
 * Status rules from section 4c:
 *  - `ateSomething: false` (or a dismiss) CLOSES the episode and starts a
 *    60-minute rise suppression; the negative label is kept.
 *  - anything else marks it `answered` and leaves it active until expiry, so a
 *    pump bolus arriving later still reconciles into it. An already-reconciled
 *    episode keeps that status — the pump fact outranks the label.
 */
export function applyReply(
  episode: MealEpisode,
  input: ReplyInput,
  nowMs: number
): AppliedReply {
  const reply: EpisodeReply = {
    kind: input.kind,
    ...(input.ateSomething !== undefined && { ateSomething: input.ateSomething }),
    ...(input.bolused !== undefined && { bolused: input.bolused }),
    ...(input.eatTiming !== undefined && { eatTiming: input.eatTiming }),
    ...(input.text !== undefined && { text: input.text }),
    ...(input.photoId !== undefined && { photoId: input.photoId }),
    ...(input.nutrition !== undefined && { nutrition: input.nutrition }),
  };

  const saidNo = input.ateSomething === false || input.kind === "dismiss";
  const next: MealEpisode = {
    ...episode,
    reply,
    answeredAt: nowMs,
    status: saidNo ? "closed" : episode.status === "reconciled" ? "reconciled" : "answered",
    ...(input.mealLogId !== undefined && { mealLogId: input.mealLogId }),
  };

  // Measured delay wins over the chip; the chip wins over nothing. A reply must
  // never overwrite a measured value with a coarse chip.
  const measured = measuredMinutesBolusToEat(next);
  const fromChip = minutesFromEatTiming(input.eatTiming);
  const resolved = measured ?? fromChip;
  if (resolved !== null && resolved !== undefined) next.minutesBolusToEat = resolved;
  if (measured !== null) next.delaySource = "reported_time_minus_pump_time";
  else if (fromChip !== null) next.delaySource = "reported_category";

  return {
    episode: next,
    ...(saidNo && { riseSuppressedUntil: nowMs + NO_REPLY_SUPPRESSION_MIN * MIN }),
  };
}
