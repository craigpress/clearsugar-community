import { describe, it, expect } from "vitest";
import { modeActive } from "../feature-engine";
import type { Treatment } from "../../types";

// Parity fixture — the SAME cases are computed by cs_features.py in the parity
// cross-check (see scripts run at deploy time). Sleep covers [1000, 3,601,000];
// Exercise covers [5,000,000, 5,600,000].
function mode(eventType: string, mills: number, duration: number): Treatment {
  return {
    _id: `m-${mills}`,
    eventType,
    created_at: new Date(mills).toISOString(),
    enteredBy: "Pump (tconnectsync)",
    mills,
    utcOffset: 0,
    duration,
  };
}

const ts: Treatment[] = [mode("Sleep", 1000, 60), mode("Exercise", 5_000_000, 10)];

describe("modeActive (parity with cs_features.py _in_any_interval)", () => {
  const cases: [number, number, number][] = [
    // now, expectedSleep, expectedExercise
    [1500, 1, 0], // inside sleep
    [999_999, 1, 0], // inside sleep (< end 3,601,000)
    [0, 0, 0], // before sleep start
    [4_000_000, 0, 0], // after sleep, before exercise
    [5_300_000, 0, 1], // inside exercise
    [5_700_000, 0, 0], // after exercise end (5,600,000)
  ];
  it.each(cases)("now=%i → sleep=%i exercise=%i", (now, s, e) => {
    expect(modeActive(ts, "Sleep", now)).toBe(s);
    expect(modeActive(ts, "Exercise", now)).toBe(e);
  });
});
