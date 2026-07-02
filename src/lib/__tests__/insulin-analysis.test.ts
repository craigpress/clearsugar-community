import { describe, it, expect } from "vitest";
import { analyzeISF } from "../insulin-analysis";
import type { GlucoseReading, Treatment } from "../types";

function reading(sgv: number, date: number): GlucoseReading {
  return {
    _id: `r-${date}-${sgv}`,
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

function bolus(insulin: number, mills: number): Treatment {
  return {
    _id: `b-${mills}`,
    eventType: "Bolus",
    created_at: new Date(mills).toISOString(),
    enteredBy: "test",
    mills,
    utcOffset: 0,
    insulin,
  };
}

const TWO_H = 120 * 60_000;

describe("analyzeISF sign convention", () => {
  it("yields a positive effective ISF when a correction lowers glucose", () => {
    // 2026-07-15 ~14:00 ET (afternoon). Correction lowers 200 -> 150 over 2h.
    const t = Date.UTC(2026, 6, 15, 18, 0, 0); // 14:00 EDT
    const readings = [reading(200, t), reading(150, t + TWO_H)];
    const boluses = [bolus(2, t)]; // 2 units
    const { dataPoints } = analyzeISF(readings, boluses, []);
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].drop).toBe(50); // 200 - 150
    expect(dataPoints[0].isf).toBe(25); // 50 / 2
    expect(dataPoints[0].isf).toBeGreaterThan(0);
    expect(dataPoints[0].negative).toBe(false);
    expect(dataPoints[0].effective).toBe(true);
  });

  it("yields a negative effective ISF when glucose rises after a correction", () => {
    const t = Date.UTC(2026, 6, 15, 18, 0, 0);
    const readings = [reading(200, t), reading(240, t + TWO_H)];
    const boluses = [bolus(2, t)];
    const { dataPoints } = analyzeISF(readings, boluses, []);
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].drop).toBe(-40); // 200 - 240
    expect(dataPoints[0].isf).toBeLessThan(0);
    expect(dataPoints[0].negative).toBe(true);
    expect(dataPoints[0].effective).toBe(false);
  });

  it("excludes corrections that have carbs within 30 min", () => {
    const t = Date.UTC(2026, 6, 15, 18, 0, 0);
    const readings = [reading(200, t), reading(150, t + TWO_H)];
    const boluses = [bolus(2, t)];
    const carbs: Treatment[] = [
      {
        _id: "c-1",
        eventType: "Carbs",
        created_at: new Date(t + 5 * 60_000).toISOString(),
        enteredBy: "test",
        mills: t + 5 * 60_000,
        utcOffset: 0,
        carbs: 30,
      },
    ];
    const { dataPoints } = analyzeISF(readings, boluses, carbs);
    expect(dataPoints).toHaveLength(0);
  });

  it("ignores corrections from pre-bolus glucose below 100", () => {
    const t = Date.UTC(2026, 6, 15, 18, 0, 0);
    const readings = [reading(95, t), reading(80, t + TWO_H)];
    const boluses = [bolus(1, t)];
    const { dataPoints } = analyzeISF(readings, boluses, []);
    expect(dataPoints).toHaveLength(0);
  });
});
