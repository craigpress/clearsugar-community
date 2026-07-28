import { describe, it, expect } from "vitest";
import {
  isPumpSleep,
  getCiqMode,
  lowThresholdForMode,
  EXERCISE_LOW_MODULATION,
} from "../ciq-modes";
import type { Treatment } from "../../types";

const MIN = 60_000;
// isPumpSleep works in LOCAL time (localMinOfDay), so these must be built with
// the local-time Date constructor, not Date.UTC. The previous version picked
// UTC instants that land on the intended hour only in America/New_York, so the
// suite failed anywhere else — including any CI runner, which is UTC.
const localTime = (h: number) => new Date(2026, 6, 1, h, 0, 0).getTime();
const NIGHT_LOCAL = localTime(2); // 02:00 local
const DAY_LOCAL = localTime(12); // 12:00 local
const EARLY_AM_LOCAL = localTime(6); // 06:00 local (in the old 22–07, NOT in 22–05)

describe("isPumpSleep", () => {
  it("uses the 22:00–05:00 fallback when no schedule is given", () => {
    expect(isPumpSleep(NIGHT_LOCAL)).toBe(true); // 02:00
    expect(isPumpSleep(DAY_LOCAL)).toBe(false); // 12:00
  });

  it("treats 06:00 as awake under the pump 22:00–05:00 window (the schedule change)", () => {
    // Under the old hardcoded 22:00–07:00 this would have been 'night'.
    expect(isPumpSleep(EARLY_AM_LOCAL)).toBe(false);
  });

  it("honors a published schedule and its enabled flag", () => {
    const sched = { startMin: 22 * 60, endMin: 5 * 60, enabled: true };
    expect(isPumpSleep(NIGHT_LOCAL, sched)).toBe(true);
    const disabled = { startMin: 22 * 60, endMin: 5 * 60, enabled: false };
    expect(isPumpSleep(NIGHT_LOCAL, disabled)).toBe(true); // falls back → still 22–05
  });
});

function mode(kind: string, startMs: number, durationMin: number): Treatment {
  return {
    _id: `m-${startMs}`,
    eventType: kind,
    created_at: new Date(startMs).toISOString(),
    enteredBy: "Pump (tconnectsync)",
    mills: startMs,
    utcOffset: 0,
    duration: durationMin,
  };
}

describe("getCiqMode", () => {
  const now = DAY_LOCAL;
  it("returns normal with no markers", () => {
    expect(getCiqMode([], now)).toBe("normal");
  });
  it("detects an active sleep window", () => {
    expect(getCiqMode([mode("Sleep", now - 60 * MIN, 420)], now)).toBe("sleep");
  });
  it("detects an active exercise window and prefers it over sleep", () => {
    const ts = [mode("Sleep", now - 60 * MIN, 420), mode("Exercise", now - 10 * MIN, 60)];
    expect(getCiqMode(ts, now)).toBe("exercise");
  });
  it("ignores an expired marker", () => {
    expect(getCiqMode([mode("Exercise", now - 120 * MIN, 30)], now)).toBe("normal");
  });
  it("ignores a future marker", () => {
    expect(getCiqMode([mode("Sleep", now + 60 * MIN, 420)], now)).toBe("normal");
  });
});

describe("lowThresholdForMode (gated OFF by default)", () => {
  it("does not change the validated threshold while the gate is off", () => {
    expect(EXERCISE_LOW_MODULATION).toBe(false);
    expect(lowThresholdForMode(70, "exercise")).toBe(70);
    expect(lowThresholdForMode(70, "normal")).toBe(70);
    expect(lowThresholdForMode(70, "sleep")).toBe(70);
  });
});
