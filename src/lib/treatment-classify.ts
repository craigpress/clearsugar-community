import type { Treatment } from "./types";

export type BolusClassification = "meal" | "correction" | "auto" | "extended" | "not_bolus";

function normalizedText(value: string | undefined): string {
  return value ? value.trim().replace(/\s+/g, " ").toLowerCase() : "";
}

export function isPumpTreatment(t: Treatment): boolean {
  return /tconnectsync/i.test(t.enteredBy);
}

export function isAutoBolus(t: Treatment): boolean {
  const text = `${normalizedText(t.notes)} ${normalizedText(t.reason)}`;
  return /automatic|auto correction|auto-correction|auto bolus/.test(text);
}

export function isMealBolus(t: Treatment): boolean {
  return isPumpTreatment(t) && (t.insulin ?? 0) > 0 && (t.carbs ?? 0) > 0 && !isAutoBolus(t);
}

export function isCorrectionBolus(t: Treatment): boolean {
  return isPumpTreatment(t) && (t.insulin ?? 0) > 0 && (t.carbs ?? 0) <= 0 && !isAutoBolus(t);
}

export function classifyBolus(t: Treatment): BolusClassification {
  if (!isPumpTreatment(t) || (t.insulin ?? 0) <= 0) return "not_bolus";
  if (isAutoBolus(t)) return "auto";
  if (isMealBolus(t)) return "meal";
  if (/extended bolus/.test(normalizedText(t.notes))) return "extended";
  if (isCorrectionBolus(t)) {
    const text = `${normalizedText(t.notes)} ${normalizedText(t.reason)}`;
    if (/override|correction/.test(text) || /bolus/.test(normalizedText(t.eventType))) return "correction";
  }
  return "not_bolus";
}

export function treatmentKey(t: Treatment): string {
  return t.pump_event_id ?? t._id;
}
