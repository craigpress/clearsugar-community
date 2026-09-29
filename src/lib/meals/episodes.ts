/**
 * ClearSugar — MealEpisode persistence
 *
 * Section 4c of docs/MEAL_LOGGING_PLAN_2026-09-04.md. `meals/episodes/<yyyy-mm>.json`,
 * one JSON array per month through `local-store`, exactly like `meals/store.ts`
 * (same atomic temp-file + rename, same UTC-derived shard so a read always looks
 * where a write filed the row).
 *
 * The episode is the idempotency unit for feature B. Two keys guard it:
 *   1. `pumpEventId ?? bolusId` — one pump bolus can only ever key one episode.
 *   2. the pairing window — an ACTIVE episode whose [anchor-30min, anchor+90min]
 *      window contains a candidate absorbs it, so the rise trigger and the
 *      (hour-late) pump trigger never both prompt for the same meal (risk 3).
 *
 * The shared daily cap and the rise suppression a "No" reply sets are not
 * per-episode facts, so they live in one small `meals/prompt-state.json` a tick
 * can read and write without touching a shard.
 */

import { loadJSON, saveJSON, listKeys, currentMealChild, isTestMeal } from "./profile-storage";
import { localDateKey } from "@/lib/time";
import type { MealEpisode, PromptState } from "./types";

const SHARD_PREFIX = "meals/episodes/";
export const PROMPT_STATE_KEY = "meals/prompt-state.json";

const MIN = 60_000;

/** Episode time-to-live: an unanswered prompt expires silently (risk 3). */
export const EPISODE_TTL_MIN = 120;

/** Default pairing window around an episode's anchor, in minutes. */
export const PAIR_BEFORE_MIN = 30;
export const PAIR_AFTER_MIN = 90;

/**
 * Statuses that can still absorb a candidate or gain a pump bolus.
 *
 * `answered` is active on purpose: a rise episode answered "ate, did not bolus"
 * stays open until expiry so the ~hourly tconnectsync batch can still reconcile
 * a bolus into it (section 4a). `reconciled`, `expired` and `closed` are final.
 */
export const ACTIVE_STATUSES = new Set(["open", "prompted", "answered"]);

/** Storage key for the shard holding a given instant (UTC month, like store.ts). */
export function episodeShardKey(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${SHARD_PREFIX}${yyyy}-${mm}.json`;
}

/** The `monthsBack` most recent shard keys, newest first. */
function recentShardKeys(nowMs: number, monthsBack: number): string[] {
  const months = Math.max(1, Math.floor(monthsBack));
  const keys: string[] = [];
  const cursor = new Date(
    Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), 1)
  );
  for (let i = 0; i < months; i++) {
    keys.push(episodeShardKey(cursor.getTime()));
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  return keys;
}

async function loadShard(key: string): Promise<MealEpisode[]> {
  const rows = await loadJSON<MealEpisode[]>(key, []);
  return Array.isArray(rows) ? rows : [];
}

/** Every shard that exists on disk, newest month first. */
async function allShardKeys(): Promise<string[]> {
  const keys = await listKeys(SHARD_PREFIX);
  return keys.sort().reverse();
}

/**
 * The instant an episode is anchored on: whichever fact opened it.
 *
 * A pump episode is anchored on the bolus, a rise episode on the detected rise,
 * an "eating now" episode on the tap. Falls back to `openedAt` so an episode is
 * never anchorless (an episode written before its anchor field existed would
 * otherwise silently pair against epoch 0).
 */
export function episodeAnchor(ep: MealEpisode): number {
  const candidates = [ep.eatingAt, ep.bolusAt, ep.riseDetectedAt];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return ep.openedAt;
}

/** The idempotency key of the pump bolus an episode carries, if any. */
export function episodePumpKey(ep: MealEpisode): string | null {
  return ep.pumpEventId ?? ep.bolusId ?? null;
}

/** Can this episode still absorb a candidate or gain a pump bolus? */
export function isActive(ep: MealEpisode): boolean {
  return ACTIVE_STATUSES.has(ep.status);
}

/**
 * Does `ep`'s pairing window contain `atMs`?
 *
 * One window definition serves both jobs the contract describes: dedup ("an open
 * episode within -30/+90 min of a candidate absorbs it") and reconciliation
 * ("open rise/eating episodes pair with a meal bolus in -30/+90 min around their
 * anchor"). The window is asymmetric because a bolus normally lands shortly
 * before eating starts but the CGM only shows the rise well after it.
 */
export function windowContains(
  ep: MealEpisode,
  atMs: number,
  beforeMin = PAIR_BEFORE_MIN,
  afterMin = PAIR_AFTER_MIN
): boolean {
  const anchor = episodeAnchor(ep);
  return atMs >= anchor - beforeMin * MIN && atMs <= anchor + afterMin * MIN;
}

/** Append one episode to its month's shard. */
export async function appendEpisode(ep: MealEpisode): Promise<MealEpisode> {
  const key = episodeShardKey(ep.openedAt);
  const rows = await loadShard(key);
  rows.push(ep);
  await saveJSON(key, rows);
  return ep;
}

/**
 * Replace an episode in place, matched by id. Returns the stored episode, or
 * null when no shard held that id (a caller must not silently create one:
 * an update that lands nowhere would lose a reply).
 */
export async function updateEpisode(ep: MealEpisode): Promise<MealEpisode | null> {
  // The openedAt-derived shard first (the overwhelmingly common case), then any
  // other shard, so an episode whose openedAt was edited is still found.
  const primary = episodeShardKey(ep.openedAt);
  const keys = [primary, ...(await allShardKeys()).filter((k) => k !== primary)];
  for (const key of keys) {
    const rows = await loadShard(key);
    const idx = rows.findIndex((r) => r?.id === ep.id);
    if (idx >= 0) {
      rows[idx] = ep;
      await saveJSON(key, rows);
      return ep;
    }
  }
  return null;
}

/** Find an episode by its own id, scanning every shard on disk (newest first). */
export async function findEpisodeById(id: string): Promise<MealEpisode | null> {
  if (!id) return null;
  for (const key of await allShardKeys()) {
    const rows = await loadShard(key);
    const hit = rows.find((r) => r?.id === id);
    if (hit) return hit;
  }
  return null;
}

/**
 * Find the episode keyed on a pump bolus — `pumpEventId ?? bolusId`.
 *
 * Deliberately status-blind: "one prompt per bolus, ever" means an expired or
 * closed episode still blocks a second prompt for the same pump event.
 */
export async function findByPumpKey(
  key: string,
  monthsBack = 2,
  nowMs: number = Date.now()
): Promise<MealEpisode | null> {
  if (!key) return null;
  for (const shard of recentShardKeys(nowMs, monthsBack)) {
    const rows = await loadShard(shard);
    const hit = rows.find((r) => episodePumpKey(r) === key);
    if (hit) return hit;
  }
  return null;
}

/**
 * The active episode that would absorb an event at `anchorMs`, newest first.
 *
 * `before`/`after` are minutes and describe the episode's own window, not the
 * candidate's: an episode absorbs `anchorMs` when it falls in
 * [episodeAnchor - before, episodeAnchor + after].
 */
export async function findOpenEpisodeNear(
  anchorMs: number,
  before = PAIR_BEFORE_MIN,
  after = PAIR_AFTER_MIN,
  nowMs: number = Date.now()
): Promise<MealEpisode | null> {
  if (!Number.isFinite(anchorMs)) return null;
  // Two shards is always enough: the window is at most 2 hours wide, so an
  // episode that could absorb `anchorMs` was opened this month or last.
  const candidates: MealEpisode[] = [];
  for (const shard of recentShardKeys(Math.max(nowMs, anchorMs), 2)) {
    for (const ep of await loadShard(shard)) {
      if (ep && isActive(ep) && windowContains(ep, anchorMs, before, after)) {
        candidates.push(ep);
      }
    }
  }
  candidates.sort((a, b) => episodeAnchor(b) - episodeAnchor(a));
  return candidates[0] ?? null;
}

/** Active episodes opened within the last `withinMin` minutes, newest first. */
export async function listActiveEpisodes(
  nowMs: number = Date.now(),
  withinMin = 24 * 60
): Promise<MealEpisode[]> {
  const since = nowMs - withinMin * MIN;
  const out: MealEpisode[] = [];
  for (const shard of recentShardKeys(nowMs, 2)) {
    for (const ep of await loadShard(shard)) {
      if (ep && isActive(ep) && ep.openedAt >= since) out.push(ep);
    }
  }
  out.sort((a, b) => b.openedAt - a.openedAt);
  return out;
}

/** Find an "eating now" episode by its device-minted clientId. */
export async function findEpisodeByClientId(
  clientId: string,
  monthsBack = 2,
  nowMs: number = Date.now()
): Promise<MealEpisode | null> {
  if (!clientId) return null;
  for (const shard of recentShardKeys(nowMs, monthsBack)) {
    const rows = await loadShard(shard);
    const hit = rows.find((r) => r?.clientId === clientId);
    if (hit) return hit;
  }
  return null;
}

/** Episodes opened at or after `sinceMs`, newest first. */
export async function listEpisodes(
  sinceMs: number,
  nowMs: number = Date.now()
): Promise<MealEpisode[]> {
  const spanMonths = Math.max(
    2,
    Math.ceil((nowMs - sinceMs) / (28 * 24 * 60 * MIN)) + 1
  );
  const out: MealEpisode[] = [];
  for (const shard of recentShardKeys(nowMs, spanMonths)) {
    for (const ep of await loadShard(shard)) {
      if (ep && typeof ep.openedAt === "number" && ep.openedAt >= sinceMs) out.push(ep);
    }
  }
  out.sort((a, b) => b.openedAt - a.openedAt);
  return out;
}

// ── Cross-episode prompt state ────────────────────────────────────────────────

/** Patient-local date key the daily cap is counted against. */
export function promptDayKey(ms: number): string {
  return localDateKey(ms);
}

export async function loadPromptState(nowMs: number = Date.now()): Promise<PromptState> {
  const today = promptDayKey(nowMs);
  const raw = await loadJSON<PromptState>(PROMPT_STATE_KEY, {
    dayKey: today,
    promptCount: 0,
  });
  const dayKey = typeof raw?.dayKey === "string" ? raw.dayKey : today;
  const stale = dayKey !== today;
  return {
    // A stale counter is reported as zero rather than rewritten on read, so a
    // dry run never mutates state.
    dayKey: stale ? today : dayKey,
    shadowPromptCount: stale || typeof raw?.shadowPromptCount !== "number" ? 0 : raw.shadowPromptCount,
    promptCount: stale || typeof raw?.promptCount !== "number" ? 0 : raw.promptCount,
    riseSuppressedUntil:
      typeof raw?.riseSuppressedUntil === "number" ? raw.riseSuppressedUntil : undefined,
    photoPruneDayKey:
      typeof raw?.photoPruneDayKey === "string" ? raw.photoPruneDayKey : undefined,
    photoPruneDeleted:
      typeof raw?.photoPruneDeleted === "number" ? raw.photoPruneDeleted : undefined,
  };
}

export async function savePromptState(state: PromptState): Promise<void> {
  await saveJSON(PROMPT_STATE_KEY, state);
}

/** Prompts already delivered on `dayKey` (0 for any other day). */
export async function dailyPromptCount(dayKey: string): Promise<number> {
  const raw = await loadJSON<PromptState>(PROMPT_STATE_KEY, {
    dayKey,
    promptCount: 0,
  });
  if (raw?.dayKey !== dayKey) return 0;
  return typeof raw.promptCount === "number" ? raw.promptCount : 0;
}

/** Is the glucose-rise trigger inside a "No"-reply suppression window? */
export function riseSuppressed(state: PromptState, nowMs: number): boolean {
  return typeof state.riseSuppressedUntil === "number" && state.riseSuppressedUntil > nowMs;
}

/** A fresh episode with the fields every trigger shares. */
export function newEpisode(
  input: Pick<MealEpisode, "id" | "trigger" | "shadow"> & Partial<MealEpisode>,
  nowMs: number
): MealEpisode {
  return {
    status: "open",
    schemaVersion: 1,
    childId: currentMealChild(),
    isTest: isTestMeal(),
    promptCount: 0,
    openedAt: nowMs,
    expiresAt: nowMs + EPISODE_TTL_MIN * MIN,
    ...input,
  };
}
