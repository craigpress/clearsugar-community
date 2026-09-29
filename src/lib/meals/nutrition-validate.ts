/**
 * ClearSugar — vision-LLM nutrition guardrail
 *
 * Risk 4 of docs/MEAL_LOGGING_PLAN_2026-09-04.md: a hallucinated carb count that
 * becomes an insulin decision. Nothing a model emits reaches the UI or a
 * `MealLog` without passing through here first, so this module is deliberately
 * paranoid in one direction only:
 *
 *   - a *missing or unusable* carb estimate is a hard failure (the route answers
 *     422 with the raw text, and the patient sees "the estimate failed", not a
 *     number);
 *   - a *present but implausible* number is clamped to the contract's range
 *     rather than rejected, because a model saying "800 g of carbs" is still
 *     telling us it saw a big plate;
 *   - `confidence` is required, because the whole display contract is "a range
 *     plus a confidence" and a silent default would fake certainty we never had;
 *   - every *optional* field that arrives malformed is dropped, never guessed.
 *
 * Ranges come from section 4c: carbs.low <= mid <= high, all within 0..300 g;
 * protein/fat/fiber 0..200 g; confidence 0..1; giClass low|medium|high.
 */

import type { NutritionEstimate } from "./types";

export const MAX_CARBS_G = 300;
export const MAX_MACRO_G = 200;
export const MAX_ITEMS = 20;
export const MAX_ITEM_NAME_LEN = 80;
export const MAX_ITEM_PORTION_LEN = 60;
/** How much model prose is kept as provenance on a stored estimate. */
export const MAX_RAW_RESPONSE_LEN = 8000;
export const MAX_MODEL_NAME_LEN = 120;

const GI_CLASSES = ["low", "medium", "high"] as const;

/**
 * The validated nutrition facts, without provenance.
 *
 * `vision-client.ts` adds model/provider/estimatedAt/rawResponse itself; a
 * client round-tripping an estimate back to `POST /api/meals` carries its own,
 * which `attachProvenance` re-validates.
 */
export type ValidatedNutrition = Omit<
  NutritionEstimate,
  "model" | "provider" | "estimatedAt" | "rawResponse"
>;

export type NutritionValidation =
  | { ok: true; value: ValidatedNutrition }
  | { ok: false; errors: string[] };

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function finiteNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

/** Clamp an optional macro (protein/fat/fiber). Returns undefined when absent
 *  or unusable — a dropped field is honest, a zero would not be. */
function optionalMacro(v: unknown): number | undefined {
  const n = finiteNumber(v);
  if (n === undefined) return undefined;
  return clamp(n, 0, MAX_MACRO_G);
}

/**
 * Read the carb triple.
 *
 * Tolerates the shapes models actually emit: the full object, a partial object
 * (any one of low/mid/high), and a bare number. Every value is clamped to
 * 0..300 g and the triple is then sorted, so `low <= mid <= high` holds even if
 * the model swapped them.
 */
function readCarbs(
  raw: unknown
): { low: number; mid: number; high: number } | undefined {
  if (typeof raw === "number") {
    const n = finiteNumber(raw);
    if (n === undefined) return undefined;
    const c = clamp(n, 0, MAX_CARBS_G);
    return { low: c, mid: c, high: c };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const low = finiteNumber(o.low);
  const mid = finiteNumber(o.mid);
  const high = finiteNumber(o.high);
  const present = [low, mid, high].filter((n): n is number => n !== undefined);
  if (present.length === 0) return undefined;

  // Fill the gaps from what we do have rather than failing: a model that gave
  // only `mid` still gave us a usable point estimate.
  const fallback = mid ?? present[0];
  const triple = [low ?? fallback, mid ?? fallback, high ?? fallback]
    .map((n) => clamp(n, 0, MAX_CARBS_G))
    .sort((a, b) => a - b);
  return { low: triple[0], mid: triple[1], high: triple[2] };
}

function readGiClass(raw: unknown): "low" | "medium" | "high" | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  return (GI_CLASSES as readonly string[]).includes(v)
    ? (v as "low" | "medium" | "high")
    : undefined;
}

function readItems(raw: unknown): ValidatedNutrition["items"] {
  if (!Array.isArray(raw)) return undefined;
  const out: NonNullable<ValidatedNutrition["items"]> = [];
  for (const entry of raw) {
    if (out.length >= MAX_ITEMS) break; // truncate, do not reject
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name.trim().slice(0, MAX_ITEM_NAME_LEN) : "";
    if (name.length === 0) continue; // an unnamed item tells the patient nothing
    const portion =
      typeof e.portion === "string" ? e.portion.trim().slice(0, MAX_ITEM_PORTION_LEN) : "";
    const carbs = clamp(finiteNumber(e.carbs) ?? 0, 0, MAX_CARBS_G);
    out.push({ name, portion, carbs });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Validate and clamp a model's nutrition object.
 *
 * Hard failures (the only ones): the value is not a JSON object, carbs are
 * missing/unusable, or confidence is missing/non-numeric.
 */
export function validateEstimate(raw: unknown): NutritionValidation {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["estimate must be a JSON object"] };
  }
  const o = raw as Record<string, unknown>;
  const errors: string[] = [];

  const carbs = readCarbs(o.carbs);
  if (!carbs) {
    errors.push("carbs must be a number or an object with low/mid/high grams");
  }

  const confidenceRaw = finiteNumber(o.confidence);
  if (confidenceRaw === undefined) {
    errors.push("confidence must be a number between 0 and 1");
  }

  if (errors.length > 0) return { ok: false, errors };

  const value: ValidatedNutrition = {
    carbs: carbs as { low: number; mid: number; high: number },
    confidence: clamp(confidenceRaw as number, 0, 1),
  };

  const protein = optionalMacro(o.protein);
  if (protein !== undefined) value.protein = protein;
  const fat = optionalMacro(o.fat);
  if (fat !== undefined) value.fat = fat;
  const fiber = optionalMacro(o.fiber);
  if (fiber !== undefined) value.fiber = fiber;

  const giClass = readGiClass(o.giClass);
  if (giClass !== undefined) value.giClass = giClass;

  const items = readItems(o.items);
  if (items !== undefined) value.items = items;
  if (typeof o.notes === "string") value.notes = o.notes.trim().slice(0, 2000);
  if (typeof o.followUp === "string") value.followUp = o.followUp.trim().slice(0, 1000);

  return { ok: true, value };
}

/**
 * Re-attach provenance to a validated estimate a client sent back.
 *
 * The client round-trips the object it got from `POST /api/meals/estimate`, so
 * `model`/`provider`/`estimatedAt`/`rawResponse` come back as client-supplied
 * strings: bounded here, and defaulted to "unknown"/0/"" rather than trusted, so
 * a stored `MealLog` always says where its numbers came from.
 */
export function attachProvenance(
  value: ValidatedNutrition,
  raw: unknown,
  now: number
): NutritionEstimate {
  const o =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const model =
    typeof o.model === "string" && o.model.trim().length > 0
      ? o.model.trim().slice(0, MAX_MODEL_NAME_LEN)
      : "unknown";
  const provider =
    typeof o.provider === "string" && o.provider.trim().length > 0
      ? o.provider.trim().slice(0, MAX_MODEL_NAME_LEN)
      : "unknown";
  const parsedAt = typeof o.estimatedAt === "string" ? Date.parse(o.estimatedAt) : o.estimatedAt;
  const estimatedAt = finiteNumber(parsedAt) ?? now;
  const rawResponse =
    typeof o.rawResponse === "string" ? o.rawResponse.slice(0, MAX_RAW_RESPONSE_LEN) : "";
  return { ...value, model, provider, estimatedAt, rawResponse,
    ...(typeof o.estimateId === "string" && /^[0-9a-f-]{36}$/i.test(o.estimateId) && { estimateId: o.estimateId }),
    ...(typeof o.promptVersion === "string" && { promptVersion: o.promptVersion.slice(0, 80) }),
  };
}
