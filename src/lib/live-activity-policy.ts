// Pure decision helpers for the Live Activity push pipeline (push/send).

/** A CGM reading is "new" (worth pushing) only when its timestamp advances. */
export function isNewReading(latestDate: number, lastPushedDate: number | null): boolean {
  return lastPushedDate === null || latestDate > lastPushedDate;
}

export interface StartDecisionInput {
  got200ThisCycle: boolean; // the install's update token returned 200 this cycle
  lastStartAt: number;      // ms epoch of the last start we sent (0 = never)
  /**
   * @deprecated No longer consulted. It backed the old "outstanding start" guard
   * (`lastStartAt > lastUpdateAt`), which deadlocked any install without an
   * update token — that value never advances past 0, so a single attempt froze
   * the install for good. Retained only so existing callers still typecheck.
   */
  lastUpdateAt?: number;
  now: number;
  cooldownMs: number;
  /**
   * ms epoch the APP told us its activity ended/was dismissed (0 = never).
   * Authoritative — it is the only *positive* signal that the card is gone.
   */
  endedAckAt?: number;
  /**
   * ms epoch we first saw the current activity's update token (0 = unknown).
   * A token is "current" until the app mints a new one, i.e. a new activity.
   */
  activitySince?: number;
  /**
   * How long a 200 is allowed to stand as proof of liveness. Past this age the
   * 200 is treated as meaningless. Undefined = trust a 200 forever (old behaviour).
   */
  maxAssumedLifetimeMs?: number;
  /**
   * Consecutive starts we have sent that no new update token ever confirmed
   * (0 = none outstanding). Paces the retry: each unconfirmed attempt doubles
   * the wait, so a wedged install neither spams nor gives up.
   */
  startAttempts?: number;
  /** Upper bound on the backoff between retries. */
  maxBackoffMs?: number;
}

/** Default backoff cap: retry a wedged install at least this often. */
export const DEFAULT_MAX_BACKOFF_MS = 4 * 60 * 60_000;

/**
 * How long to wait before the next start, given how many consecutive attempts
 * have gone unconfirmed. 0/1 attempts → one cooldown, then 2×, 4×, … to the cap.
 */
export function startRetryDelayMs(
  attempts: number,
  cooldownMs: number,
  maxBackoffMs: number = DEFAULT_MAX_BACKOFF_MS,
): number {
  const doublings = Math.max(0, (attempts || 0) - 1);
  // Cap the exponent before shifting so a large attempt count can't overflow to Infinity.
  const factor = 2 ** Math.min(doublings, 30);
  return Math.min(cooldownMs * factor, maxBackoffMs);
}

/**
 * Whether to send a push-to-start now.
 *
 * A 200 from APNs on the update token does NOT prove the activity is alive:
 * APNs keeps accepting updates for an activity that already ended on the device.
 * Trusting it unconditionally is what let an expired card go un-resurrected for
 * all 91 overnight cycles on 2026-07-21 — `started` was 0 every single time.
 *
 * So a 200 suppresses the start only until something contradicts it:
 *  - `endedAckAt` — the app said the activity ended (authoritative), or
 *  - `activitySince` older than `maxAssumedLifetimeMs` — the 200 has been
 *    standing so long it can no longer be believed (server-only safety net,
 *    works without an app release).
 *
 * The backoff applies in ALL cases, including an ack, so no escape hatch can
 * produce a burst of starts.
 *
 * Three deadlocks were found in production on 2026-07-22, all of which stopped a
 * dead card from ever being resurrected. The guards below are shaped by them:
 *
 *  1. A start attempt is NOT evidence of an activity, so it must not touch the
 *     liveness clock (see `recordStartAttempt`). Retry pacing lives here, in the
 *     attempt counter, not in `activitySince`.
 *  2. There is no "outstanding start" guard. The old
 *     `lastStartAt > lastUpdateAt` check could never clear for an install with
 *     no update token — `lastUpdateAt` stays 0 forever — so one attempt froze it
 *     permanently. The backoff is the only rate guard now, and it cannot wedge.
 *  3. An end-ack is actionable while it is *set*, not only when it is newer than
 *     our last attempt. `endedAt` is cleared exactly when a new update token
 *     registers, so a still-present ack means the card is still known dead.
 */
export function decideStart(i: StartDecisionInput): boolean {
  // Sole rate guard — bounds every path below, including both escape hatches.
  const retryMs = startRetryDelayMs(i.startAttempts ?? 0, i.cooldownMs, i.maxBackoffMs);
  if (i.now - i.lastStartAt < retryMs) return false;

  if (!i.got200ThisCycle) return true; // no liveness claim to overcome

  // A 200 was claimed. Only proceed on positive evidence that it is stale.
  if ((i.endedAckAt ?? 0) > 0) return true; // app says the card is gone

  const since = i.activitySince ?? 0;
  const maxLife = i.maxAssumedLifetimeMs;
  const livenessExpired = since > 0 && maxLife !== undefined && i.now - since >= maxLife;
  if (livenessExpired) return true;

  return false;
}

export interface StaleAlertInput {
  dataAgeMs: number;        // now − newest CGM reading date
  staleThresholdMs: number; // age past which data is considered stopped
  lastStaleAlertAt: number; // ms epoch of the last stale alert we sent (0 = never)
  now: number;
  cooldownMs: number;       // min gap between repeat stale alerts during one outage
  isSnoozed: boolean;       // stale (or "all") category snoozed AND snooze active
}

/**
 * Whether to send a server-authoritative "data stopped" alert now. The server
 * is authoritative for CGM staleness because it always knows the true reading
 * age; the iOS watchdog is only a backstop for the server being unreachable.
 * Fires only when:
 *  - the newest reading is older than the stale threshold, AND
 *  - stale alerts aren't snoozed, AND
 *  - the re-alert cooldown since our last stale alert has elapsed.
 * The caller resets lastStaleAlertAt to 0 once data is fresh again, so a fresh
 * outage alerts promptly instead of waiting out the cooldown.
 */
export function decideStaleAlert(i: StaleAlertInput): boolean {
  if (i.dataAgeMs <= i.staleThresholdMs) return false;
  if (i.isSnoozed) return false;
  if (i.now - i.lastStaleAlertAt < i.cooldownMs) return false;
  return true;
}
