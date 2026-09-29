import { describe, it, expect } from "vitest";
import {
  NO_REPLY_SUPPRESSION_MIN,
  applyReply,
  measuredMinutesBolusToEat,
  minutesFromEatTiming,
  pairEpisodeWithBolus,
  validateReplyInput,
} from "../pairing";
import type { MealEpisode } from "../types";
import type { Treatment } from "@/lib/types";

const MIN = 60_000;
const NOW = Date.parse("2026-09-04T18:00:00.000Z");

function episode(over: Partial<MealEpisode> = {}): MealEpisode {
  return {
    id: "ep-1",
    openedAt: NOW - 30 * MIN,
    expiresAt: NOW + 90 * MIN,
    trigger: "glucose_rise",
    status: "prompted",
    promptCount: 1,
    shadow: false,
    riseDetectedAt: NOW - 30 * MIN,
    ...over,
  };
}

function bolus(over: Partial<Treatment> = {}): Treatment {
  const at = NOW - 20 * MIN;
  return {
    _id: "t-1",
    eventType: "Meal Bolus",
    created_at: new Date(at).toISOString(),
    enteredBy: "tconnectsync",
    mills: at,
    utcOffset: 0,
    insulin: 6.2,
    carbs: 55,
    pump_event_id: "pump-1",
    ...over,
  };
}

describe("minutesFromEatTiming", () => {
  it("keeps inferred bolus matching and coarse reported timing distinguishable from timestamp differences", () => {
    const coarse = applyReply(episode(), { episodeId: "ep-1", kind: "chip", eatTiming: "60plus" }, NOW).episode;
    const paired = pairEpisodeWithBolus(coarse, bolus(), NOW);
    expect(paired).toMatchObject({ bolusLinkSource: "time_window", delaySource: "reported_category",
      minutesBolusToEat: 60, bolusInsulin: 6.2, bolusCarbs: 55, reply: { eatTiming: "60plus" } });
    const timed = pairEpisodeWithBolus({ ...coarse, eatingAt: NOW }, bolus(), NOW);
    expect(timed).toMatchObject({ delaySource: "reported_time_minus_pump_time", minutesBolusToEat: 20 });
  });
  it("maps every chip per the section-4c contract", () => {
    expect(minutesFromEatTiming("before_bolus")).toBe(-10);
    expect(minutesFromEatTiming("with_bolus")).toBe(0);
    expect(minutesFromEatTiming("5")).toBe(5);
    expect(minutesFromEatTiming("15")).toBe(15);
    expect(minutesFromEatTiming("30")).toBe(30);
    expect(minutesFromEatTiming("60plus")).toBe(60);
  });

  it("maps unknown and absent to null, never to 0", () => {
    expect(minutesFromEatTiming("unknown")).toBeNull();
    expect(minutesFromEatTiming(undefined)).toBeNull();
  });
});

describe("measuredMinutesBolusToEat", () => {
  it("measures a positive delay from an eating tap after the bolus", () => {
    expect(
      measuredMinutesBolusToEat({ bolusAt: NOW - 30 * MIN, eatingAt: NOW - 12 * MIN })
    ).toBe(18);
  });

  it("is negative when the patient ate before bolusing", () => {
    expect(
      measuredMinutesBolusToEat({ bolusAt: NOW, eatingAt: NOW - 7 * MIN })
    ).toBe(-7);
  });

  it("needs both timestamps", () => {
    expect(measuredMinutesBolusToEat({ bolusAt: NOW })).toBeNull();
    expect(measuredMinutesBolusToEat({ eatingAt: NOW })).toBeNull();
  });
});

describe("pairEpisodeWithBolus", () => {
  it("copies the pump facts and reconciles the episode", () => {
    const paired = pairEpisodeWithBolus(episode(), bolus(), NOW);
    expect(paired.status).toBe("reconciled");
    expect(paired.bolusId).toBe("t-1");
    expect(paired.pumpEventId).toBe("pump-1");
    expect(paired.bolusAt).toBe(NOW - 20 * MIN);
    expect(paired.bolusInsulin).toBe(6.2);
    expect(paired.bolusCarbs).toBe(55);
    expect(paired.reconciledAt).toBe(NOW);
  });

  it("does not mutate the input episode", () => {
    const ep = episode();
    pairEpisodeWithBolus(ep, bolus(), NOW);
    expect(ep.status).toBe("prompted");
    expect(ep.bolusId).toBeUndefined();
  });

  it("computes a measured delay once the bolus time is known", () => {
    const ep = episode({ trigger: "eating_now", eatingAt: NOW - 5 * MIN });
    const paired = pairEpisodeWithBolus(ep, bolus(), NOW);
    expect(paired.minutesBolusToEat).toBe(15); // ate 15 min after the bolus
  });

  it("falls back to the chip the patient already picked", () => {
    const ep = episode({
      status: "answered",
      reply: { kind: "chip", ateSomething: true, eatTiming: "30" },
    });
    const paired = pairEpisodeWithBolus(ep, bolus(), NOW);
    expect(paired.minutesBolusToEat).toBe(30);
    expect(paired.reply?.eatTiming).toBe("30");
  });

  it("prefers the measured delay over the chip", () => {
    const ep = episode({
      eatingAt: NOW - 10 * MIN,
      reply: { kind: "chip", ateSomething: true, eatTiming: "60plus" },
    });
    expect(pairEpisodeWithBolus(ep, bolus(), NOW).minutesBolusToEat).toBe(10);
  });

  it("falls back to created_at when mills is missing", () => {
    const at = NOW - 45 * MIN;
    const t = bolus({ mills: 0, created_at: new Date(at).toISOString() });
    expect(pairEpisodeWithBolus(episode(), t, NOW).bolusAt).toBe(at);
  });
});

describe("validateReplyInput", () => {
  it("accepts a minimal chip reply", () => {
    const res = validateReplyInput({ episodeId: "ep-1", kind: "chip", ateSomething: true });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.episodeId).toBe("ep-1");
  });

  it("rejects a non-object body", () => {
    expect(validateReplyInput("nope").ok).toBe(false);
    expect(validateReplyInput([]).ok).toBe(false);
    expect(validateReplyInput(null).ok).toBe(false);
  });

  it("reports every problem at once", () => {
    const res = validateReplyInput({ kind: "shout", eatTiming: "tomorrow" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects over-long text and trims whitespace-only text away", () => {
    expect(
      validateReplyInput({ episodeId: "e", kind: "text", text: "x".repeat(281) }).ok
    ).toBe(false);
    const res = validateReplyInput({ episodeId: "e", kind: "text", text: "   " });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.text).toBeUndefined();
  });

  it("requires a photoId for a photo reply", () => {
    expect(validateReplyInput({ episodeId: "e", kind: "photo" }).ok).toBe(false);
    expect(validateReplyInput({ episodeId: "e", kind: "photo", photoId: "p1" }).ok).toBe(
      true
    );
  });

  it("rejects a nutrition blob that is not an estimate", () => {
    expect(
      validateReplyInput({ episodeId: "e", kind: "text", nutrition: { carbs: 40 } }).ok
    ).toBe(false);
    const good = {
      carbs: { low: 30, mid: 40, high: 55 },
      confidence: 0.6,
      model: "m",
      provider: "openai-compatible",
      estimatedAt: NOW,
      rawResponse: "{}",
    };
    expect(
      validateReplyInput({ episodeId: "e", kind: "photo", photoId: "p", nutrition: good }).ok
    ).toBe(true);
    const fromPhone = validateReplyInput({ episodeId: "e", kind: "photo", photoId: "p",
      nutrition: { ...good, estimatedAt: new Date(NOW).toISOString(), estimateId: "d737e7bc-a183-45a4-9f2c-7ad076031d60" } });
    if (!fromPhone.ok) throw new Error("valid phone estimate rejected");
    expect(fromPhone.value.nutrition).toMatchObject({ estimatedAt: NOW, estimateId: "d737e7bc-a183-45a4-9f2c-7ad076031d60" });
  });
});

describe("applyReply", () => {
  it("marks an episode answered and keeps it open for reconciliation", () => {
    const { episode: next, riseSuppressedUntil } = applyReply(
      episode(),
      { episodeId: "ep-1", kind: "chip", ateSomething: true, bolused: false },
      NOW
    );
    expect(next.status).toBe("answered");
    expect(next.answeredAt).toBe(NOW);
    expect(next.reply?.bolused).toBe(false);
    expect(riseSuppressedUntil).toBeUndefined();
  });

  it("closes the episode and suppresses the rise trigger on a No", () => {
    const { episode: next, riseSuppressedUntil } = applyReply(
      episode(),
      { episodeId: "ep-1", kind: "chip", ateSomething: false },
      NOW
    );
    expect(next.status).toBe("closed");
    expect(next.reply?.ateSomething).toBe(false); // negative label kept
    expect(riseSuppressedUntil).toBe(NOW + NO_REPLY_SUPPRESSION_MIN * MIN);
  });

  it("treats a dismiss as a No", () => {
    const { episode: next, riseSuppressedUntil } = applyReply(
      episode(),
      { episodeId: "ep-1", kind: "dismiss" },
      NOW
    );
    expect(next.status).toBe("closed");
    expect(riseSuppressedUntil).toBe(NOW + NO_REPLY_SUPPRESSION_MIN * MIN);
  });

  it("maps the chip to minutesBolusToEat", () => {
    const { episode: next } = applyReply(
      episode({ bolusAt: NOW - 40 * MIN }),
      { episodeId: "ep-1", kind: "chip", ateSomething: true, eatTiming: "15" },
      NOW
    );
    expect(next.minutesBolusToEat).toBe(15);
  });

  it("does not overwrite a measured delay with a coarse chip", () => {
    const { episode: next } = applyReply(
      episode({ bolusAt: NOW - 40 * MIN, eatingAt: NOW - 37 * MIN }),
      { episodeId: "ep-1", kind: "chip", ateSomething: true, eatTiming: "60plus" },
      NOW
    );
    expect(next.minutesBolusToEat).toBe(3);
  });

  it("leaves minutesBolusToEat unset for an unknown chip", () => {
    const { episode: next } = applyReply(
      episode(),
      { episodeId: "ep-1", kind: "chip", ateSomething: true, eatTiming: "unknown" },
      NOW
    );
    expect(next.minutesBolusToEat).toBeUndefined();
  });

  it("keeps a reconciled status: the pump fact outranks the label", () => {
    const { episode: next } = applyReply(
      episode({ status: "reconciled" }),
      { episodeId: "ep-1", kind: "text", text: "two slices of pizza" },
      NOW
    );
    expect(next.status).toBe("reconciled");
    expect(next.reply?.text).toBe("two slices of pizza");
  });

  it("links a MealLog when the client wrote one", () => {
    const { episode: next } = applyReply(
      episode(),
      { episodeId: "ep-1", kind: "chip", ateSomething: true, mealLogId: "meal-9" },
      NOW
    );
    expect(next.mealLogId).toBe("meal-9");
  });

  it("never carries carbs of its own", () => {
    const { episode: next } = applyReply(
      episode(),
      { episodeId: "ep-1", kind: "text", text: "a sandwich" },
      NOW
    );
    expect(next).not.toHaveProperty("grams");
    expect(next.bolusCarbs).toBeUndefined();
  });
});
