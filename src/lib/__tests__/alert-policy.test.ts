import { describe, it, expect } from "vitest";
import {
  categoryCooldownPassed,
  migrateAlertState,
  recordCategoryFired,
  updateInRangeTracking,
  sustainedInRange,
  isDeviceAcked,
  recordDeviceAck,
  pruneExpiredAcks,
  advisorSilencedBySnooze,
  type GlucoseAlertStateV2,
} from "../alert-policy";

const MIN = 60_000;

// ── Per-category cooldowns ──
// The old state was a single global {lastAlertType, lastAlertTime}. With devices
// at different thresholds classifying the same reading differently (one phone's
// urgentHigh is another's high), each cycle overwrote lastAlertType and the other
// group bypassed the cooldown entirely — observed live 2026-07-24 as alerts every
// 5 minutes for 40 minutes (glucoseAlertPushed oscillating 6→2→6→2) against a
// nominal 30-min high cooldown.
describe("categoryCooldownPassed", () => {
  const state: GlucoseAlertStateV2 = {
    categories: { high: { lastAlertTime: 1000 * MIN, lastSgv: 200 } },
    inRangeSince: 0,
  };

  it("blocks a category still inside its cooldown", () => {
    expect(categoryCooldownPassed(state, "high", 1000 * MIN + 5 * MIN, 30 * MIN)).toBe(false);
  });
  it("passes once the category's cooldown elapses", () => {
    expect(categoryCooldownPassed(state, "high", 1000 * MIN + 31 * MIN, 30 * MIN)).toBe(true);
  });
  it("one category firing does NOT reset another's cooldown (the 6→2→6→2 bug)", () => {
    // urgentHigh fired 5 min ago; high fired 5 min ago too. Under the old single
    // lastAlertType, whichever fired last erased the other's clock. Now each
    // category holds its own timestamp.
    const s: GlucoseAlertStateV2 = {
      categories: {
        high: { lastAlertTime: 1000 * MIN, lastSgv: 200 },
        urgentHigh: { lastAlertTime: 1000 * MIN, lastSgv: 260 },
      },
      inRangeSince: 0,
    };
    expect(categoryCooldownPassed(s, "high", 1000 * MIN + 5 * MIN, 30 * MIN)).toBe(false);
    expect(categoryCooldownPassed(s, "urgentHigh", 1000 * MIN + 5 * MIN, 15 * MIN)).toBe(false);
  });
  it("passes for a category that never fired", () => {
    expect(categoryCooldownPassed(state, "urgentLow", 1000 * MIN, 5 * MIN)).toBe(true);
  });
});

describe("migrateAlertState", () => {
  it("migrates the v1 single-type shape into a category map", () => {
    expect(migrateAlertState({ lastAlertType: "high", lastAlertTime: 123, lastSgv: 210 }))
      .toEqual({ categories: { high: { lastAlertTime: 123, lastSgv: 210 } }, inRangeSince: 0 });
  });
  it("passes through v2 unchanged", () => {
    const v2: GlucoseAlertStateV2 = { categories: { low: { lastAlertTime: 5, lastSgv: 60 } }, inRangeSince: 9 };
    expect(migrateAlertState(v2)).toEqual(v2);
  });
  it("returns an empty v2 for null/empty", () => {
    expect(migrateAlertState(null)).toEqual({ categories: {}, inRangeSince: 0 });
    expect(migrateAlertState({})).toEqual({ categories: {}, inRangeSince: 0 });
  });
});

describe("recordCategoryFired", () => {
  it("stamps only the fired category", () => {
    const s: GlucoseAlertStateV2 = {
      categories: { high: { lastAlertTime: 1, lastSgv: 190 } },
      inRangeSince: 0,
    };
    recordCategoryFired(s, "urgentHigh", 99, 280);
    expect(s.categories.high.lastAlertTime).toBe(1);
    expect(s.categories.urgentHigh).toEqual({ lastAlertTime: 99, lastSgv: 280 });
  });
});

// ── Sustained in-range clearing ──
// The old code wiped the whole cooldown state (and untilRange snoozes) on ANY
// single in-range reading, so glucose hovering at a threshold re-alerted on
// every crossing. Clearing now requires the reading to stay in range for a
// sustained window.
describe("in-range tracking", () => {
  it("starts the in-range clock on the first in-range reading", () => {
    const s: GlucoseAlertStateV2 = { categories: {}, inRangeSince: 0 };
    updateInRangeTracking(s, true, 500);
    expect(s.inRangeSince).toBe(500);
  });
  it("does not restart the clock while still in range", () => {
    const s: GlucoseAlertStateV2 = { categories: {}, inRangeSince: 500 };
    updateInRangeTracking(s, true, 900);
    expect(s.inRangeSince).toBe(500);
  });
  it("resets the clock when out of range again", () => {
    const s: GlucoseAlertStateV2 = { categories: {}, inRangeSince: 500 };
    updateInRangeTracking(s, false, 900);
    expect(s.inRangeSince).toBe(0);
  });
  it("a single in-range reading does NOT clear (the hover bug)", () => {
    expect(sustainedInRange({ categories: {}, inRangeSince: 1000 * MIN }, 1000 * MIN + MIN, 15 * MIN)).toBe(false);
  });
  it("clears after the sustained window", () => {
    expect(sustainedInRange({ categories: {}, inRangeSince: 1000 * MIN }, 1000 * MIN + 15 * MIN, 15 * MIN)).toBe(true);
  });
  it("never clears while out of range (inRangeSince 0)", () => {
    expect(sustainedInRange({ categories: {}, inRangeSince: 0 }, 5000 * MIN, 15 * MIN)).toBe(false);
  });
});

// ── Per-device acks ──
// ACK previously only cancelled the phone's local 60s repeat; the server kept
// alerting on its own schedule. Chosen semantics (2026-07-24): an ack quiets
// ONLY the acking phone, for that alert type's cooldown. Other phones keep
// alerting; a more urgent category still fires everywhere.
describe("device acks", () => {
  it("suppresses the acked type on the acking device only", () => {
    const acks = {};
    recordDeviceAck(acks, "install-A", "high", 1000);
    expect(isDeviceAcked(acks, "install-A", "high", 500)).toBe(true);
    expect(isDeviceAcked(acks, "install-B", "high", 500)).toBe(false);
  });
  it("does not suppress a different (e.g. escalated) type", () => {
    const acks = {};
    recordDeviceAck(acks, "install-A", "high", 1000);
    expect(isDeviceAcked(acks, "install-A", "urgentHigh", 500)).toBe(false);
  });
  it("expires", () => {
    const acks = {};
    recordDeviceAck(acks, "install-A", "high", 1000);
    expect(isDeviceAcked(acks, "install-A", "high", 1001)).toBe(false);
  });
  it("pruneExpiredAcks drops expired entries and empty devices", () => {
    const acks = {};
    recordDeviceAck(acks, "install-A", "high", 1000);
    recordDeviceAck(acks, "install-B", "low", 5000);
    const changed = pruneExpiredAcks(acks, 2000);
    expect(changed).toBe(true);
    expect(acks).toEqual({ "install-B": { low: 5000 } });
  });
});

// ── HA gating ──
// HA's sustained-high automation is an independent backstop that never saw
// ClearSugar snoozes — the second duplicate source. Chosen semantics: gate
// sustained_high off while a covering FULL snooze is active; urgent_low is
// never gated; per-device acks never gate HA (they only quiet one phone, and HA
// notifies both parents).
describe("advisorSilencedBySnooze — advisories honour snoozes (2026-07-28)", () => {
  const now = 1_700_000_000_000;
  const MIN = 60_000;
  const none = { snoozedUntil: 0, snoozedCategories: [] as string[], untilRange: false };
  const snoozed = (cats: string[]) => ({
    snoozedUntil: now + 30 * MIN,
    snoozedCategories: cats,
    untilRange: false,
  });

  it("does not silence anything with no snooze in force", () => {
    expect(advisorSilencedBySnooze("impending_low", "urgent", none, now)).toBe(false);
  });

  it("does not silence on an EXPIRED timed snooze", () => {
    const stale = { snoozedUntil: now - 1, snoozedCategories: ["all"], untilRange: false };
    expect(advisorSilencedBySnooze("impending_low", "urgent", stale, now)).toBe(false);
  });

  it("silences everything under an `all` snooze", () => {
    for (const rc of ["impending_low", "ciq_capped_high", "failing_site", "stale_data"]) {
      expect(advisorSilencedBySnooze(rc, "moderate", snoozed(["all"]), now)).toBe(true);
    }
  });

  it("honours an untilRange snooze even with no expiry set", () => {
    const ur = { snoozedUntil: 0, snoozedCategories: ["all"], untilRange: true };
    expect(advisorSilencedBySnooze("impending_low", "moderate", ur, now)).toBe(true);
  });

  it("does NOT let a `low` snooze mask a SEVERE impending low", () => {
    // Escalation must survive, exactly as it does for glucose alerts: a severe
    // low is a different category key, so silencing `low` never silences it.
    expect(advisorSilencedBySnooze("impending_low", "moderate", snoozed(["low"]), now)).toBe(true);
    expect(advisorSilencedBySnooze("impending_low", "urgent", snoozed(["low"]), now)).toBe(false);
    expect(advisorSilencedBySnooze("impending_low", "urgent", snoozed(["urgentLow"]), now)).toBe(true);
  });

  it("keeps low and high snoozes independent", () => {
    expect(advisorSilencedBySnooze("ciq_capped_high", "moderate", snoozed(["low"]), now)).toBe(false);
    expect(advisorSilencedBySnooze("impending_low", "moderate", snoozed(["high"]), now)).toBe(false);
    expect(advisorSilencedBySnooze("ciq_capped_high", "moderate", snoozed(["high"]), now)).toBe(true);
    expect(advisorSilencedBySnooze("ciq_capped_high", "high", snoozed(["urgentHigh"]), now)).toBe(true);
  });

  it("silences non-glucose advisories ONLY under `all`", () => {
    // A failing site or a stale-data notice has no glucose category, so a
    // category-specific snooze must not accidentally cover it.
    for (const cats of [["low"], ["urgentLow"], ["high"], ["urgentHigh"]]) {
      expect(advisorSilencedBySnooze("failing_site", "high", snoozed(cats), now)).toBe(false);
    }
    expect(advisorSilencedBySnooze("failing_site", "high", snoozed(["all"]), now)).toBe(true);
  });
});
