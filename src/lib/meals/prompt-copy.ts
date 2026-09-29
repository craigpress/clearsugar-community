/**
 * ClearSugar — meal-prompt push copy (section 4c)
 *
 * The pump path is ~50 minutes late by design (section 2.2), so the copy must
 * quote the bolus's OWN local time and must never say "just now". Everything
 * here is a pure string builder so the wording is testable without APNs.
 *
 * Times are formatted in the patient's timezone (`PATIENT_TZ`) rather than the
 * server's, matching `insights/data-enrichment.ts` — a server TZ change must not
 * silently shift the time Patient reads on his lock screen.
 */

import { PATIENT_TZ } from "@/lib/time";
import type { MealEpisode } from "./types";

/** APNs category the iOS app registers the reply actions under. */
export const MEAL_PROMPT_CATEGORY = "MEAL_PROMPT";

/** U+202F / U+00A0 — the space newer ICU builds put before the meridiem. */
const RE_NBSP = /[\u202f\u00a0]/g;

const clockFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: PATIENT_TZ,
  hour: "numeric",
  minute: "2-digit",
});

/**
 * "2:14 pm" — patient-local, lowercase meridiem.
 *
 * The plan's example rise copy reads "Rising since 12:40" with no meridiem;
 * keeping it here makes "12:40 pm" unambiguous on a lock screen, which is worth
 * three characters.
 */
export function formatClockTime(ms: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  // ICU emits U+202F/U+00A0 before the meridiem in newer Node builds; normalize
  // it so the body is plain ASCII on the wire.
  return clockFmt.format(new Date(ms)).replace(RE_NBSP, " ").toLowerCase();
}

/** "6.2 u" — one decimal, trailing zero kept so 6 u and 6.0 u read alike. */
export function formatInsulin(u: number | undefined): string | null {
  if (typeof u !== "number" || !Number.isFinite(u) || u <= 0) return null;
  return `${u.toFixed(1)} u`;
}

/** "55 g" — whole grams. */
export function formatCarbs(g: number | undefined): string | null {
  if (typeof g !== "number" || !Number.isFinite(g) || g <= 0) return null;
  return `${Math.round(g)} g`;
}

export interface PromptCopy {
  title: string;
  body: string;
}

/**
 * Post-bolus prompt: "2:14 pm bolus, 6.2 u for 55 g. What did you eat?"
 *
 * Degrades cleanly when the pump document is missing a field: an insulin-only
 * bolus reads "2:14 pm bolus, 6.2 u.", and a bolus with neither reads
 * "2:14 pm bolus." — never "undefined u for undefined g".
 */
export function bolusPromptCopy(episode: MealEpisode): PromptCopy {
  const at = formatClockTime(episode.bolusAt ?? episode.openedAt);
  const insulin = formatInsulin(episode.bolusInsulin);
  const carbs = formatCarbs(episode.bolusCarbs);
  let detail = `${at} bolus`;
  if (insulin && carbs) detail += `, ${insulin} for ${carbs}`;
  else if (insulin) detail += `, ${insulin}`;
  else if (carbs) detail += `, ${carbs}`;
  return { title: "Meal check", body: `${detail}. What did you eat?` };
}

/** Rise prompt: "Rising since 12:40 pm. Did you eat something?" */
export function risePromptCopy(episode: MealEpisode): PromptCopy {
  const since = formatClockTime(riseSince(episode));
  return {
    title: "Glucose rising",
    body: `Rising since ${since}. Did you eat something?`,
  };
}

/**
 * When the rise started — what "rising since" means.
 *
 * `riseDetectedAt` is the NEWEST reading in the detection window — the moment we
 * noticed — while the copy has to name the moment the trace turned up, which the
 * detector reports as the window start and `detect.ts` stores as `riseSinceAt`.
 * Falls back to the detection point, then to `openedAt`.
 */
function riseSince(episode: MealEpisode): number {
  return episode.riseSinceAt ?? episode.riseDetectedAt ?? episode.openedAt;
}

/** The copy for whichever trigger is prompting. */
export function promptCopy(episode: MealEpisode, kind: "bolus" | "rise"): PromptCopy {
  return kind === "bolus" ? bolusPromptCopy(episode) : risePromptCopy(episode);
}

/**
 * The custom payload merged beside `aps` (section 4c). Keys are flat and
 * primitive so the iOS `userInfo` decode cannot fail on a nested optional.
 */
export function promptUserInfo(
  episode: MealEpisode,
  kind: "bolus" | "rise"
): Record<string, unknown> {
  return {
    kind: "meal_prompt",
    episodeId: episode.id,
    trigger: episode.trigger,
    promptKind: kind,
    ...(episode.bolusAt !== undefined && { bolusAt: episode.bolusAt }),
    ...(episode.bolusCarbs !== undefined && { carbs: episode.bolusCarbs }),
    ...(episode.bolusInsulin !== undefined && { insulin: episode.bolusInsulin }),
    ...(episode.riseDetectedAt !== undefined && { riseSince: riseSince(episode) }),
  };
}
