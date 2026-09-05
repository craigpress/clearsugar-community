import { describe, it, expect } from "vitest";
import {
  CARB_ABSORPTION_SPAN_MIN,
  carbAbsorptionPercent,
  carbSafetyWindowMin,
  calculateCOB,
  dedupeCarbTreatments,
  treatmentCarbSpan,
} from "../physiological-model";
import type { Treatment } from "../../types";

const NOW = 1_700_000_000_000;

function carbTreatment(
  ageMinutes: number,
  grams: number,
  absorptionTime?: number | null
): Treatment {
  return {
    _id: `c-${ageMinutes}`,
    eventType: "Carb Correction",
    created_at: new Date(NOW - ageMinutes * 60_000).toISOString(),
    enteredBy: "test",
    mills: NOW - ageMinutes * 60_000,
    utcOffset: 0,
    carbs: grams,
    ...(absorptionTime === undefined ? {} : { absorptionTime }),
  };
}

const AGES = [0, 30, 60, 120, 180, 240, 300];

describe("carbAbsorptionPercent — default 180-min span (behaviour frozen)", () => {
  it("defaults the span to 180", () => {
    expect(CARB_ABSORPTION_SPAN_MIN).toBe(180);
  });

  // Hermite smoothstep 3s² − 2s³ with s = min(1, age/180); ≥240 min => 1.
  const expected: [number, number][] = [
    [0, 0],
    [30, 0.0740740740740741],
    [60, 0.25925925925925924],
    [120, 0.7407407407407407],
    [180, 1],
    [240, 1],
    [300, 1],
  ];

  for (const [age, want] of expected) {
    it(`is ${want} at ${age} min`, () => {
      expect(carbAbsorptionPercent(age)).toBeCloseTo(want, 12);
      // Explicit span 180 must be identical to the default path.
      expect(carbAbsorptionPercent(age, 180)).toBe(carbAbsorptionPercent(age));
    });
  }

  it("prints the TS curve for the Python parity check", () => {
    for (const span of [180, 30]) {
      for (const age of AGES) {
        // eslint-disable-next-line no-console
        console.log(
          `span=${span} age=${age} pct=${carbAbsorptionPercent(age, span).toFixed(6)} ` +
            `cob_g=${calculateCOB([carbTreatment(age, 60, span)], NOW).toFixed(6)}`
        );
      }
    }
  });
});

describe("safety window", () => {
  it("keeps the historical 4h floor for the default span", () => {
    expect(carbSafetyWindowMin()).toBe(240);
    expect(carbSafetyWindowMin(180)).toBe(240);
    expect(carbSafetyWindowMin(30)).toBe(240);
  });

  it("extends past 4h so a longer span is not truncated", () => {
    expect(carbSafetyWindowMin(240)).toBe(300);
    expect(carbSafetyWindowMin(360)).toBe(420);
    // A 360-min span is still absorbing at 240 min instead of being clamped to 1.
    expect(carbAbsorptionPercent(240, 360)).toBeCloseTo(0.7407407407407407, 12);
  });
});

describe("treatmentCarbSpan", () => {
  it("uses a positive finite absorptionTime", () => {
    expect(treatmentCarbSpan(carbTreatment(0, 10, 30))).toBe(30);
  });

  it("falls back to 180 for missing / null / 0 / negative / non-finite", () => {
    expect(treatmentCarbSpan(carbTreatment(0, 10))).toBe(180);
    expect(treatmentCarbSpan(carbTreatment(0, 10, null))).toBe(180);
    expect(treatmentCarbSpan(carbTreatment(0, 10, 0))).toBe(180);
    expect(treatmentCarbSpan(carbTreatment(0, 10, -30))).toBe(180);
    expect(treatmentCarbSpan(carbTreatment(0, 10, NaN))).toBe(180);
    expect(treatmentCarbSpan(carbTreatment(0, 10, Infinity))).toBe(180);
  });
});

describe("calculateCOB", () => {
  it("is unchanged on the default path (no absorptionTime)", () => {
    expect(calculateCOB([carbTreatment(30, 60)], NOW)).toBeCloseTo(
      60 * (1 - 0.0740740740740741),
      10
    );
    expect(calculateCOB([carbTreatment(60, 60)], NOW)).toBeCloseTo(
      60 * (1 - 0.25925925925925924),
      10
    );
    expect(calculateCOB([carbTreatment(180, 60)], NOW)).toBe(0);
    // Past the 4h window the treatment is skipped entirely.
    expect(calculateCOB([carbTreatment(300, 60)], NOW)).toBe(0);
  });

  it("fully absorbs an absorptionTime=30 treatment by 30 min, unlike the default", () => {
    expect(calculateCOB([carbTreatment(30, 60, 30)], NOW)).toBe(0);
    expect(calculateCOB([carbTreatment(30, 60)], NOW)).toBeGreaterThan(50);
  });

  it("absorbs a short span faster at every intermediate age", () => {
    for (const age of [10, 20, 25]) {
      expect(calculateCOB([carbTreatment(age, 60, 30)], NOW)).toBeLessThan(
        calculateCOB([carbTreatment(age, 60)], NOW)
      );
    }
  });

  it("still holds carbs at 240 min for a 360-min span", () => {
    expect(calculateCOB([carbTreatment(240, 60, 360)], NOW)).toBeCloseTo(
      60 * (1 - 0.7407407407407407),
      10
    );
    // Same treatment on the default span is outside the window -> 0.
    expect(calculateCOB([carbTreatment(240, 60)], NOW)).toBe(0);
  });
});

describe("carb identity", () => {
  it("preserves two separate 15 g rescues eight minutes apart", () => {
    const a = { ...carbTreatment(8, 15, 30), _id: "rescue-a" };
    const b = { ...carbTreatment(0, 15, 30), _id: "rescue-b" };
    expect(dedupeCarbTreatments([a, b])).toEqual([a, b]);
    expect(calculateCOB([a, b], NOW)).toBeCloseTo(calculateCOB([a], NOW) + 15, 12);
  });
  it("preserves separate entries even at the same time and amount", () => {
    const a = { ...carbTreatment(0, 45), _id: "pump", enteredBy: "tconnectsync" };
    const b = { ...a, _id: "manual", enteredBy: "ClearSugar" };
    expect(calculateCOB([a, b], NOW)).toBe(90);
  });
  it("collapses repeated copies of the same document without changing order", () => {
    const a = { ...carbTreatment(0, 15), _id: "a" };
    const b = { ...carbTreatment(0, 20), _id: "b" };
    expect(dedupeCarbTreatments([a, b, { ...a }])).toEqual([a, b]);
    expect(calculateCOB([a, b, { ...a }], NOW)).toBe(35);
  });
  it("preserves entries without identity and returns the original untouched array", () => {
    const rows = [{ ...carbTreatment(0, 15), _id: "" }, { ...carbTreatment(0, 15), _id: "" }];
    expect(dedupeCarbTreatments(rows)).toBe(rows);
    expect(calculateCOB(rows, NOW)).toBe(30);
  });
});
