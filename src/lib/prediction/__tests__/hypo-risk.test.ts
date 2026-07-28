import { describe, it, expect } from "vitest";
import { predictHypoRisk } from "../hypo-risk";
import type { Treatment, PumpProfile, GlucoseReading } from "../../types";

const SEG = (value: number) => [{ time: "00:00", value, timeAsSeconds: 0 }];

const profile: PumpProfile = {
  _id: "p",
  defaultProfile: "Default",
  store: {
    Default: {
      dia: 5,
      carbratio: SEG(10),
      sens: SEG(70),
      basal: SEG(1.0),
      target_low: SEG(100),
      target_high: SEG(120),
      timezone: "America/New_York",
      units: "mg/dl",
    },
  },
};

const NOW = 1_785_000_000_000;
const FIVE_MIN = 5 * 60_000;

/** Flat readings so momentum is zero and only insulin can move the curve. */
function flatReadings(sgv: number, count = 6, at = NOW): GlucoseReading[] {
  return Array.from({ length: count }, (_, i) => ({
    _id: `g-${i}`,
    sgv,
    date: at - i * FIVE_MIN,
    dateString: new Date(at - i * FIVE_MIN).toISOString(),
    direction: "Flat",
    type: "sgv",
  })) as GlucoseReading[];
}

function bolus(insulin: number, mills: number): Treatment {
  return {
    _id: `b-${mills}`,
    eventType: "Bolus",
    created_at: new Date(mills).toISOString(),
    enteredBy: "test",
    mills,
    utcOffset: 0,
    insulin,
  } as Treatment;
}

function carbs(grams: number, mills: number): Treatment {
  return {
    _id: `c-${mills}`,
    eventType: "Carb Correction",
    created_at: new Date(mills).toISOString(),
    enteredBy: "test",
    mills,
    utcOffset: 0,
    carbs: grams,
  } as Treatment;
}

describe("predictHypoRisk", () => {
  it("returns an empty result when there are too few readings", () => {
    const r = predictHypoRisk([], [], profile);
    expect(r.points).toEqual([]);
    expect(r.minutesToLow).toBeNull();
  });

  it("stays flat when there is no insulin on board", () => {
    const r = predictHypoRisk(flatReadings(120), [], profile);
    expect(r.points.length).toBeGreaterThan(0);
    expect(r.nadir).toBe(120);
    expect(r.minutesToLow).toBeNull();
  });

  it("descends when insulin is on board", () => {
    // 2u at 70 mg/dL/u ≈ 140 mg/dL of eventual drop, given 10 min ago.
    const r = predictHypoRisk(flatReadings(150), [bolus(2, NOW - 10 * 60_000)], profile);
    expect(r.nadir).toBeLessThan(150);
    expect(r.points[r.points.length - 1].sgv).toBeLessThan(150);
  });

  it("reports the nadir and when it occurs", () => {
    const r = predictHypoRisk(flatReadings(150), [bolus(2, NOW - 10 * 60_000)], profile);
    const lowest = Math.min(...r.points.map((p) => p.sgv));
    expect(r.nadir).toBe(lowest);
    expect(r.minutesToNadir).toBeGreaterThan(0);
    const at = r.points.find((p) => p.sgv === lowest)!;
    expect(r.nadirAt).toBe(at.timestamp);
  });

  it("reports minutes until the low threshold is crossed", () => {
    const r = predictHypoRisk(flatReadings(110), [bolus(2, NOW - 10 * 60_000)], profile, {
      lowThreshold: 70,
    });
    expect(r.minutesToLow).not.toBeNull();
    expect(r.minutesToLow!).toBeGreaterThan(0);
    // The crossing must be at or before the nadir.
    expect(r.minutesToLow!).toBeLessThanOrEqual(r.minutesToNadir);
  });

  it("returns null minutesToLow when the floor stays above the threshold", () => {
    const r = predictHypoRisk(flatReadings(250), [bolus(0.2, NOW - 10 * 60_000)], profile, {
      lowThreshold: 70,
    });
    expect(r.minutesToLow).toBeNull();
  });

  it("IGNORES carbs on board — that is the entire point of the curve", () => {
    const insulin = [bolus(2, NOW - 10 * 60_000)];
    const withoutCarbs = predictHypoRisk(flatReadings(150), insulin, profile);
    const withCarbs = predictHypoRisk(
      flatReadings(150),
      [...insulin, carbs(80, NOW - 5 * 60_000)],
      profile
    );
    // A big pending meal must not raise the hypo floor: in the blended
    // prediction it would cancel the insulin and hide the impending low.
    expect(withCarbs.nadir).toBe(withoutCarbs.nadir);
    expect(withCarbs.minutesToNadir).toBe(withoutCarbs.minutesToNadir);
  });

  it("ignores momentum — a sharp rise must not mask insulin already dosed", () => {
    // Rising 15 mg/dL per 5 min, with a big bolus on board.
    const rising: GlucoseReading[] = Array.from({ length: 6 }, (_, i) => ({
      _id: `g-${i}`,
      sgv: 150 - i * 15,
      date: NOW - i * FIVE_MIN,
      dateString: new Date(NOW - i * FIVE_MIN).toISOString(),
      direction: "SingleUp",
      type: "sgv",
    })) as GlucoseReading[];
    const r = predictHypoRisk(rising, [bolus(3, NOW - 15 * 60_000)], profile);
    // Momentum would carry this upward; the hypo floor must still fall.
    expect(r.nadir).toBeLessThan(150);
  });

  it("never predicts below the physiological floor", () => {
    const r = predictHypoRisk(flatReadings(80), [bolus(10, NOW - 10 * 60_000)], profile);
    expect(r.nadir).toBeGreaterThanOrEqual(39);
  });

  it("honors the requested horizon", () => {
    const r = predictHypoRisk(flatReadings(150), [bolus(1, NOW - 10 * 60_000)], profile, {
      horizonMinutes: 60,
    });
    expect(r.points).toHaveLength(12); // 60 min / 5
    expect(r.points[11].timestamp).toBe(NOW + 60 * 60_000);
  });
});
