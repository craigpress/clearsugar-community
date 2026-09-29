/**
 * ClearSugar — feature A: log carbs that were eaten without a bolus
 *
 * Phase 1 of docs/MEAL_LOGGING_PLAN_2026-09-04.md, section 4b. This is the only
 * path in the whole meal-logging feature that ever creates a carb-bearing
 * Nightscout treatment (risk 1: double-counted carbs in COB), so the rules live
 * in a pure module with tests rather than inside the route.
 *
 * A durable reservation freezes the original payload before the remote write.
 * Retries upsert the same Nightscout document and commit the local row once.
 */

import { currentMealChild, isTestMeal } from "./profile-storage";
import { createHash } from "node:crypto";
import type {
  CarbClass,
  CarbReason,
  MealLog,
  MealTreatmentWithNutrition,
  NutritionEstimate,
} from "./types";
import { PHOTO_ID_RE } from "./photos";
import {
  attachProvenance,
  validateEstimate,
  type ValidatedNutrition,
} from "./nutrition-validate";

/** Grams accepted from a client. 150 g is well above any rescue or snack. */
export const MIN_GRAMS = 1;
export const MAX_GRAMS = 150;
export const MAX_CLIENT_ID_LEN = 64;
export const MAX_DESCRIPTION_LEN = 280;
/** `eatenAt` may be backdated this far, and no further. */
export const MAX_BACKDATE_MS = 24 * 60 * 60 * 1000;
/** Tolerance for a device clock running ahead. */
export const MAX_FUTURE_MS = 5 * 60 * 1000;

/** Rescue carbs absorb fast; a snack uses Nightscout's default span. */
export const RESCUE_ABSORPTION_MIN = 30;
export const SNACK_ABSORPTION_MIN = 180;

/** The carb classes a client may log in Phase 1 ("meal" is Phase 3). */
const LOGGABLE_CARB_CLASSES = ["rescue", "snack", "meal"] as const;
export type LoggableCarbClass = (typeof LOGGABLE_CARB_CLASSES)[number];

const CARB_REASONS = ["low", "forgot_bolus", "other"] as const;

/** A validated POST /api/meals body, with defaults resolved. */
export interface UncoveredCarbInput {
  clientId: string;
  grams: number;
  carbClass: LoggableCarbClass;
  reason: CarbReason;
  /** Epoch ms — resolved from the optional ISO `eatenAt`, defaulting to now. */
  eatenAt: number;
  eatenAtSource?: "client_reported" | "server_received";
  /** Trimmed; absent when the client sent nothing or only whitespace. */
  description?: string;
  /** Phase 3: the photo the estimate came from, if there was one. */
  photoId?: string;
  /**
   * Phase 3: the confirmed vision estimate, validated and clamped.
   *
   * Its presence never *creates* carbs on its own — `grams` is still the single
   * number written to Nightscout, and the patient confirmed it (risk 4). The
   * estimate rides along so the macros reach the treatment and the provenance
   * reaches the `MealLog`.
   */
  nutrition?: NutritionEstimate;
}

export type ValidationResult =
  | { ok: true; value: UncoveredCarbInput }
  | { ok: false; errors: string[] };

/**
 * Validate a POST /api/meals body against the section-4b contract.
 *
 * Every problem is reported, not just the first, so a client fixes one round
 * trip's worth of mistakes at a time.
 */
export function validateMealInput(body: unknown, now: number): ValidationResult {
  const errors: string[] = [];
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const b = body as Record<string, unknown>;

  // clientId — the idempotency key, so it is required and bounded.
  let clientId = "";
  if (typeof b.clientId !== "string") {
    errors.push("clientId must be a string");
  } else {
    clientId = b.clientId.trim();
    if (clientId.length === 0) errors.push("clientId must not be empty");
    else if (clientId.length > MAX_CLIENT_ID_LEN) {
      errors.push(`clientId must be at most ${MAX_CLIENT_ID_LEN} characters`);
    }
  }

  // nutrition — a confirmed vision estimate (Phase 3). Validated *before* grams
  // because grams may be derived from it.
  let nutrition: NutritionEstimate | undefined;
  let nutritionCore: ValidatedNutrition | undefined;
  if (b.nutrition !== undefined && b.nutrition !== null) {
    const validated = validateEstimate(b.nutrition);
    if (!validated.ok) {
      for (const e of validated.errors) errors.push(`nutrition: ${e}`);
    } else {
      nutritionCore = validated.value;
      nutrition = attachProvenance(validated.value, b.nutrition, now);
    }
  }

  // grams — required, unless a nutrition estimate can supply it. The derived
  // value still has to clear the same 1..150 bound: a 220 g estimate is a
  // plausible dinner but not something this route may write unreviewed.
  let grams = NaN;
  const gramsOmitted = b.grams === undefined || b.grams === null;
  if (gramsOmitted && nutritionCore) {
    const derived = Math.round(nutritionCore.carbs.mid);
    if (derived < MIN_GRAMS || derived > MAX_GRAMS) {
      errors.push(
        `grams derived from nutrition.carbs.mid (${derived}) must be between ${MIN_GRAMS} and ${MAX_GRAMS}`
      );
    } else {
      grams = derived;
    }
  } else if (typeof b.grams !== "number" || !Number.isFinite(b.grams)) {
    errors.push("grams must be a finite number");
  } else if (b.grams < MIN_GRAMS || b.grams > MAX_GRAMS) {
    errors.push(`grams must be between ${MIN_GRAMS} and ${MAX_GRAMS}`);
  } else {
    grams = b.grams;
  }

  // photoId — a UUID naming a stored photo, never a path.
  let photoId: string | undefined;
  if (b.photoId !== undefined && b.photoId !== null) {
    if (typeof b.photoId !== "string" || !PHOTO_ID_RE.test(b.photoId)) {
      errors.push("photoId must be a UUID");
    } else {
      photoId = b.photoId;
    }
  }

  // carbClass
  let carbClass: LoggableCarbClass | undefined;
  if (
    typeof b.carbClass !== "string" ||
    !(LOGGABLE_CARB_CLASSES as readonly string[]).includes(b.carbClass)
  ) {
    errors.push(`carbClass must be one of ${LOGGABLE_CARB_CLASSES.join(", ")}`);
  } else {
    carbClass = b.carbClass as LoggableCarbClass;
  }

  // reason
  let reason: CarbReason | undefined;
  if (
    typeof b.reason !== "string" ||
    !(CARB_REASONS as readonly string[]).includes(b.reason)
  ) {
    errors.push(`reason must be one of ${CARB_REASONS.join(", ")}`);
  } else {
    reason = b.reason as CarbReason;
  }

  // eatenAt — optional ISO string, defaulting to now.
  let eatenAt = now;
  if (b.eatenAt !== undefined && b.eatenAt !== null) {
    if (typeof b.eatenAt !== "string") {
      errors.push("eatenAt must be an ISO 8601 string");
    } else {
      const parsed = Date.parse(b.eatenAt);
      if (Number.isNaN(parsed)) {
        errors.push("eatenAt must be an ISO 8601 string");
      } else if (parsed < now - MAX_BACKDATE_MS) {
        errors.push("eatenAt must be within the last 24 hours");
      } else if (parsed > now + MAX_FUTURE_MS) {
        errors.push("eatenAt must not be more than 5 minutes in the future");
      } else {
        eatenAt = parsed;
      }
    }
  }

  // description — optional free text (typed or dictated).
  let description: string | undefined;
  if (b.description !== undefined && b.description !== null) {
    if (typeof b.description !== "string") {
      errors.push("description must be a string");
    } else {
      const trimmed = b.description.trim();
      if (trimmed.length > MAX_DESCRIPTION_LEN) {
        errors.push(`description must be at most ${MAX_DESCRIPTION_LEN} characters`);
      } else if (trimmed.length > 0) {
        description = trimmed;
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      clientId,
      grams,
      carbClass: carbClass as LoggableCarbClass,
      reason: reason as CarbReason,
      eatenAt,
      eatenAtSource: b.eatenAt == null ? "server_received" : "client_reported",
      ...(description !== undefined && { description }),
      ...(photoId !== undefined && { photoId }),
      ...(nutrition !== undefined && { nutrition }),
    },
  };
}

/**
 * One-line provenance for the Nightscout `notes` field.
 *
 * Nightscout has nowhere structured to record "a model guessed this", and the
 * treatment is what a clinician sees in the care-portal list — so the range and
 * the confidence ride along in the notes. Whoever reads the chart later can tell
 * a counted 45 g from an estimated one without leaving Nightscout.
 */
export function nutritionNote(nutrition: NutritionEstimate): string {
  const low = Math.round(nutrition.carbs.low);
  const high = Math.round(nutrition.carbs.high);
  const range = low === high ? `${low} g` : `${low}-${high} g`;
  return `AI estimate: ${range} (conf ${nutrition.confidence.toFixed(1)})`;
}

/**
 * The Nightscout document for an uncovered-carb log.
 *
 * No `insulin` field, ever — these are carbs that were NOT covered, and an
 * insulin value here would corrupt IOB. `enteredBy` is forced to "ClearSugar"
 * by `postTreatment`, which is what keeps this document from matching the
 * `tconnectsync` regex behind pump-staleness gating (risk 2).
 *
 * With a confirmed estimate attached, the Nightscout-standard `protein`, `fat`
 * and `fiber` fields are set too, so an FPU / Warsaw-method view (idea 3) has
 * real numbers to read later. `carbs` is still only ever `value.grams` — the
 * single number a human confirmed — never `carbs.high`.
 */
export function buildTreatment(value: UncoveredCarbInput): MealTreatmentWithNutrition {
  const notes = [
    value.description,
    value.nutrition ? nutritionNote(value.nutrition) : undefined,
  ]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" | ");

  return {
    eventType: "Carb Correction",
    carbs: value.grams,
    absorptionTime:
      value.carbClass === "rescue" ? RESCUE_ABSORPTION_MIN : SNACK_ABSORPTION_MIN,
    created_at: new Date(value.eatenAt).toISOString(),
    ...(notes.length > 0 && { notes }),
    foodType: value.reason,
    ...(value.nutrition?.protein !== undefined && { protein: value.nutrition.protein }),
    ...(value.nutrition?.fat !== undefined && { fat: value.nutrition.fat }),
    ...(value.nutrition?.fiber !== undefined && { fiber: value.nutrition.fiber }),
  };
}

/** Raised when the Nightscout mirror failed; the route maps this to 502. */
export class NightscoutMirrorError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? `Nightscout mirror failed: ${cause.message}`
        : "Nightscout mirror failed"
    );
    this.name = "NightscoutMirrorError";
    this.cause = cause;
  }
}

/** Everything `logUncoveredCarbs` touches, injected so it is testable. */
export interface LogUncoveredDeps {
  postTreatment: (doc: MealTreatmentWithNutrition) => Promise<{ _id: string }>;
  store: {
    findMealByClientId: (clientId: string) => Promise<MealLog | null>;
    reserveMeal: (meal: MealLog) => Promise<MealLog>;
    appendMeal: (meal: MealLog) => Promise<unknown>;
  };
  now: () => number;
  uuid: () => string;
}

export interface LogUncoveredResult {
  meal: MealLog;
  /** True when a known `clientId` was replayed; the route answers 200, not 201. */
  replayed: boolean;
}

/**
 * Mirror uncovered carbs to Nightscout and record the `MealLog` row.
 *
 * @throws NightscoutMirrorError when the mirror failed. The reservation remains
 *         so retries reuse the original document ID and payload.
 */
export async function logUncoveredCarbs(
  value: UncoveredCarbInput,
  sub: string,
  deps: LogUncoveredDeps
): Promise<LogUncoveredResult> {
  const existing = await deps.store.findMealByClientId(value.clientId);
  if (existing?.enteredBySub === sub) return { meal: existing, replayed: true };

  const nightscoutId = createHash("sha256").update(JSON.stringify(["clearsugar-meal-v1", sub, value.clientId])).digest("hex").slice(0, 24);
  const meal = await deps.store.reserveMeal({
    schemaVersion: 1,
    eatenAtSource: value.eatenAtSource,
    carbGramsSource: !value.nutrition ? "user_entered"
      : value.grams === Math.round(value.nutrition.carbs.mid) ? "ai_estimate_accepted" : "ai_estimate_edited",
    childId: currentMealChild(),
    isTest: isTestMeal(),
    id: deps.uuid(),
    createdAt: deps.now(),
    eatenAt: value.eatenAt,
    episodeId: deps.uuid(),
    // A confirmed vision estimate is a different provenance from a typed number,
    // and Phase 4 joins on `source` — so record which one it was.
    source: value.nutrition ? "photo_estimated" : "user_logged",
    carbClass: value.carbClass as CarbClass,
    reason: value.reason,
    ...(value.description !== undefined && { description: value.description }),
    grams: value.grams,
    ...(value.photoId !== undefined && { photoId: value.photoId }),
    ...(value.nutrition !== undefined && { nutrition: value.nutrition }),
    nightscoutId,
    enteredBySub: sub,
    clientId: value.clientId,
  });

  try {
    await deps.postTreatment({ ...buildTreatment({ ...meal, grams: meal.grams!, carbClass: meal.carbClass as LoggableCarbClass, reason: meal.reason!, clientId: meal.clientId! }), _id: meal.nightscoutId! });
  } catch (err) {
    throw new NightscoutMirrorError(err);
  }

  await deps.store.appendMeal(meal);
  return { meal, replayed: false };
}
