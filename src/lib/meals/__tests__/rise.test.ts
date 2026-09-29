import { describe, it, expect } from "vitest";
import {
  LOW_RECOVERY_MIN,
  RISE_MIN_DELTA_MGDL,
  RISE_MIN_READINGS,
  detectRise,
} from "../rise-detector";
import type { GlucoseReading } from "@/lib/types";

const MIN = 60_000;
const NOW = Date.parse("2026-09-04T17:00:00.000Z");

/** A reading `agoMin` minutes before NOW. */
function r(agoMin: number, sgv: number, over: Partial<GlucoseReading> = {}): GlucoseReading {
  const date = NOW - agoMin * MIN;
  return {
    _id: `e-${agoMin}`,
    sgv,
    date,
    dateString: new Date(date).toISOString(),
    direction: "Flat",
    trend: 4,
    device: "test",
    type: "sgv",
    mills: date,
    ...over,
  };
}

/** Six readings 5 minutes apart, from `start` rising by `step` each. */
function ramp(start: number, step: number): GlucoseReading[] {
  return [25, 20, 15, 10, 5, 0].map((ago, i) => r(ago, start + i * step));
}

describe("detectRise", () => {
  it("fires on a 30 mg/dL rise over 30 minutes", () => {
    const rise = detectRise(ramp(120, 8), NOW); // 120 -> 160 = +40
    expect(rise).not.toBeNull();
    expect(rise!.fromMgdl).toBe(120);
    expect(rise!.toMgdl).toBe(160);
    expect(rise!.deltaMgdl).toBe(40);
    expect(rise!.detectedAt).toBe(NOW);
    expect(rise!.fromAt).toBe(NOW - 25 * MIN);
  });

  it("does not fire just below the threshold", () => {
    // 5 steps of 5 = +25, under the 30 mg/dL floor (decision 3a).
    expect(detectRise(ramp(120, 5), NOW)).toBeNull();
  });

  it("fires exactly at the threshold", () => {
    const readings = [...ramp(120, 0)];
    readings[readings.length - 1] = r(0, 120 + RISE_MIN_DELTA_MGDL);
    const rise = detectRise(readings, NOW);
    expect(rise?.deltaMgdl).toBe(RISE_MIN_DELTA_MGDL);
  });

  it("does not fire on a flat trace", () => {
    expect(detectRise(ramp(120, 0), NOW)).toBeNull();
  });

  it("does not fire on a falling trace", () => {
    expect(detectRise(ramp(200, -10), NOW)).toBeNull();
  });

  it("returns null for an empty or short series", () => {
    expect(detectRise([], NOW)).toBeNull();
    expect(detectRise([r(10, 100), r(5, 140), r(0, 160)], NOW)).toBeNull();
  });

  it("requires a reading quorum: a gap with two samples cannot fire", () => {
    // Only the 30-min and the current reading survive — a 40 mg/dL "rise" that
    // is really 30 minutes of missing trace.
    const readings = [r(30, 120), r(0, 160)];
    expect(detectRise(readings, NOW)).toBeNull();
    expect(RISE_MIN_READINGS).toBe(4);
  });

  it("ignores sensor-error sentinels rather than reading them as a rise", () => {
    // sgv 5 is a Dexcom fault code; treated as a value it manufactures a
    // 155 mg/dL rise out of nothing.
    const readings = [r(25, 5), r(20, 5), r(15, 158), r(10, 159), r(5, 160), r(0, 160)];
    expect(detectRise(readings, NOW)).toBeNull();
  });

  it("ignores an out-of-range value above 600", () => {
    const readings = ramp(120, 8);
    readings[2] = r(15, 900);
    // The remaining 5 valid readings still describe the +40 rise.
    expect(detectRise(readings, NOW)?.deltaMgdl).toBe(40);
  });

  it("drops invalid samples but still fires when the quorum holds", () => {
    const readings = ramp(120, 8);
    readings[1] = r(20, 0); // sentinel
    const rise = detectRise(readings, NOW);
    expect(rise).not.toBeNull();
    expect(rise!.fromMgdl).toBe(120);
  });

  it("only measures inside the window", () => {
    // A 60 mg/dL climb that finished 40 minutes ago is not a current rise.
    const readings = [r(60, 100), r(55, 130), r(50, 160), r(45, 160), r(40, 160), r(0, 160)];
    expect(detectRise(readings, NOW)).toBeNull();
  });

  it("ignores readings after `now` (a device clock ahead)", () => {
    const readings = [...ramp(120, 0), r(-10, 300)];
    expect(detectRise(readings, NOW)).toBeNull();
  });

  it("skips a rise that starts inside the low-recovery window", () => {
    // 70 mg/dL twenty minutes before the window start: this is juice working,
    // and the rescue-carb detector already infers those carbs.
    const readings = [r(45, 70), ...ramp(120, 8)];
    expect(detectRise(readings, NOW)).toBeNull();
  });

  it("fires when the low is older than the low-recovery window", () => {
    const readings = [r(25 + LOW_RECOVERY_MIN + 5, 70), ...ramp(120, 8)];
    expect(detectRise(readings, NOW)).not.toBeNull();
  });

  it("skips a rise that starts after an inferred rescue event", () => {
    const readings = ramp(120, 8);
    const rescueAt = NOW - 40 * MIN; // within 45 min of the window start
    expect(detectRise(readings, NOW, { rescueEvents: [rescueAt] })).toBeNull();
  });

  it("ignores an inferred rescue event outside the recovery window", () => {
    const readings = ramp(120, 8);
    const rescueAt = NOW - (25 + LOW_RECOVERY_MIN + 10) * MIN;
    expect(detectRise(readings, NOW, { rescueEvents: [rescueAt] })).not.toBeNull();
  });

  it("honours option overrides", () => {
    const readings = ramp(120, 5); // +25
    expect(detectRise(readings, NOW, { minDeltaMgdl: 20 })).not.toBeNull();
    expect(detectRise(readings, NOW, { minReadings: 99 })).toBeNull();
  });

  it("returns null for a non-finite now", () => {
    expect(detectRise(ramp(120, 8), Number.NaN)).toBeNull();
  });
});
