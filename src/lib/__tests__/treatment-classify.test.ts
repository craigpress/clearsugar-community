import { describe, expect, it } from "vitest";
import { classifyBolus, treatmentKey } from "../treatment-classify";
import type { Treatment } from "../types";

const treatment = (extra: Partial<Treatment> = {}): Treatment => ({
  _id: "doc", created_at: "2026-09-04T12:34:56.000Z", eventType: "Bolus",
  enteredBy: "tconnectsync", insulin: 1, mills: Date.parse("2026-09-04T12:34:56.000Z"), utcOffset: 0, ...extra,
});

describe("classifyBolus", () => {
  it("classifies pump meals, automatic boluses, corrections and extended boluses", () => {
    expect(classifyBolus(treatment({ carbs: 30 }))).toBe("meal");
    expect(classifyBolus(treatment({ carbs: 30, reason: "Auto Correction" }))).toBe("auto");
    expect(classifyBolus(treatment({ carbs: 0, notes: "manual correction" }))).toBe("correction");
    expect(classifyBolus(treatment({ carbs: 0, notes: "Extended Bolus" }))).toBe("extended");
  });
  it("fails closed for non-pump or insulin-free records", () => {
    expect(classifyBolus(treatment({ enteredBy: "manual" }))).toBe("not_bolus");
    expect(classifyBolus(treatment({ insulin: 0, carbs: 30 }))).toBe("not_bolus");
  });
  it("uses pump event identity when available", () => {
    expect(treatmentKey(treatment({ pump_event_id: "pump" }))).toBe("pump");
    expect(treatmentKey(treatment())).toBe("doc");
  });
});
