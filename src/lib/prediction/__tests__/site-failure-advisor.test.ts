import { describe, it, expect } from "vitest";
import { evaluateSiteFailure } from "../site-failure-advisor";
import { calculateIOB } from "../physiological-model";
import type { GlucoseReading, Treatment, PumpProfile } from "../../types";

const MIN = 60_000;
const NOW = 1_700_000_000_000;

// Flat profile: ISF 70, scheduled basal 1.0 u/hr, DIA 5h (matches the validated
// Python operating point — profile_isf_sample 70.0).
const profile: PumpProfile = {
  _id: "p",
  defaultProfile: "Default",
  store: {
    Default: {
      dia: 5,
      carbratio: [{ time: "00:00", value: 10, timeAsSeconds: 0 }],
      sens: [{ time: "00:00", value: 70, timeAsSeconds: 0 }],
      basal: [{ time: "00:00", value: 1.0, timeAsSeconds: 0 }],
      target_low: [{ time: "00:00", value: 100, timeAsSeconds: 0 }],
      target_high: [{ time: "00:00", value: 120, timeAsSeconds: 0 }],
      timezone: "America/New_York",
      units: "mg/dl",
    },
  },
};

function reading(sgv: number, date: number): GlucoseReading {
  return {
    _id: `r-${date}`,
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

function tempBasal(rate: number, startMinFromNow: number, durationMin: number): Treatment {
  const mills = NOW + startMinFromNow * MIN;
  return {
    _id: `tb-${startMinFromNow}`,
    eventType: "Temp Basal",
    created_at: new Date(mills).toISOString(),
    enteredBy: "ciq",
    mills,
    utcOffset: 0,
    absolute: rate,
    rate,
    duration: durationMin,
  };
}

function carbTreatment(grams: number, atMinFromNow: number): Treatment {
  const mills = NOW + atMinFromNow * MIN;
  return {
    _id: `carb-${atMinFromNow}`,
    eventType: "Carb Correction",
    created_at: new Date(mills).toISOString(),
    enteredBy: "user",
    mills,
    utcOffset: 0,
    carbs: grams,
  };
}

/** Readings every 5 min from `startMinFromNow` to now, linearly from bgStart→bgEnd. */
function risingReadings(
  bgStart: number,
  bgEnd: number,
  startMinFromNow: number
): GlucoseReading[] {
  const out: GlucoseReading[] = [];
  const span = -startMinFromNow;
  for (let m = startMinFromNow; m <= 0; m += 5) {
    const frac = (m - startMinFromNow) / span;
    out.push(reading(Math.round(bgStart + (bgEnd - bgStart) * frac), NOW + m * MIN));
  }
  return out;
}

/** Control-IQ high-temp basals (6 u/hr vs 1.0 scheduled) in 30-min chunks. */
function ciqHighTempBasals(startMinFromNow: number): Treatment[] {
  const out: Treatment[] = [];
  for (let m = startMinFromNow; m < 0; m += 30) {
    out.push(tempBasal(6.0, m, 30));
  }
  return out;
}

describe("evaluateSiteFailure", () => {
  it("fires the change_site advisory AND vetoes on the June-12-style archetype (BG 220→300 despite temp-basal delivery, not dropping across 3+ windows)", () => {
    const readings = risingReadings(220, 300, -150);
    const treatments = ciqHighTempBasals(-180);

    const res = evaluateSiteFailure({ readings, treatments, profile, now: NOW });

    expect(res.veto).toBe(true);
    expect(res.advisory).not.toBeNull();
    const a = res.advisory!;
    expect(a.actionType).toBe("change_site");
    expect(a.actionClass).toBe("site_change");
    expect(a.rootCause).toBe("failing_site");
    expect(a.tier).toBe("T3_urgent");
    // NEVER an insulin number — direction only.
    expect(a.magnitudeGrams).toBeNull();
    expect(a.leadTimeMin).toBeGreaterThan(0);
    expect(a.orElse).toContain("isn't absorbing");
    expect(a.headline).toContain("Consider a site change");
    expect(a.evidence.length).toBeGreaterThan(0);

    // Guard: delivered_in_window is load-bearing. With CIQ pushing high temp
    // basals during the high, IOB(t1) > IOB(t0) — so a naive IOB(t0)−IOB(t1)
    // delta is NEGATIVE (would score 0 absorbed and miss the failure). Our
    // absorbed measure must be meaningfully positive instead.
    const t1 = NOW;
    const t0 = NOW - 30 * MIN;
    const iobDelta = calculateIOB(treatments, profile, t0) - calculateIOB(treatments, profile, t1);
    expect(iobDelta).toBeLessThan(0); // naive delta misses it
  });

  it("does NOT fire when a recent announced carb is present (meal veto: recent_carb)", () => {
    const readings = risingReadings(220, 300, -150);
    // Same failing-site shape, but a 30g carb treatment 60 min ago → recent_carb veto.
    const treatments = [...ciqHighTempBasals(-180), carbTreatment(30, -60)];

    const res = evaluateSiteFailure({ readings, treatments, profile, now: NOW });

    expect(res.advisory).toBeNull();
    expect(res.veto).toBe(false);
  });

  it("does NOT fire on rising BG with NO insulin delivery (no meaningful absorbed insulin — unannounced carbs are not vetoed by a pre-rise but fail the deficit's meaningful-insulin gate)", () => {
    const readings = risingReadings(220, 300, -150);
    // Rapid rise, but only scheduled basal (no high temp basals, no boluses).
    // Confirms there is NO pre-rise veto: the rise alone neither fires nor is
    // it suppressed by a pre-rise rule — it simply lacks meaningful absorbed
    // insulin, so the deficit gate (expected_drop ≥ 40) is never met.
    const treatments: Treatment[] = [];

    const res = evaluateSiteFailure({ readings, treatments, profile, now: NOW });

    expect(res.advisory).toBeNull();
    expect(res.veto).toBe(false);
  });

  it("returns veto:false, advisory:null when in range and stable", () => {
    const readings = risingReadings(120, 120, -150); // flat, in-range
    const treatments = ciqHighTempBasals(-180);

    const res = evaluateSiteFailure({ readings, treatments, profile, now: NOW });

    expect(res.veto).toBe(false);
    expect(res.advisory).toBeNull();
  });

  it("vetoes conservatively on a single strong current-window deficit even before 3 windows accumulate", () => {
    // Only ~60 min of failing-site signal: enough for the current window to
    // vote (veto=true) but short of the 3-consecutive-window advisory rule.
    const readings = risingReadings(220, 280, -60);
    const treatments = ciqHighTempBasals(-90);

    const res = evaluateSiteFailure({ readings, treatments, profile, now: NOW });

    expect(res.veto).toBe(true);
    expect(res.advisory).toBeNull();
  });

  it("returns veto:false, advisory:null with insufficient readings", () => {
    const res = evaluateSiteFailure({
      readings: [reading(250, NOW)],
      treatments: ciqHighTempBasals(-180),
      profile,
      now: NOW,
    });
    expect(res.veto).toBe(false);
    expect(res.advisory).toBeNull();
  });
});
