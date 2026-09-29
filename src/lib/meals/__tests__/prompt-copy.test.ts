import { describe, it, expect } from "vitest";
import {
  MEAL_PROMPT_CATEGORY,
  bolusPromptCopy,
  formatCarbs,
  formatClockTime,
  formatInsulin,
  promptCopy,
  promptUserInfo,
  risePromptCopy,
} from "../prompt-copy";
import type { MealEpisode } from "../types";

const MIN = 60_000;
// 18:14 UTC = 2:14 pm America/New_York (EDT), the plan's example.
const BOLUS_AT = Date.parse("2026-09-04T18:14:00.000Z");
const RISE_AT = Date.parse("2026-09-04T16:40:00.000Z"); // 12:40 pm ET

function episode(over: Partial<MealEpisode> = {}): MealEpisode {
  return {
    id: "ep-1",
    openedAt: BOLUS_AT,
    expiresAt: BOLUS_AT + 120 * MIN,
    trigger: "pump_bolus",
    status: "open",
    promptCount: 0,
    shadow: false,
    ...over,
  };
}

describe("formatClockTime", () => {
  it("formats in the patient's timezone, lowercase, plain ASCII", () => {
    const s = formatClockTime(BOLUS_AT);
    expect(s).toBe("2:14 pm");
    expect(/^[\x20-\x7e]+$/.test(s)).toBe(true);
  });

  it("handles midnight and noon", () => {
    expect(formatClockTime(Date.parse("2026-09-04T04:00:00.000Z"))).toBe("12:00 am");
    expect(formatClockTime(Date.parse("2026-09-04T16:00:00.000Z"))).toBe("12:00 pm");
  });

  it("returns an empty string for a non-finite input", () => {
    expect(formatClockTime(Number.NaN)).toBe("");
  });
});

describe("formatInsulin / formatCarbs", () => {
  it("formats one decimal of insulin and whole grams", () => {
    expect(formatInsulin(6.2)).toBe("6.2 u");
    expect(formatInsulin(6)).toBe("6.0 u");
    expect(formatCarbs(55)).toBe("55 g");
    expect(formatCarbs(54.6)).toBe("55 g");
  });

  it("returns null for absent or non-positive values", () => {
    expect(formatInsulin(undefined)).toBeNull();
    expect(formatInsulin(0)).toBeNull();
    expect(formatCarbs(undefined)).toBeNull();
    expect(formatCarbs(0)).toBeNull();
  });
});

describe("bolusPromptCopy", () => {
  it("quotes the bolus's own local time (the pump path is ~50 min late)", () => {
    const copy = bolusPromptCopy(
      episode({ bolusAt: BOLUS_AT, bolusInsulin: 6.2, bolusCarbs: 55 })
    );
    expect(copy.body).toBe("2:14 pm bolus, 6.2 u for 55 g. What did you eat?");
    expect(copy.title).toBe("Meal check");
  });

  it("never says 'now' or 'just now'", () => {
    const copy = bolusPromptCopy(
      episode({ bolusAt: BOLUS_AT, bolusInsulin: 6.2, bolusCarbs: 55 })
    );
    expect(copy.body.toLowerCase()).not.toContain("just now");
  });

  it("degrades when the pump document is missing carbs or insulin", () => {
    expect(bolusPromptCopy(episode({ bolusAt: BOLUS_AT, bolusInsulin: 6.2 })).body).toBe(
      "2:14 pm bolus, 6.2 u. What did you eat?"
    );
    expect(bolusPromptCopy(episode({ bolusAt: BOLUS_AT, bolusCarbs: 55 })).body).toBe(
      "2:14 pm bolus, 55 g. What did you eat?"
    );
    expect(bolusPromptCopy(episode({ bolusAt: BOLUS_AT })).body).toBe(
      "2:14 pm bolus. What did you eat?"
    );
  });

  it("falls back to openedAt when bolusAt is missing", () => {
    expect(bolusPromptCopy(episode()).body).toContain("2:14 pm");
  });
});

describe("risePromptCopy", () => {
  it("names the moment the trace turned up, not the moment we noticed", () => {
    const copy = risePromptCopy(
      episode({
        trigger: "glucose_rise",
        riseSinceAt: RISE_AT,
        riseDetectedAt: RISE_AT + 30 * MIN,
        riseFromMgdl: 118,
        riseToMgdl: 158,
      })
    );
    expect(copy.body).toBe("Rising since 12:40 pm. Did you eat something?");
    expect(copy.title).toBe("Glucose rising");
  });

  it("falls back to the detection point when the window start is absent", () => {
    const copy = risePromptCopy(
      episode({ trigger: "glucose_rise", riseDetectedAt: RISE_AT })
    );
    expect(copy.body).toContain("12:40 pm");
  });
});

describe("promptCopy / promptUserInfo", () => {
  it("routes by prompt kind", () => {
    const ep = episode({ bolusAt: BOLUS_AT, bolusInsulin: 3, bolusCarbs: 20 });
    expect(promptCopy(ep, "bolus").body).toContain("bolus");
    expect(promptCopy(ep, "rise").body).toContain("Rising since");
  });

  it("carries flat primitive keys the iOS reply action needs", () => {
    const info = promptUserInfo(
      episode({ bolusAt: BOLUS_AT, bolusInsulin: 6.2, bolusCarbs: 55 }),
      "bolus"
    );
    expect(info).toMatchObject({
      kind: "meal_prompt",
      episodeId: "ep-1",
      trigger: "pump_bolus",
      promptKind: "bolus",
      bolusAt: BOLUS_AT,
      carbs: 55,
      insulin: 6.2,
    });
    expect(Object.values(info).every((v) => typeof v !== "object")).toBe(true);
  });

  it("carries riseSince for a rise prompt and omits absent fields", () => {
    const info = promptUserInfo(
      episode({ trigger: "glucose_rise", riseSinceAt: RISE_AT, riseDetectedAt: RISE_AT + 30 * MIN }),
      "rise"
    );
    expect(info.riseSince).toBe(RISE_AT);
    expect(info).not.toHaveProperty("carbs");
    expect(info).not.toHaveProperty("bolusAt");
  });

  it("uses the MEAL_PROMPT category the iOS app registers", () => {
    expect(MEAL_PROMPT_CATEGORY).toBe("MEAL_PROMPT");
  });
});
