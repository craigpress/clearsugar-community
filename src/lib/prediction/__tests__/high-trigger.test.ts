import { describe, it, expect } from "vitest";
import {
  evaluateHighTrigger,
  ciqHighRollout,
  HIGH_TRIGGER_VALIDATED,
} from "../high-trigger";
import type { GlucoseReading, Treatment, PumpProfile } from "../../types";
import type { AdvisorInput } from "../advisor-types";

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

const FIVE = 5 * 60_000;
// Daytime anchor (≈14:00 EDT) so the day gate (250) applies deterministically.
const NOW = Date.UTC(2026, 6, 1, 18, 0, 0);

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

/** count readings spaced 5 min, ending at `end`, following sgvs oldest→newest. */
function trail(sgvs: number[], end: number = NOW): GlucoseReading[] {
  const n = sgvs.length;
  return sgvs.map((sgv, i) => reading(sgv, end - (n - 1 - i) * FIVE));
}

function flat(sgv: number, count = 9, end = NOW): GlucoseReading[] {
  return trail(Array(count).fill(sgv), end);
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

function carbs(g: number, mills: number): Treatment {
  return {
    _id: `c-${mills}`,
    eventType: "Carb Correction",
    created_at: new Date(mills).toISOString(),
    enteredBy: "test",
    mills,
    utcOffset: 0,
    carbs: g,
  };
}

const input = (readings: GlucoseReading[], treatments: Treatment[] = []): AdvisorInput => ({
  readings,
  treatments,
  profile,
  now: NOW,
});

describe("evaluateHighTrigger — suppression paths", () => {
  it("no fire when BG is below the gate", () => {
    expect(evaluateHighTrigger(input(flat(200)))).toBeNull();
  });

  it("no fire when the high is transient (not sustained)", () => {
    // just spiked: latest high but the trailing window was normal
    const r = trail([120, 120, 130, 140, 180, 220, 260]);
    expect(evaluateHighTrigger(input(r))).toBeNull();
  });

  it("no fire when BG is already dropping fast (insulin working)", () => {
    const r = trail([400, 380, 360, 340, 320, 300, 290]); // steep decline
    expect(evaluateHighTrigger(input(r))).toBeNull();
  });

  it("no fire when a correction was just delivered", () => {
    const r = flat(340);
    expect(evaluateHighTrigger(input(r, [bolus(3, NOW - 10 * 60_000)]))).toBeNull();
  });

  it("no fire when a meal is still absorbing (COB veto)", () => {
    const r = flat(340);
    expect(evaluateHighTrigger(input(r, [carbs(40, NOW - 20 * 60_000)]))).toBeNull();
  });

  it("no fire with too few readings", () => {
    expect(evaluateHighTrigger(input(flat(340, 2)))).toBeNull();
  });
});

describe("evaluateHighTrigger — fire case", () => {
  it("fires a direction-only pen correction when CIQ is saturated on a sustained high", () => {
    const a = evaluateHighTrigger(input(flat(340)));
    expect(a).not.toBeNull();
    expect(a!.rootCause).toBe("ciq_capped_high");
    expect(a!.actionType).toBe("correct_by_pen");
    expect(a!.actionClass).toBe("high_correction");
    // insulin is direction-only — never a unit count, never carb grams
    expect(a!.magnitudeGrams).toBeNull();
    expect(a!.headline).not.toMatch(/\d+\s*u\b/i);
    // Promoted 2026-07-01 → emits its actionable tier (routed to the parent device)
    expect(HIGH_TRIGGER_VALIDATED).toBe(true);
    expect(a!.tier).toBe("T2_actionable");
  });
});

describe("ciqHighRollout", () => {
  it("returns null for a too-short trail", () => {
    expect(ciqHighRollout([reading(340, NOW)], [], profile)).toBeNull();
  });

  it("projects a high forward and reports min/end BG", () => {
    const roll = ciqHighRollout(flat(340), [], profile)!;
    expect(roll).not.toBeNull();
    expect(roll.endBg).toBeGreaterThan(0);
    expect(roll.minBg).toBeLessThanOrEqual(340);
  });
});
