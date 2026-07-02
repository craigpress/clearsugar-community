import { describe, it, expect } from "vitest";
import { attributeResolution } from "../feedback-store";
import type {
  AdvisoryAction,
  FeedbackRecord,
  AdvisorRootCause,
} from "../advisor-types";
import type { GlucoseReading, Treatment } from "../../types";

const FIRED = 1_000_000_000_000; // arbitrary epoch ms
const MIN = 60_000;

function advisory(rootCause: AdvisorRootCause): AdvisoryAction {
  return {
    id: rootCause,
    actionType: "carbs",
    actionClass: "low_carbs",
    rootCause,
    tier: "T2_actionable",
    severity: "moderate",
    leadTimeMin: 20,
    orElse: "test",
    magnitudeGrams: 10,
    headline: "test",
    confidence: 0.8,
    staleness: { pumpStaleMin: null, cgmStaleMin: null },
    evidence: [],
    generatedAt: FIRED,
  };
}

function record(rootCause: AdvisorRootCause): FeedbackRecord {
  return {
    actionId: rootCause,
    firedAt: FIRED,
    advisory: advisory(rootCause),
    ciqMode: null,
    humanResponse: "no_response",
    outcomeTrajectory: [],
    resolutionAttribution: "unresolved",
    harvestedAt: null,
  };
}

function reading(sgv: number, offsetMin: number): GlucoseReading {
  const date = FIRED + offsetMin * MIN;
  return {
    _id: `${date}-${sgv}`,
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

function carbTreatment(grams: number, offsetMin: number): Treatment {
  const date = FIRED + offsetMin * MIN;
  return {
    _id: `carb-${date}`,
    eventType: "Carb Correction",
    created_at: new Date(date).toISOString(),
    enteredBy: "test",
    mills: date,
    utcOffset: 0,
    carbs: grams,
  };
}

function manualCorrection(units: number, offsetMin: number): Treatment {
  const date = FIRED + offsetMin * MIN;
  return {
    _id: `bolus-${date}`,
    eventType: "Correction Bolus",
    created_at: new Date(date).toISOString(),
    enteredBy: "test",
    mills: date,
    utcOffset: 0,
    insulin: units,
  };
}

function siteChange(offsetMin: number): Treatment {
  const date = FIRED + offsetMin * MIN;
  return {
    _id: `site-${date}`,
    eventType: "Site Change",
    created_at: new Date(date).toISOString(),
    enteredBy: "test",
    mills: date,
    utcOffset: 0,
  };
}

function ciqBasal(offsetMin: number, rate = 0.5): Treatment {
  const date = FIRED + offsetMin * MIN;
  return {
    _id: `basal-${date}`,
    eventType: "Temp Basal",
    created_at: new Date(date).toISOString(),
    enteredBy: "loop",
    mills: date,
    utcOffset: 0,
    reason: "Algorithm",
    rate,
    duration: 5,
  };
}

describe("attributeResolution", () => {
  it("human_acted: low + rescue carbs + BG recovers", () => {
    const rec = record("impending_low");
    const readings = [reading(72, 5), reading(68, 15), reading(85, 35)];
    const treatments = [carbTreatment(15, 10), ciqBasal(5)]; // carbs present, algo basal too
    const { attribution, trajectory } = attributeResolution(rec, readings, treatments);
    expect(attribution).toBe("human_acted");
    // trajectory only contains points strictly after firedAt within 3h
    expect(trajectory.map((p) => p.sgv)).toEqual([72, 68, 85]);
  });

  it("human_acted (high): manual correction + BG drops back toward range", () => {
    const rec = record("ciq_capped_high");
    const readings = [reading(240, 10), reading(210, 40), reading(175, 90)];
    const treatments = [manualCorrection(2, 5), ciqBasal(20, 1.2)];
    const { attribution } = attributeResolution(rec, readings, treatments);
    expect(attribution).toBe("human_acted");
  });

  it("human_acted (failing_site): site change + correction, BG drops", () => {
    const rec = record("failing_site");
    const readings = [reading(250, 10), reading(190, 60), reading(170, 120)];
    const treatments = [siteChange(15), manualCorrection(3, 20)];
    const { attribution } = attributeResolution(rec, readings, treatments);
    expect(attribution).toBe("human_acted");
  });

  it("ciq_absorbed: low materializes, NO human carbs, algo basals, BG recovers", () => {
    const rec = record("impending_low");
    // BG actually dips below 70 (outcome materialized), then Control-IQ
    // suspends/reduces basal and it climbs back above 80 — no human treatment.
    const readings = [reading(66, 5), reading(72, 15), reading(92, 40)];
    const treatments = [ciqBasal(5, 0), ciqBasal(10, 0)];
    const { attribution } = attributeResolution(rec, readings, treatments);
    expect(attribution).toBe("ciq_absorbed");
  });

  it("ciq_absorbed is NOT credited when a relevant human action exists", () => {
    // Same materializing low, but now a human ate carbs — must attribute to
    // human, never to CIQ, even though algo basals are also present.
    const rec = record("impending_low");
    const readings = [reading(66, 5), reading(90, 30)];
    const treatments = [carbTreatment(12, 8), ciqBasal(5, 0)];
    const { attribution } = attributeResolution(rec, readings, treatments);
    expect(attribution).toBe("human_acted");
  });

  it("false_alarm_self_resolved: predicted low never materialized, no action", () => {
    const rec = record("impending_low");
    // BG never drops below 70 and no human treatment; algo basals may exist but
    // the bad outcome simply never happened.
    const readings = [reading(95, 10), reading(102, 40), reading(110, 90)];
    const treatments = [ciqBasal(5)];
    const { attribution } = attributeResolution(rec, readings, treatments);
    expect(attribution).toBe("false_alarm_self_resolved");
  });

  it("unresolved: low materialized and persisted, no action, no recovery", () => {
    const rec = record("impending_low");
    const readings = [reading(65, 10), reading(58, 40), reading(55, 90)];
    const treatments: Treatment[] = []; // nobody acted, CIQ did not rescue
    const { attribution } = attributeResolution(rec, readings, treatments);
    expect(attribution).toBe("unresolved");
  });

  it("unresolved: high persisted despite algo basals (no return toward range)", () => {
    const rec = record("ciq_capped_high");
    const readings = [reading(260, 10), reading(265, 60), reading(270, 120)];
    const treatments = [ciqBasal(15, 1.5), ciqBasal(30, 1.5)];
    const { attribution } = attributeResolution(rec, readings, treatments);
    expect(attribution).toBe("unresolved");
  });

  it("ignores treatments and readings outside the (firedAt, +3h] window", () => {
    const rec = record("impending_low");
    // carb BEFORE fire and carb AFTER 3h must both be ignored → no human action.
    // BG dips below 70 (materializes) then recovers, with only an algo basal in
    // window → ciq_absorbed.
    const readings = [reading(64, 30), reading(85, 60)];
    const treatments = [
      carbTreatment(15, -10), // before fire
      carbTreatment(15, 200), // after 3h (=180m)
      ciqBasal(20, 0),
    ];
    const { attribution } = attributeResolution(rec, readings, treatments);
    expect(attribution).toBe("ciq_absorbed");
  });

  it("sub-5g carbs do not count as a rescue (CIQ gets the credit)", () => {
    const rec = record("impending_low");
    const readings = [reading(66, 5), reading(88, 30)]; // materializes <70, recovers
    const treatments = [carbTreatment(3, 8), ciqBasal(5, 0)]; // 3g < 5g min
    const { attribution } = attributeResolution(rec, readings, treatments);
    expect(attribution).toBe("ciq_absorbed");
  });
});
