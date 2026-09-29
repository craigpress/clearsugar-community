/**
 * ClearSugar — MealLog persistence
 *
 * `meals/<yyyy-mm>.json`, one JSON array of `MealLog` per month, through
 * `local-store` so every write gets the same temp-file + rename atomicity as
 * `advisor/feedback.json`.
 *
 * Monthly shards keep the file a caller must rewrite bounded (a few dozen rows)
 * while still letting a read of "the last 24 hours" touch at most two files.
 *
 * The shard a row lands in is derived from `eatenAt` in **UTC**, not local time.
 * That makes sharding deterministic regardless of the server's timezone, and
 * every scan derives its shard list with the same function, so a meal is never
 * filed where a read would not look for it. The month boundary has no meaning
 * beyond "which file"; all filtering is done on the timestamps themselves.
 */

import { loadJSON, saveJSON, listKeys, loadBinary, withStoreLock } from "./profile-storage";
import type { MealLog } from "./types";

const SHARD_PREFIX = "meals/";

/**
 * Timestamps up to this far in the future are accepted by the API (a device
 * clock a few minutes ahead), so a read whose window ends "now" must also look
 * at the next month's shard when now is within this slack of a month boundary.
 */
const FUTURE_SLACK_MS = 6 * 60 * 1000;

/** Storage key for the shard holding a given instant. */
export function shardKey(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${SHARD_PREFIX}${yyyy}-${mm}.json`;
}

/** Shard keys covering [startMs, endMs], oldest first. */
function shardKeysBetween(startMs: number, endMs: number): string[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return [];
  }
  const keys: string[] = [];
  const cursor = new Date(
    Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth(), 1)
  );
  const last = shardKey(endMs);
  // Bounded so a nonsense window (e.g. epoch 0) cannot spin: 25 years of shards.
  for (let i = 0; i < 300; i++) {
    const key = shardKey(cursor.getTime());
    keys.push(key);
    if (key === last) return keys;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}

/** The `monthsBack` most recent shard keys, ending with the current month. */
function recentShardKeys(nowMs: number, monthsBack: number): string[] {
  const months = Math.max(1, Math.floor(monthsBack));
  const keys: string[] = [];
  const cursor = new Date(
    Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), 1)
  );
  for (let i = 0; i < months; i++) {
    keys.push(shardKey(cursor.getTime()));
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  return keys;
}

async function loadShard(key: string): Promise<MealLog[]> {
  const rows = await loadJSON<MealLog[]>(key, []);
  return Array.isArray(rows) ? rows : [];
}

/** Every shard that exists on disk, newest month first. */
async function allShardKeys(): Promise<string[]> {
  const keys = await listKeys(SHARD_PREFIX);
  return keys.sort().reverse();
}

/** Keep the first accepted payload across failures and process restarts. */
export async function reserveMeal(meal: MealLog): Promise<MealLog> {
  if (!/^[a-f0-9]{24}$/.test(meal.nightscoutId ?? "")) throw new Error("Invalid meal operation ID");
  const key = 'meal-operations/' + meal.nightscoutId + '.json';
  return withStoreLock(key, async () => {
    const raw = await loadBinary(key);
    if (raw) {
      const existing: MealLog = JSON.parse(raw.toString('utf8'));
      if (existing.clientId !== meal.clientId || existing.enteredBySub !== meal.enteredBySub || existing.nightscoutId !== meal.nightscoutId) throw new Error('Invalid meal reservation');
      return existing;
    }
    await saveJSON(key, meal);
    return meal;
  });
}

export async function appendMeal(meal: MealLog): Promise<MealLog> {
  const key = shardKey(meal.eatenAt);
  return withStoreLock(key, async () => {
    const rows = await loadShard(key);
    const existing = rows.find(row => row.id === meal.id || (meal.clientId && row.clientId === meal.clientId && row.enteredBySub === meal.enteredBySub));
    if (existing) return existing;
    rows.push(meal);
    await saveJSON(key, rows);
    return meal;
  });
}

/**
 * Find a meal by the device-minted idempotency key.
 *
 * Scans the `monthsBack` most recent shards (default: this month and last),
 * which is far longer than any plausible client retry window and keeps the
 * lookup off the full history.
 */
export async function findMealByClientId(
  clientId: string,
  monthsBack = 2,
  nowMs: number = Date.now()
): Promise<MealLog | null> {
  if (!clientId) return null;
  for (const key of recentShardKeys(nowMs, monthsBack)) {
    const rows = await loadShard(key);
    const hit = rows.find((m) => m.clientId === clientId);
    if (hit) return hit;
  }
  return null;
}

/** Find a meal by its own id, scanning every shard on disk (newest first). */
export async function findMealById(id: string): Promise<MealLog | null> {
  if (!id) return null;
  for (const key of await allShardKeys()) {
    const rows = await loadShard(key);
    const hit = rows.find((m) => m.id === id);
    if (hit) return hit;
  }
  return null;
}

/**
 * Meals eaten at or after `sinceMs`, newest first.
 *
 * Only reads the shards that can contain the window, plus the next month's when
 * `now` sits within the future-timestamp slack of a month boundary.
 */
export async function listMeals(
  sinceMs: number,
  nowMs: number = Date.now()
): Promise<MealLog[]> {
  const keys = shardKeysBetween(sinceMs, nowMs + FUTURE_SLACK_MS);
  const out: MealLog[] = [];
  for (const key of keys) {
    const rows = await loadShard(key);
    for (const m of rows) {
      if (typeof m?.eatenAt === "number" && m.eatenAt >= sinceMs) out.push(m);
    }
  }
  out.sort((a, b) => b.eatenAt - a.eatenAt);
  return out;
}

/** Remove a meal by id. Returns true when a row was actually removed. */
export async function removeMeal(id: string): Promise<boolean> {
  if (!id) return false;
  for (const key of await allShardKeys()) {
    const removed = await withStoreLock(key, async () => {
      const rows = await loadShard(key);
      const kept = rows.filter(m => m.id !== id);
      if (kept.length === rows.length) return false;
      await saveJSON(key, kept);
      return true;
    });
    if (removed) return true;
  }
  return false;
}
