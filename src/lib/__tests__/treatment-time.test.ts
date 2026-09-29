import { describe, expect, it } from "vitest";
import { treatmentTime } from "../time";
import type { Treatment } from "../types";

const base = { _id: "x", created_at: "2026-01-15T12:00:00.000Z", eventType: "Bolus", enteredBy: "test" };

describe("treatmentTime", () => {
  it("prefers a positive mills value", () => {
    expect(treatmentTime({ ...base, mills: 1234 } as Treatment)).toBe(1234);
  });
  it("falls back to created_at for missing, zero, or negative mills", () => {
    const expected = Date.parse(base.created_at);
    expect(treatmentTime(base as Treatment)).toBe(expected);
    expect(treatmentTime({ ...base, mills: 0 } as Treatment)).toBe(expected);
    expect(treatmentTime({ ...base, mills: -1 } as Treatment)).toBe(expected);
  });
});
