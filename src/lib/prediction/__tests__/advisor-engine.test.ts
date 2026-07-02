import { describe, it, expect } from "vitest";
import { evaluateAdvisories } from "../advisor-engine";
import type { GlucoseReading, Treatment, PumpProfile } from "../../types";
import type { AdvisorInput } from "../advisor-types";

// Fixed, realistic timestamp (deterministic; maps to a normal afternoon hour in
// ET, avoiding the host-local getHours() fixture fragility seen elsewhere).
const NOW = new Date("2026-06-15T18:00:00Z").getTime();
const MIN = 60_000;

function seg(value: number) {
  return [{ time: "00:00", value, timeAsSeconds: 0 }];
}

const PROFILE: PumpProfile = {
  _id: "p1",
  defaultProfile: "Default",
  store: {
    Default: {
      dia: 5,
      carbratio: seg(10),
      sens: seg(70),
      basal: seg(1.0),
      target_low: seg(100),
      target_high: seg(120),
      timezone: "America/New_York",
      units: "mg/dl",
    },
  },
};

function reading(ageMin: number, sgv: number): GlucoseReading {
  const date = NOW - ageMin * MIN;
  return {
    _id: `r${ageMin}`,
    sgv,
    date,
    dateString: new Date(date).toISOString(),
    direction: "Flat",
    trend: 4,
    device: "test",
    type: "sgv",
    mills: date,
    delta: 0,
  };
}

/** 12 flat in-range readings ending at NOW. */
function flatReadings(sgv = 120): GlucoseReading[] {
  return Array.from({ length: 12 }, (_, i) => reading((11 - i) * 5, sgv));
}

function tempBasal(ageMin: number): Treatment {
  const ms = NOW - ageMin * MIN;
  return {
    eventType: "Temp Basal",
    created_at: new Date(ms).toISOString(),
    mills: ms,
    reason: "Algorithm",
    rate: 1.0,
    absolute: 1.0,
    duration: 5,
  } as Treatment;
}

describe("evaluateAdvisories", () => {
  it("stays SILENT on stale pump data when nothing is masked (no stale-notice spam)", () => {
    const input: AdvisorInput = {
      readings: flatReadings(120),
      treatments: [tempBasal(40)], // last pump treatment 40 min ago > 25 (stale)
      profile: PROFILE,
      now: NOW,
    };
    const res = evaluateAdvisories(input);
    // Routine tconnectsync lag with in-range BG and nothing pending → no notice.
    expect(res.pumpStaleMin).toBeGreaterThan(25);
    expect(res.staleSuppressed).toBe(false);
    expect(res.actions).toHaveLength(0);
  });

  it("returns no advisories on fresh, flat, in-range data", () => {
    const input: AdvisorInput = {
      readings: flatReadings(120),
      treatments: [tempBasal(3)], // fresh
      profile: PROFILE,
      now: NOW,
    };
    const res = evaluateAdvisories(input);
    expect(res.staleSuppressed).toBe(false);
    expect(res.actions).toHaveLength(0);
    expect(typeof res.siteFailureVeto).toBe("boolean");
  });

  it("reports unknown staleness (null) when there are no treatments, and does not crash", () => {
    const input: AdvisorInput = {
      readings: flatReadings(120),
      treatments: [],
      profile: PROFILE,
      now: NOW,
    };
    const res = evaluateAdvisories(input);
    expect(res.pumpStaleMin).toBeNull();
    expect(res.staleSuppressed).toBe(false);
  });
});
