import { describe, it, expect } from "vitest";
import { isNewReading, decideStart, decideStaleAlert } from "../live-activity-policy";

describe("isNewReading", () => {
  it("is true on first ever push (no prior date)", () => {
    expect(isNewReading(1000, null)).toBe(true);
  });
  it("is true when the reading date advances", () => {
    expect(isNewReading(2000, 1000)).toBe(true);
  });
  it("is false when the date is unchanged (redundant timer fire)", () => {
    expect(isNewReading(1000, 1000)).toBe(false);
  });
  it("is false for an out-of-order/duplicate older reading", () => {
    expect(isNewReading(900, 1000)).toBe(false);
  });
});

const COOLDOWN = 15 * 60_000;
describe("decideStart", () => {
  const base = { now: 1_000_000, cooldownMs: COOLDOWN };

  it("does not start when the install got a 200 update this cycle (activity live)", () => {
    expect(decideStart({ ...base, got200ThisCycle: true, lastStartAt: 0, lastUpdateAt: base.now - 1000 })).toBe(false);
  });
  it("starts when no update this cycle, cooldown elapsed, nothing outstanding", () => {
    expect(decideStart({ ...base, got200ThisCycle: false, lastStartAt: 0, lastUpdateAt: 0 })).toBe(true);
  });
  it("does not start again within the cooldown window", () => {
    expect(decideStart({ ...base, got200ThisCycle: false, lastStartAt: base.now - 60_000, lastUpdateAt: 0 })).toBe(false);
  });
  // CHANGED 2026-07-22. This used to assert that an unconfirmed start blocks all
  // further starts (`lastStartAt > lastUpdateAt`). That guard was the deadlock:
  // an install with no update token has `lastUpdateAt === 0` forever, so its
  // first attempt froze it permanently — Leah's install went 12+ h with no
  // retry. An unconfirmed start now defers the next one via backoff instead of
  // cancelling it outright; `startAttempts` carries that state.
  it("retries an unconfirmed start once its backoff has elapsed", () => {
    expect(decideStart({
      ...base, got200ThisCycle: false,
      lastStartAt: base.now - COOLDOWN - 1, lastUpdateAt: base.now - COOLDOWN - 2,
      startAttempts: 1,
    })).toBe(true);
  });
  it("defers an unconfirmed start until its backoff has elapsed", () => {
    expect(decideStart({
      ...base, got200ThisCycle: false,
      lastStartAt: base.now - COOLDOWN - 1, lastUpdateAt: base.now - COOLDOWN - 2,
      startAttempts: 2, // 2 unconfirmed attempts → 2× cooldown, not yet due
    })).toBe(false);
  });
  it("starts again after an update confirmed liveness then it went stale", () => {
    expect(decideStart({ ...base, got200ThisCycle: false, lastStartAt: base.now - COOLDOWN - 10, lastUpdateAt: base.now - COOLDOWN - 5 })).toBe(true);
  });

  // ── A 200 does not prove the activity is alive ──────────────────────────────
  // APNs keeps returning 200 on an update token whose activity has already ended
  // on the device. On 2026-07-21 that made this function return false on all 91
  // overnight cycles, so an expired card was never resurrected. Two independent
  // escape hatches now let a start through despite a 200.

  describe("app-reported end (authoritative)", () => {
    it("starts despite a 200 when the app acked the activity ended after our last start", () => {
      expect(decideStart({
        ...base, got200ThisCycle: true,
        lastStartAt: base.now - COOLDOWN - 10, lastUpdateAt: base.now - COOLDOWN - 5,
        endedAckAt: base.now - 1000,
      })).toBe(true);
    });
    // CHANGED 2026-07-22. This used to assert that an ack older than our last
    // start is spent ("already acted on"). That made the ack single-use: the
    // start it triggered often produced no card, nothing cleared `endedAt`, and
    // the ack could never fire again — the authoritative signal died exactly
    // when it was most needed. An ack is cleared by `upsertToken` the moment a
    // new update token registers, so while it is still SET the card is still
    // known dead and remains actionable; backoff alone paces the retries.
    it("keeps acting on an ack that is still set, even after we have started once", () => {
      expect(decideStart({
        ...base, got200ThisCycle: true,
        lastStartAt: base.now - COOLDOWN, lastUpdateAt: base.now - COOLDOWN - 5,
        endedAckAt: base.now - COOLDOWN - 1,
        startAttempts: 1,
      })).toBe(true);
    });
    it("stops acting on an ack once a new activity cleared it", () => {
      expect(decideStart({
        ...base, got200ThisCycle: true,
        lastStartAt: base.now - COOLDOWN, lastUpdateAt: base.now - COOLDOWN - 5,
        endedAckAt: 0, // cleared by upsertToken on a new update token
        activitySince: base.now - 1000, maxAssumedLifetimeMs: 4 * 60 * 60_000,
        startAttempts: 1,
      })).toBe(false);
    });
    it("still respects the cooldown even with a fresh ack (no start storms)", () => {
      expect(decideStart({
        ...base, got200ThisCycle: true,
        lastStartAt: base.now - 1000, lastUpdateAt: base.now - 2000,
        endedAckAt: base.now - 500,
      })).toBe(false);
    });
  });

  describe("liveness timeout (server-only stopgap, no app release needed)", () => {
    const LIFETIME = 4 * 60 * 60_000;
    // `base.now` (1e6) is smaller than LIFETIME, so subtracting it would yield a
    // NEGATIVE activitySince — impossible for a real epoch and correctly treated
    // as "unknown" by the policy. Use a clock large enough to stay positive.
    const late = { now: 10 * LIFETIME, cooldownMs: COOLDOWN };

    it("stops trusting a 200 once the activity outlives maxAssumedLifetimeMs", () => {
      expect(decideStart({
        ...late, got200ThisCycle: true,
        lastStartAt: late.now - COOLDOWN - 10, lastUpdateAt: late.now - COOLDOWN - 5,
        activitySince: late.now - LIFETIME, maxAssumedLifetimeMs: LIFETIME,
      })).toBe(true);
    });
    it("keeps trusting a 200 while the activity is younger than the limit", () => {
      expect(decideStart({
        ...late, got200ThisCycle: true,
        lastStartAt: 0, lastUpdateAt: late.now - 1000,
        activitySince: late.now - 60_000, maxAssumedLifetimeMs: LIFETIME,
      })).toBe(false);
    });
    it("trusts a 200 indefinitely when no lifetime limit is configured (old behaviour)", () => {
      expect(decideStart({
        ...late, got200ThisCycle: true,
        lastStartAt: 0, lastUpdateAt: late.now - 1000,
        activitySince: late.now - 2 * LIFETIME,
      })).toBe(false);
    });
    it("treats an unknown activity age (0) as no evidence, so the 200 still stands", () => {
      expect(decideStart({
        ...late, got200ThisCycle: true,
        lastStartAt: 0, lastUpdateAt: late.now - 1000,
        activitySince: 0, maxAssumedLifetimeMs: LIFETIME,
      })).toBe(false);
    });
  });

  it("preserves the original contract: a 200 with no ack and no timeout blocks the start", () => {
    expect(decideStart({
      ...base, got200ThisCycle: true,
      lastStartAt: base.now - COOLDOWN - 10, lastUpdateAt: base.now - COOLDOWN - 5,
      endedAckAt: 0, activitySince: base.now - 1000, maxAssumedLifetimeMs: 4 * 60 * 60_000,
    })).toBe(false);
  });
});

const STALE_MS = 20 * 60_000;
const STALE_COOLDOWN = 30 * 60_000;
describe("decideStaleAlert", () => {
  const base = { staleThresholdMs: STALE_MS, cooldownMs: STALE_COOLDOWN, now: 10_000_000, isSnoozed: false };

  it("does not alert when data is fresh (within threshold)", () => {
    expect(decideStaleAlert({ ...base, dataAgeMs: 5 * 60_000, lastStaleAlertAt: 0 })).toBe(false);
  });
  it("does not alert exactly at the threshold (boundary is fresh)", () => {
    expect(decideStaleAlert({ ...base, dataAgeMs: STALE_MS, lastStaleAlertAt: 0 })).toBe(false);
  });
  it("alerts on first detection once past the threshold", () => {
    expect(decideStaleAlert({ ...base, dataAgeMs: STALE_MS + 1, lastStaleAlertAt: 0 })).toBe(true);
  });
  it("does not re-alert within the cooldown window", () => {
    expect(decideStaleAlert({ ...base, dataAgeMs: 40 * 60_000, lastStaleAlertAt: base.now - 60_000 })).toBe(false);
  });
  it("re-alerts once the cooldown has elapsed during a prolonged outage", () => {
    expect(decideStaleAlert({ ...base, dataAgeMs: 90 * 60_000, lastStaleAlertAt: base.now - STALE_COOLDOWN - 1 })).toBe(true);
  });
  it("does not alert while snoozed, even when stale past cooldown", () => {
    expect(decideStaleAlert({ ...base, dataAgeMs: 90 * 60_000, lastStaleAlertAt: 0, isSnoozed: true })).toBe(false);
  });
});

// Regression coverage for persisted start retries and ended-activity recovery.

const LIFETIME = 4 * 60 * 60_000;

describe("decideStart — deadlock regressions (2026-07-22)", () => {
  const now = 100 * LIFETIME; // large clock so `now - X` stays a plausible epoch

  it("retries a failed start on the cooldown, not a full lifetime later", () => {
    // BUG 1: the route restamped `activitySince = startNow` when a start was
    // *sent*, so a start that never produced a card pushed the next liveness
    // timeout out another 4h — and did it again on every failed attempt, so the
    // retry never converged. A start attempt is not evidence of an activity, so
    // the liveness clock must not move; the attempt counter paces the retry.
    expect(decideStart({
      now, cooldownMs: COOLDOWN, got200ThisCycle: true,
      lastStartAt: now - COOLDOWN - 1,
      lastUpdateAt: now, // the dead token still 200s every cycle
      activitySince: now - 2 * LIFETIME, // long expired, never confirmed
      maxAssumedLifetimeMs: LIFETIME,
      startAttempts: 1,
    })).toBe(true);
  });

  it("starts for an install that has a start token but never any update token", () => {
    // BUG 2: `startOutstanding = lastStartAt > lastUpdateAt` could never clear
    // for an install with no update token — `lastUpdateAt` stays 0 forever — so
    // after one attempt it froze until the service restarted. Leah's install
    // (70d8e709) went 12+ hours with no attempt this way.
    expect(decideStart({
      now, cooldownMs: COOLDOWN, got200ThisCycle: false,
      lastStartAt: now - COOLDOWN - 1,
      lastUpdateAt: 0,
      startAttempts: 1,
    })).toBe(true);
  });

  it("keeps acting on an end-ack that is older than the last start attempt", () => {
    // BUG 3: `endedAckAt > lastStartAt` made the ack single-use. `endedAt` is
    // cleared only when a NEW update token registers, so while it is still set
    // the card is known dead — regardless of how many starts we have since tried.
    expect(decideStart({
      now, cooldownMs: COOLDOWN, got200ThisCycle: true,
      lastStartAt: now - COOLDOWN - 1,
      endedAckAt: now - 10 * LIFETIME, // ack long predates our last attempt
      startAttempts: 1,
    })).toBe(true);
  });

  it("backs off exponentially so repeated failures do not push every cooldown forever", () => {
    // 3 unconfirmed attempts → 4× cooldown. Not yet due at 3×.
    expect(decideStart({
      now, cooldownMs: COOLDOWN, got200ThisCycle: false,
      lastStartAt: now - 3 * COOLDOWN, startAttempts: 3,
    })).toBe(false);
    expect(decideStart({
      now, cooldownMs: COOLDOWN, got200ThisCycle: false,
      lastStartAt: now - 4 * COOLDOWN, startAttempts: 3,
    })).toBe(true);
  });

  it("caps the backoff so a wedged install still retries at the cap", () => {
    expect(decideStart({
      now, cooldownMs: COOLDOWN, got200ThisCycle: false,
      lastStartAt: now - LIFETIME, startAttempts: 99, maxBackoffMs: LIFETIME,
    })).toBe(true);
  });

  it("still blocks a healthy card: fresh activity, no ack, within lifetime", () => {
    expect(decideStart({
      now, cooldownMs: COOLDOWN, got200ThisCycle: true,
      lastStartAt: now - 10 * LIFETIME,
      activitySince: now - 60_000, maxAssumedLifetimeMs: LIFETIME,
      startAttempts: 0,
    })).toBe(false);
  });
});
