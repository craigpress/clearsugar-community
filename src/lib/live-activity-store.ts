import { loadJSON, saveJSON, deleteJSON } from "@/lib/local-store";

const STORE_KEY = "push/live-activities.json";
const LEGACY_KEY = "push/live-activity-tokens.json";

export interface LiveActivityInstall {
  device: string;
  updateToken?: string;
  startToken?: string;
  /**
   * ms epoch the current `updateToken` was first seen — i.e. when this activity
   * began. Persisted (not in-process) so it survives a restart, otherwise every
   * deploy would hand a long-dead activity a fresh liveness window.
   */
  activitySince?: number;
  /**
   * ms epoch the app reported this activity ended/was dismissed. Cleared when a
   * new activity starts. The only positive signal that a card is gone — APNs
   * keeps returning 200 on a dead activity's update token.
   */
  endedAt?: number;
  /**
   * ms epoch of the last push-to-start we SENT for this install. Persisted (the
   * old in-process map reset on restart, which silently re-armed every install
   * on deploy) and deliberately separate from `activitySince`: sending a start
   * is an attempt, not evidence that an activity exists.
   */
  lastStartAt?: number;
  /**
   * Consecutive starts sent that no new update token ever confirmed. Drives the
   * retry backoff and is cleared the moment a new update token registers.
   */
  startAttempts?: number;
  /**
   * ms epoch this install last went fully token-less (both tokens pruned).
   * We KEEP the record (device name, prefs linkage, activitySince) so a device
   * is never fully forgotten and can re-register into the same install; this
   * stamp just marks how long it's been gone for an optional future GC. Cleared
   * the moment any token returns.
   */
  tokensLostAt?: number;
}
export type LiveActivityStore = Record<string, LiveActivityInstall>; // key = installId

export async function loadInstalls(): Promise<LiveActivityStore> {
  const store = await loadJSON<LiveActivityStore>(STORE_KEY, {});
  if (Object.keys(store).length > 0) return store;
  // One-time migration: legacy { token: device } → install records keyed by token.
  const legacy = await loadJSON<Record<string, string>>(LEGACY_KEY, {});
  if (Object.keys(legacy).length === 0) return store;
  const migrated: LiveActivityStore = {};
  for (const [token, device] of Object.entries(legacy)) {
    migrated[`tok:${token}`] = { device, updateToken: token };
  }
  await saveInstalls(migrated);
  // Delete the legacy file so a later-emptied store (e.g. all tokens pruned) does
  // NOT re-migrate and resurrect dead tokens, defeating auto-prune.
  await deleteJSON(LEGACY_KEY);
  return migrated;
}

export async function saveInstalls(store: LiveActivityStore): Promise<void> {
  await saveJSON(STORE_KEY, store);
}

/**
 * Upsert a token onto an install. When `installId` is omitted (build-7 phones
 * that don't send one), synthesize a stable key from the token. Returns the
 * installId used.
 */
export function upsertToken(
  store: LiveActivityStore,
  args: { installId?: string; device: string; kind: "update" | "start"; token: string; now?: number }
): string {
  const id = args.installId?.trim() || `tok:${args.token}`;
  const rec = store[id] ?? { device: args.device };
  rec.device = args.device;
  if (args.kind === "update") {
    // A *changed* update token means the app minted a new activity. Restamp the
    // liveness clock and drop any end-ack, which referred to the previous one.
    // This is also the ONLY confirmation that a push-to-start actually produced
    // a card, so it is where the start-attempt backoff resets.
    if (rec.updateToken !== args.token) {
      rec.activitySince = args.now ?? Date.now();
      delete rec.endedAt;
      delete rec.startAttempts;
      delete rec.lastStartAt;
    }
    rec.updateToken = args.token;
  } else {
    rec.startToken = args.token;
  }
  // A registering device is alive — drop any prior token-less marker.
  delete rec.tokensLostAt;
  store[id] = rec;
  return id;
}

/**
 * Record that the app says this install's activity has ended. Returns false when
 * the install is unknown (nothing to mark).
 */
export function markActivityEnded(
  store: LiveActivityStore,
  installId: string,
  now: number = Date.now()
): boolean {
  const rec = store[installId];
  if (!rec) return false;
  rec.endedAt = now;
  return true;
}

/**
 * Record that we just sent a push-to-start for this install.
 *
 * Deliberately does NOT touch `activitySince`. The route used to restamp it here,
 * which reset the very liveness clock the retry depends on: a start that produced
 * no card deferred the next attempt by another full `maxAssumedLifetimeMs`, and
 * did so again on each failure, so the retry never converged. On 2026-07-22 that
 * left a dead card unrecoverable — three starts over eight hours, each one
 * pushing the next attempt four more hours out.
 *
 * Returns false when the install is unknown (nothing to record).
 */
export function recordStartAttempt(
  store: LiveActivityStore,
  installId: string,
  now: number = Date.now(),
): boolean {
  const rec = store[installId];
  if (!rec) return false;
  rec.lastStartAt = now;
  rec.startAttempts = (rec.startAttempts ?? 0) + 1;
  return true;
}

/**
 * Remove a token APNs pruned as permanently dead (BadDeviceToken/Unregistered).
 *
 * Non-destructive: when an install is left with no tokens we KEEP the record
 * (device name, prefs linkage, activitySince) rather than deleting it, so a
 * device is never fully forgotten and can re-register into the same install —
 * the app minting a fresh token via upsertToken restores it in place. We only
 * stamp `tokensLostAt` for observability / an optional future GC of installs
 * that have been gone a long time. update vs start tokens are still pruned
 * independently (a dead update token never removes the push-to-start token).
 */
export function removeToken(store: LiveActivityStore, token: string, now: number = Date.now()): void {
  for (const rec of Object.values(store)) {
    if (rec.updateToken === token) delete rec.updateToken;
    if (rec.startToken === token) delete rec.startToken;
    if (!rec.updateToken && !rec.startToken) {
      rec.tokensLostAt = rec.tokensLostAt ?? now;
    } else {
      delete rec.tokensLostAt;
    }
  }
}
