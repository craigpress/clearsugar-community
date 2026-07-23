/**
 * Valid-data invariant (server side): sensor-error sentinels must never be
 * classified into a range category or trigger threshold alerts.
 *
 * Dexcom/Nightscout emit sentinel codes 0-12 on sensor faults (0 = generic
 * error, 5 = sensor not active, 9/10 = warmup/calibration, 12 = bad reading).
 * 39 is the "LOW" clamp — a real clinical urgent low, NOT an error.
 */

import { describe, it, expect } from "vitest";
import { isValidSgv, sanitizeSparkline } from "@/lib/glucose-validity";

describe("isValidSgv", () => {
  it("rejects Dexcom sensor-error sentinel codes (0-12)", () => {
    for (const code of [0, 1, 5, 9, 10, 12]) {
      expect(isValidSgv(code), `code ${code}`).toBe(false);
    }
  });

  it("rejects negative, non-finite, and non-numeric values", () => {
    expect(isValidSgv(-1)).toBe(false);
    expect(isValidSgv(NaN)).toBe(false);
    expect(isValidSgv(Infinity)).toBe(false);
    expect(isValidSgv(undefined)).toBe(false);
    expect(isValidSgv(null)).toBe(false);
    expect(isValidSgv("120")).toBe(false);
  });

  it("rejects physiologically impossible highs (>= 600)", () => {
    expect(isValidSgv(600)).toBe(false);
    expect(isValidSgv(1000)).toBe(false);
  });

  it("accepts the LOW clamp (39) and real readings", () => {
    expect(isValidSgv(39)).toBe(true);
    expect(isValidSgv(40)).toBe(true);
    expect(isValidSgv(55)).toBe(true);
    expect(isValidSgv(120)).toBe(true);
    expect(isValidSgv(599)).toBe(true);
  });
});

describe("sanitizeSparkline", () => {
  it("drops invalid values so sensor errors don't render as dips to zero", () => {
    expect(sanitizeSparkline([120, 0, 118, 5, 115])).toEqual([120, 118, 115]);
  });

  it("passes through an all-valid series unchanged", () => {
    expect(sanitizeSparkline([100, 105, 110])).toEqual([100, 105, 110]);
  });
});
