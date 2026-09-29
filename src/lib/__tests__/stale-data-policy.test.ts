import { describe, expect, it } from "vitest";
import { decideStaleAlert } from "../stale-data-policy";

const base = { dataAgeMs: 21 * 60_000, staleThresholdMs: 20 * 60_000,
  lastStaleAlertAt: 0, now: 100 * 60_000, cooldownMs: 30 * 60_000, isSnoozed: false };

describe("server stale-data policy", () => {
  it("alerts only after the true reading age crosses the threshold", () => {
    expect(decideStaleAlert(base)).toBe(true);
    expect(decideStaleAlert({ ...base, dataAgeMs: 20 * 60_000 })).toBe(false);
  });
  it("honors snooze and cooldown", () => {
    expect(decideStaleAlert({ ...base, isSnoozed: true })).toBe(false);
    expect(decideStaleAlert({ ...base, lastStaleAlertAt: base.now - 29 * 60_000 })).toBe(false);
    expect(decideStaleAlert({ ...base, lastStaleAlertAt: base.now - 30 * 60_000 })).toBe(true);
  });
});
