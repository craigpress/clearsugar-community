/**
 * Pure policy helpers for glucose alert cooldowns, per-device acks, sustained
 * in-range clearing, and HA backstop gating. Extracted 2026-07-24 after a night
 * of alert storms traced to three defects in push/send:
 *
 *  1. The cooldown state was a single global {lastAlertType, lastAlertTime}.
 *     Devices at different thresholds classify the same reading differently
 *     (one phone's urgentHigh is another's high), so each cycle overwrote the
 *     type and the other group bypassed the cooldown — alerts fired every 5
 *     minutes for 40 minutes against a nominal 30-min cooldown.
 *  2. Any single in-range reading wiped the whole state (and untilRange
 *     snoozes), so glucose hovering at a threshold re-alerted on every crossing.
 *  3. Acknowledge never reached the server at all.
 */

export interface CategoryAlertState {
  lastAlertTime: number;
  lastSgv: number;
}

export interface GlucoseAlertStateV2 {
  categories: Record<string, CategoryAlertState>;
  /** ms epoch the readings first came back in range for every device (0 = currently out of range). */
  inRangeSince: number;
}

/** v1 shape, kept for migration. */
interface GlucoseAlertStateV1 {
  lastAlertType: string;
  lastAlertTime: number;
  lastSgv: number;
}

/** Accept v1, v2, or empty state from disk and return v2. */
export function migrateAlertState(raw: unknown): GlucoseAlertStateV2 {
  const obj = (raw ?? {}) as Record<string, unknown>;
  if (obj && typeof obj === "object" && "categories" in obj) {
    const v2 = obj as unknown as GlucoseAlertStateV2;
    return {
      categories: v2.categories ?? {},
      inRangeSince: typeof v2.inRangeSince === "number" ? v2.inRangeSince : 0,
    };
  }
  if (obj && typeof obj === "object" && "lastAlertType" in obj) {
    const v1 = obj as unknown as GlucoseAlertStateV1;
    return {
      categories: { [v1.lastAlertType]: { lastAlertTime: v1.lastAlertTime, lastSgv: v1.lastSgv } },
      inRangeSince: 0,
    };
  }
  return { categories: {}, inRangeSince: 0 };
}

/** Whether this category is past its own cooldown (other categories are irrelevant). */
export function categoryCooldownPassed(
  state: GlucoseAlertStateV2,
  alertType: string,
  now: number,
  cooldownMs: number,
): boolean {
  const cat = state.categories[alertType];
  if (!cat) return true;
  return now - cat.lastAlertTime > cooldownMs;
}

/** Stamp a fired category without touching the others. */
export function recordCategoryFired(
  state: GlucoseAlertStateV2,
  alertType: string,
  now: number,
  sgv: number,
): void {
  state.categories[alertType] = { lastAlertTime: now, lastSgv: sgv };
}

/** Maintain the in-range clock: starts on the first in-range reading, resets when out. */
export function updateInRangeTracking(
  state: GlucoseAlertStateV2,
  inRange: boolean,
  now: number,
): void {
  if (!inRange) {
    state.inRangeSince = 0;
  } else if (state.inRangeSince === 0) {
    state.inRangeSince = now;
  }
}

/**
 * Whether readings have been in range long enough to clear cooldowns and
 * untilRange snoozes. A single in-range reading is NOT enough — that was the
 * hover bug (state wiped on one dip, full re-alert on the next crossing).
 */
export function sustainedInRange(
  state: GlucoseAlertStateV2,
  now: number,
  sustainMs: number,
): boolean {
  return state.inRangeSince > 0 && now - state.inRangeSince >= sustainMs;
}

// ── Per-device acks ──
// deviceKey → alertType → suppressed-until (ms epoch). An ack quiets exactly one
// device for exactly one alert type; escalation to a more urgent type still
// fires, and other devices are untouched (chosen semantics, 2026-07-24).

export type DeviceAckStore = Record<string, Record<string, number>>;

export function recordDeviceAck(
  store: DeviceAckStore,
  deviceKey: string,
  alertType: string,
  until: number,
): void {
  (store[deviceKey] ??= {})[alertType] = until;
}

export function isDeviceAcked(
  store: DeviceAckStore,
  deviceKey: string,
  alertType: string,
  now: number,
): boolean {
  const until = store[deviceKey]?.[alertType] ?? 0;
  return until > now;
}

/** Drop expired acks (and empty devices). Returns true when anything changed. */
export function pruneExpiredAcks(store: DeviceAckStore, now: number): boolean {
  let changed = false;
  for (const [device, types] of Object.entries(store)) {
    for (const [type, until] of Object.entries(types)) {
      if (until <= now) {
        delete types[type];
        changed = true;
      }
    }
    if (Object.keys(types).length === 0) {
      delete store[device];
      changed = true;
    }
  }
  return changed;
}

// ── Snooze shape ──

export interface SnoozeSnapshot {
  snoozedUntil: number;
  snoozedCategories: string[];
  untilRange: boolean;
}

// ── Advisor snooze coverage ──

/** Is any snooze in force right now? */
export function snoozeActive(snooze: SnoozeSnapshot, now: number): boolean {
  return snooze.untilRange || (snooze.snoozedUntil > 0 && snooze.snoozedUntil > now);
}

/**
 * The glucose-alert category an advisory corresponds to, for snooze purposes.
 *
 * Advisories are keyed on root cause, snoozes on glucose category, so the two
 * need a mapping. Low- and high-side advisories map to their threshold
 * category and escalate with severity, exactly like the glucose alerter — so a
 * snooze on `low` does NOT mask a severe impending low, because that is a
 * different key. Advisories that are not glucose-threshold events at all
 * (failing site, sensor quality, stale data, ketones) have no natural category
 * and are covered only by an explicit `all`.
 */
export function advisorSnoozeCategory(
  rootCause: string,
  severity: string
): string | null {
  const severe = severity === "urgent";
  switch (rootCause) {
    case "impending_low":
    case "rebound_low":
      return severe ? "urgentLow" : "low";
    case "ciq_capped_high":
      return severe || severity === "high" ? "urgentHigh" : "high";
    default:
      return null; // only a blanket "all" covers these
  }
}

/**
 * Should this advisory be silenced by the current snooze?
 *
 * Until 2026-07-28 `/api/advisor/check` ignored snoozes entirely — documented
 * in docs/ALERTS.md §1 as "by design: advisories are distinct clinical events"
 * and simultaneously in §5 as a known gap. It was the one remaining path by
 * which something deliberately silenced could still wake the
 * house at 3am.
 *
 * Honouring it here is safe because the advisory is an EARLY-WARNING layer, not
 * a last line of defence: a low it stays quiet about still trips the CGM's own
 * threshold alarm and the iOS local backstop. Snooze suppresses the
 * PUSH only — the advisory is still evaluated and still recorded to the
 * outcome harvest, mirroring the glucose alerter, where skipping classification
 * while snoozed is what made the server wipe untilRange snoozes a cycle after
 * they were set.
 */
export function advisorSilencedBySnooze(
  rootCause: string,
  severity: string,
  snooze: SnoozeSnapshot,
  now: number
): boolean {
  if (!snoozeActive(snooze, now)) return false;
  const cats = snooze.snoozedCategories;
  if (cats.includes("all")) return true;
  const category = advisorSnoozeCategory(rootCause, severity);
  return category !== null && cats.includes(category);
}
