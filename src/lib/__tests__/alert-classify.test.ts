/**
 * Threshold alert classification must gate on sgv validity: a Dexcom
 * sensor-error sentinel (e.g. 0) is numerically below every low threshold
 * and would otherwise fire a critical URGENT LOW for a sensor fault.
 */

import { describe, it, expect } from "vitest";
import { classifyGlucose } from "@/lib/alert-classify";

const PREFS = {
  thresholdUrgentLow: 55,
  thresholdLow: 70,
  thresholdHigh: 180,
  thresholdUrgentHigh: 250,
};

describe("classifyGlucose", () => {
  it("never classifies sensor-error sentinels", () => {
    for (const code of [0, 1, 5, 9, 10, 12]) {
      expect(classifyGlucose(code, PREFS), `code ${code}`).toBeNull();
    }
  });

  it("never classifies impossible highs", () => {
    expect(classifyGlucose(600, PREFS)).toBeNull();
    expect(classifyGlucose(1000, PREFS)).toBeNull();
  });

  it("classifies real readings against per-device thresholds", () => {
    expect(classifyGlucose(39, PREFS)).toBe("urgentLow");
    expect(classifyGlucose(54, PREFS)).toBe("urgentLow");
    expect(classifyGlucose(55, PREFS)).toBe("low");
    expect(classifyGlucose(69, PREFS)).toBe("low");
    expect(classifyGlucose(120, PREFS)).toBeNull();
    expect(classifyGlucose(180, PREFS)).toBe("high");
    expect(classifyGlucose(250, PREFS)).toBe("urgentHigh");
    expect(classifyGlucose(599, PREFS)).toBe("urgentHigh");
  });
});
