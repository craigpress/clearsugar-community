import { describe, it, expect } from "vitest";
import { compareIob, summarize, MAX_SAMPLE_AGE_MS } from "../iob-calibration";
import type { IobCalSample } from "../iob-calibration";
import { calculateIOB } from "../physiological-model";
import type { Treatment, PumpProfile, PumpState } from "../../types";

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

function pumpState(iobU: number | null, atMills: number): PumpState {
  return {
    device: "clearsugar-pumpstate",
    created_at: new Date(atMills).toISOString(),
    mills: atMills,
    pump: {
      iob:
        iobU === null
          ? null
          : { iob: iobU, timestamp: new Date(atMills).toISOString(), mills: atMills },
    },
    controlIQ: {},
  };
}

const NOW = Date.UTC(2026, 6, 1, 12, 0, 0);

describe("compareIob", () => {
  it("returns null when there is no pump-state or no pump IOB", () => {
    expect(compareIob(null, [], profile, NOW)).toBeNull();
    expect(compareIob(pumpState(null, NOW), [], profile, NOW)).toBeNull();
  });

  it("returns null when the pump sample is older than the coverage cap", () => {
    const old = NOW - MAX_SAMPLE_AGE_MS - 60_000;
    expect(compareIob(pumpState(1, old), [], profile, NOW)).toBeNull();
  });

  it("returns null for a future-dated pump sample", () => {
    expect(compareIob(pumpState(1, NOW + 5 * 60_000), [], profile, NOW)).toBeNull();
  });

  it("computes bias = computed − pump at the pump timestamp", () => {
    const at = NOW - 30 * 60_000; // 30 min ago, within coverage
    const treatments = [bolus(4, at - 10 * 60_000)]; // a 4u bolus 10 min before the sample
    const expectedComputed = calculateIOB(treatments, profile, at);
    const s = compareIob(pumpState(3.0, at), treatments, profile, NOW)!;
    expect(s).not.toBeNull();
    expect(s.atMills).toBe(at);
    expect(s.pumpIob).toBe(3);
    expect(s.computedIob).toBeCloseTo(expectedComputed, 3);
    expect(s.biasU).toBeCloseTo(expectedComputed - 3, 3);
    expect(s.biasPct).toBeCloseTo(((expectedComputed - 3) / 3) * 100, 1);
  });

  it("leaves biasPct null when pump IOB is ≈0", () => {
    const at = NOW - 10 * 60_000;
    const s = compareIob(pumpState(0, at), [], profile, NOW)!;
    expect(s.pumpIob).toBe(0);
    expect(s.biasPct).toBeNull();
  });
});

describe("summarize", () => {
  const mk = (biasU: number, atMills: number): IobCalSample => ({
    atMills,
    pumpIob: 2,
    computedIob: 2 + biasU,
    biasU,
    biasPct: (biasU / 2) * 100,
    recordedAt: atMills,
  });

  it("reports zeros for an empty set", () => {
    const s = summarize([]);
    expect(s.samples).toBe(0);
    expect(s.lastSample).toBeNull();
  });

  it("computes mean/median bias and carries the last sample", () => {
    const s = summarize([mk(0.2, 1), mk(-0.1, 2), mk(0.3, 3)]);
    expect(s.samples).toBe(3);
    expect(s.meanBiasU).toBeCloseTo((0.2 - 0.1 + 0.3) / 3, 3);
    expect(s.medianBiasU).toBeCloseTo(0.2, 3);
    expect(s.lastSample?.atMills).toBe(3);
  });
});
