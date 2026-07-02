import { describe, it, expect } from "vitest";
import { calculateStats } from "../statistics";
import type { GlucoseReading } from "../types";

function reading(sgv: number, date = 0): GlucoseReading {
  return {
    _id: String(date) + "-" + sgv,
    sgv,
    date,
    dateString: new Date(date).toISOString(),
    direction: "Flat",
    trend: 4,
    device: "test",
    type: "sgv",
    mills: date,
  };
}

describe("calculateStats", () => {
  it("returns zeroed stats for an empty array", () => {
    const s = calculateStats([]);
    expect(s.count).toBe(0);
    expect(s.mean).toBe(0);
    expect(s.min).toBe(0);
    expect(s.max).toBe(0);
    expect(s.gmi).toBe(0);
    expect(s.cv).toBe(0);
    expect(s.timeInRange.inRange).toBe(0);
  });

  it("handles a single reading", () => {
    const s = calculateStats([reading(120)]);
    expect(s.count).toBe(1);
    expect(s.mean).toBe(120);
    expect(s.median).toBe(120);
    expect(s.min).toBe(120);
    expect(s.max).toBe(120);
    expect(s.stddev).toBe(0);
    expect(s.cv).toBe(0);
    // 120 is in 70-180 range
    expect(s.timeInRange.inRange).toBe(100);
  });

  it("classifies all-low readings", () => {
    const s = calculateStats([reading(50), reading(60), reading(65)]);
    // 50 < 54 => veryLow; 60,65 in [54,70) => low
    expect(s.timeInRange.veryLow).toBe(33);
    expect(s.timeInRange.low).toBe(67);
    expect(s.timeInRange.inRange).toBe(0);
  });

  it("counts 70 and 180 as in range (inclusive bounds)", () => {
    const s = calculateStats([reading(70), reading(180), reading(120)]);
    expect(s.timeInRange.inRange).toBe(100);
    expect(s.timeInRange.low).toBe(0);
    expect(s.timeInRange.high).toBe(0);
  });

  it("computes GMI and CV with the documented formulas", () => {
    const vals = [100, 120, 140, 160];
    const s = calculateStats(vals.map((v) => reading(v)));
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length; // 130
    const variance =
      vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length;
    const sd = Math.sqrt(variance);

    expect(s.mean).toBe(Math.round(mean));
    // GMI = 3.31 + 0.02392 * mean, rounded to 1 decimal
    expect(s.gmi).toBe(Math.round((3.31 + 0.02392 * mean) * 10) / 10);
    // CV = sd/mean*100, rounded to int
    expect(s.cv).toBe(Math.round((sd / mean) * 100));
  });
});
