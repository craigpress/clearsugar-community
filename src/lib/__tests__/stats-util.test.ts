import { describe, it, expect } from "vitest";
import { percentile, minOf, maxOf } from "../stats-util";

describe("percentile", () => {
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  it("returns endpoints for 0 and 1", () => {
    expect(percentile(sorted, 0)).toBe(10);
    expect(percentile(sorted, 1)).toBe(100);
  });

  it("computes p10/p50/p90 by linear interpolation", () => {
    // idx = fraction*(n-1) = fraction*9
    // p10 -> idx 0.9 -> 10 + 0.9*(20-10) = 19
    expect(percentile(sorted, 0.1)).toBeCloseTo(19, 6);
    // p50 -> idx 4.5 -> 50 + 0.5*(60-50) = 55
    expect(percentile(sorted, 0.5)).toBeCloseTo(55, 6);
    // p90 -> idx 8.1 -> 90 + 0.1*(100-90) = 91
    expect(percentile(sorted, 0.9)).toBeCloseTo(91, 6);
  });

  it("handles empty and single-element arrays", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([42], 0.5)).toBe(42);
  });
});

describe("minOf / maxOf", () => {
  it("works on large arrays that would overflow the call stack via spread", () => {
    const big = Array.from({ length: 200000 }, (_, i) => i);
    expect(minOf(big)).toBe(0);
    expect(maxOf(big)).toBe(199999);
  });

  it("returns 0 for empty arrays", () => {
    expect(minOf([])).toBe(0);
    expect(maxOf([])).toBe(0);
  });

  it("handles negatives and unsorted input", () => {
    expect(minOf([3, -5, 2, 8, -1])).toBe(-5);
    expect(maxOf([3, -5, 2, 8, -1])).toBe(8);
  });
});
