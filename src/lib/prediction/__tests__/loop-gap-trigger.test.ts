import { describe, it, expect } from "vitest";
import {
  evaluateLowTrigger,
  ciqOptimisticRollout,
  compressionVeto,
  warmupVeto,
} from "../loop-gap-trigger";
import type { GlucoseReading, Treatment, PumpProfile } from "../../types";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SEG = (value: number) => [{ time: "00:00", value, timeAsSeconds: 0 }];

const profile: PumpProfile = {
  _id: "p",
  defaultProfile: "Default",
  store: {
    Default: {
      dia: 5,
      carbratio: SEG(10),
      sens: SEG(70), // flat ISF 70 (matches the fitted profile)
      basal: SEG(1.0),
      target_low: SEG(100),
      target_high: SEG(120),
      timezone: "America/New_York",
      units: "mg/dl",
    },
  },
};

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

const FIVE = 5 * 60_000;
// Fixed anchor: 04:00 EDT (night window) so tier/severity are deterministic.
const NOW = Date.UTC(2026, 5, 19, 8, 0, 0);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("evaluateLowTrigger — validated loop-gap low trigger", () => {
  it("FIRES with a carbs action on a steadily-falling series backed by insulin", () => {
    // 124 -> 88 over 30 min (ROC ~ -6 mg/dL/5min), driven by a recent 6u bolus
    // so the momentum-free CIQ rollout still ends low even with basal suspended.
    // Ends at 88, under MAX_TRIGGER_BG: from 95 this no longer fires, because a
    // 30-min slope extrapolation from that far out is noise 75% of the time.
    const readings: GlucoseReading[] = [];
    for (let i = 6; i >= 0; i--) readings.push(reading(88 + i * 6, NOW - i * FIVE));
    const treatments = [bolus(6, NOW - 10 * 60_000)];

    const action = evaluateLowTrigger({ readings, treatments, profile, now: NOW });

    expect(action).not.toBeNull();
    expect(action!.actionType).toBe("carbs");
    expect(action!.actionClass).toBe("low_carbs");
    expect(action!.rootCause).toBe("impending_low");
    expect(action!.magnitudeGrams).not.toBeNull();
    expect(action!.magnitudeGrams!).toBeGreaterThan(0);
    expect(action!.leadTimeMin).toBeGreaterThanOrEqual(0);
    expect(action!.leadTimeMin).toBeLessThanOrEqual(30);
    // severe projection => highest phone tier (T4). No house siren exists.
    expect(action!.tier).toBe("T4_critical");
    expect(action!.headline).toMatch(/fast carbs now/);
    expect(action!.orElse).toMatch(/basal off/);
    expect(action!.evidence.length).toBeGreaterThan(0);
  });

  it("returns null on a flat in-range series (no ROC alert)", () => {
    const readings: GlucoseReading[] = [];
    for (let i = 6; i >= 0; i--) readings.push(reading(120, NOW - i * FIVE));

    const action = evaluateLowTrigger({ readings, treatments: [], profile, now: NOW });
    expect(action).toBeNull();
  });

  it("SUPPRESSES (gate) a falling ROC trend that has no insulin behind it", () => {
    // Same falling shape, but NO bolus: the momentum-free optimistic-CIQ rollout
    // stays flat at the current BG (>=70), so the saturation gate suppresses.
    const readings: GlucoseReading[] = [];
    for (let i = 6; i >= 0; i--) readings.push(reading(88 + i * 6, NOW - i * FIVE));

    const action = evaluateLowTrigger({ readings, treatments: [], profile, now: NOW });
    expect(action).toBeNull();
    // gate floor stays at the (in-range) current value
    expect(ciqOptimisticRollout(readings, [], profile, 30)).toBeGreaterThanOrEqual(70);
  });

  // ── Specificity gates added 2026-07-28 (see the constants in the module) ────

  it("STAYS SILENT once BG is already below the threshold", () => {
    // A dead-flat 52 with no insulin at all. Before this gate existed the
    // trigger fired T4_critical here with lead time 0 and an orElse that read
    // "Heading to ~52" — a prediction of the reading it was handed. The event
    // is already covered by the Dexcom alarm, the server urgentLow push, the
    // iOS backstop and HA's ungated urgent_low; a fifth alert adds nothing but
    // noise, on the one emitter that ignores snooze.
    const flat: GlucoseReading[] = [];
    for (let i = 11; i >= 0; i--) flat.push(reading(52, NOW - i * FIVE));

    expect(evaluateLowTrigger({ readings: flat, treatments: [], profile, now: NOW })).toBeNull();
  });

  it("STAYS SILENT above MAX_TRIGGER_BG even on a steep qualifying slope", () => {
    // 145 -> 109, ROC ~ -6/5min, with a large bolus behind it: the ROC base and
    // the saturation gate both pass, but 109 is too far out for a 30-min slope
    // extrapolation to carry information (84% of such fires were false).
    const readings: GlucoseReading[] = [];
    for (let i = 6; i >= 0; i--) readings.push(reading(109 + i * 6, NOW - i * FIVE));
    const treatments = [bolus(8, NOW - 10 * 60_000)];

    expect(evaluateLowTrigger({ readings, treatments, profile, now: NOW })).toBeNull();
  });

  it("TIERS T4 only when BOTH projections agree the low is severe", () => {
    // Falls from 88 on a modest bolus. The ROC line extrapolates under 55, but
    // the CIQ-optimistic (basal-suspended) path does not — so this is an alert,
    // not a wake. Under the old min() rule the ROC line alone won T4.
    const readings: GlucoseReading[] = [];
    for (let i = 6; i >= 0; i--) readings.push(reading(88 + i * 7, NOW - i * FIVE));
    const treatments = [bolus(2.2, NOW - 25 * 60_000)];

    const action = evaluateLowTrigger({ readings, treatments, profile, now: NOW });
    if (action) {
      const rocMin = Math.min(88, 88 - 7 * 6);
      const ciqMin = ciqOptimisticRollout(readings, treatments, profile, 30)!;
      const bothSevere = Math.max(rocMin, ciqMin) < 55;
      expect(action.tier).toBe(bothSevere ? "T4_critical" : "T2_actionable");
      expect(action.severity).toBe(bothSevere ? "urgent" : "moderate");
    }
  });

  it("VETOES a compression-low artifact (sharp isolated drop from a stable window)", () => {
    // ~120 stable for 30+ min (CV<10%), then a sudden >40 mg/dL drop to 60.
    const comp: GlucoseReading[] = [];
    for (let i = 10; i >= 3; i--) comp.push(reading(120 + (i % 2), NOW - i * FIVE));
    comp.push(reading(118, NOW - 2 * FIVE));
    comp.push(reading(70, NOW - 1 * FIVE));
    comp.push(reading(60, NOW));

    // The artifact would otherwise trip ROC + gate (recent bolus present), but
    // the compression veto must suppress the wake.
    const treatments = [bolus(4, NOW - 10 * 60_000)];
    const action = evaluateLowTrigger({ readings: comp, treatments, profile, now: NOW });
    expect(action).toBeNull();
    expect(compressionVeto(comp)).toBe(true);
  });
});

describe("ciqOptimisticRollout — basal-suspension saturation gate", () => {
  it("lifts the trajectory: suspending basal yields a >= as-delivered floor", () => {
    const readings: GlucoseReading[] = [];
    for (let i = 6; i >= 0; i--) readings.push(reading(95 + i * 6, NOW - i * FIVE));
    const treatments = [bolus(6, NOW - 10 * 60_000)];

    const floor = ciqOptimisticRollout(readings, treatments, profile, 30);
    expect(floor).not.toBeNull();
    // even the optimistic (basal-off) path still ends low here -> alert is valid
    expect(floor!).toBeLessThan(70);
  });

  it("returns null when the trail is too short to project", () => {
    expect(ciqOptimisticRollout([reading(100, NOW)], [], profile, 30)).toBeNull();
  });
});

describe("veto primitives", () => {
  it("warmupVeto flags an implausible single-step jump", () => {
    const r = [reading(130, NOW - FIVE), reading(40, NOW)]; // 90 mg/dL in 5 min
    expect(warmupVeto(r)).toBe(true);
  });

  it("compressionVeto is false for an orderly decline", () => {
    const r: GlucoseReading[] = [];
    for (let i = 8; i >= 0; i--) r.push(reading(120 - (8 - i) * 5, NOW - i * FIVE));
    expect(compressionVeto(r)).toBe(false);
  });
});
