import { describe, it, expect, vi } from "vitest";
import {
  MAX_BACKDATE_MS,
  MAX_CLIENT_ID_LEN,
  MAX_DESCRIPTION_LEN,
  MAX_FUTURE_MS,
  NightscoutMirrorError,
  buildTreatment,
  logUncoveredCarbs,
  nutritionNote,
  validateMealInput,
  type LogUncoveredDeps,
  type UncoveredCarbInput,
} from "../log-uncovered";
import { attachProvenance, validateEstimate } from "../nutrition-validate";
import type { MealLog } from "../types";

const NOW = Date.parse("2026-09-04T18:00:00.000Z");

function base(overrides: Record<string, unknown> = {}) {
  return {
    clientId: "b2f0e1f0-0000-4000-8000-000000000001",
    grams: 15,
    carbClass: "rescue",
    reason: "low",
    ...overrides,
  };
}

function expectOk(result: ReturnType<typeof validateMealInput>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.errors.join("; ")}`);
  return result.value;
}

function errorsFor(body: unknown): string[] {
  const result = validateMealInput(body, NOW);
  if (result.ok) throw new Error("expected validation to fail");
  return result.errors;
}

// ── validateMealInput ──

describe("validateMealInput — happy path", () => {
  it("accepts the minimal body and defaults eatenAt to now", () => {
    const value = expectOk(validateMealInput(base(), NOW));
    expect(value).toEqual({
      clientId: "b2f0e1f0-0000-4000-8000-000000000001",
      grams: 15,
      carbClass: "rescue",
      reason: "low",
      eatenAt: NOW,
      eatenAtSource: "server_received",
    });
    // No description key at all, so it never lands in the MealLog as undefined.
    expect("description" in value).toBe(false);
  });

  it("accepts snack + forgot_bolus + other reasons", () => {
    expect(expectOk(validateMealInput(base({ carbClass: "snack" }), NOW)).carbClass).toBe("snack");
    expect(expectOk(validateMealInput(base({ reason: "forgot_bolus" }), NOW)).reason).toBe("forgot_bolus");
    expect(expectOk(validateMealInput(base({ reason: "other" }), NOW)).reason).toBe("other");
  });

  it("resolves an ISO eatenAt to epoch ms", () => {
    const iso = "2026-09-04T17:30:00.000Z";
    expect(expectOk(validateMealInput(base({ eatenAt: iso }), NOW)).eatenAt).toBe(Date.parse(iso));
  });

  it("trims clientId and description", () => {
    const value = expectOk(
      validateMealInput(base({ clientId: "  abc  ", description: "  4 oz juice  " }), NOW)
    );
    expect(value.clientId).toBe("abc");
    expect(value.description).toBe("4 oz juice");
  });

  it("drops a whitespace-only description rather than storing an empty string", () => {
    const value = expectOk(validateMealInput(base({ description: "   " }), NOW));
    expect("description" in value).toBe(false);
  });

  it("treats explicit nulls for the optional fields as absent", () => {
    const value = expectOk(validateMealInput(base({ eatenAt: null, description: null }), NOW));
    expect(value.eatenAt).toBe(NOW);
    expect("description" in value).toBe(false);
  });
});

describe("validateMealInput — body shape", () => {
  it("rejects a non-object body", () => {
    expect(errorsFor(null)).toEqual(["body must be a JSON object"]);
    expect(errorsFor("hello")).toEqual(["body must be a JSON object"]);
    expect(errorsFor(42)).toEqual(["body must be a JSON object"]);
    expect(errorsFor([base()])).toEqual(["body must be a JSON object"]);
  });

  it("reports every problem at once, not just the first", () => {
    const errors = errorsFor({ clientId: "", grams: 0, carbClass: "invalid", reason: "nope" });
    expect(errors).toHaveLength(4);
  });
});

describe("validateMealInput — clientId", () => {
  it("requires a string", () => {
    expect(errorsFor(base({ clientId: 7 }))).toContain("clientId must be a string");
    expect(errorsFor(base({ clientId: undefined }))).toContain("clientId must be a string");
  });

  it("rejects empty and whitespace-only", () => {
    expect(errorsFor(base({ clientId: "" }))).toContain("clientId must not be empty");
    expect(errorsFor(base({ clientId: "   " }))).toContain("clientId must not be empty");
  });

  it("accepts exactly the maximum length and rejects one over", () => {
    expect(expectOk(validateMealInput(base({ clientId: "x".repeat(MAX_CLIENT_ID_LEN) }), NOW)).clientId)
      .toHaveLength(MAX_CLIENT_ID_LEN);
    expect(errorsFor(base({ clientId: "x".repeat(MAX_CLIENT_ID_LEN + 1) }))).toContain(
      `clientId must be at most ${MAX_CLIENT_ID_LEN} characters`
    );
  });
});

describe("validateMealInput — grams", () => {
  it("requires a finite number", () => {
    for (const bad of ["15", NaN, Infinity, -Infinity, null, undefined]) {
      expect(errorsFor(base({ grams: bad }))).toContain("grams must be a finite number");
    }
  });

  it("accepts the inclusive bounds 1 and 150", () => {
    expect(expectOk(validateMealInput(base({ grams: 1 }), NOW)).grams).toBe(1);
    expect(expectOk(validateMealInput(base({ grams: 150 }), NOW)).grams).toBe(150);
  });

  it("rejects just outside the bounds", () => {
    expect(errorsFor(base({ grams: 0 }))).toContain("grams must be between 1 and 150");
    expect(errorsFor(base({ grams: 0.5 }))).toContain("grams must be between 1 and 150");
    expect(errorsFor(base({ grams: 151 }))).toContain("grams must be between 1 and 150");
    expect(errorsFor(base({ grams: -15 }))).toContain("grams must be between 1 and 150");
  });

  it("allows a fractional value inside the range", () => {
    expect(expectOk(validateMealInput(base({ grams: 12.5 }), NOW)).grams).toBe(12.5);
  });
});

describe("validateMealInput — enums", () => {
  it("accepts a full meal with the standard absorption span", () => {
    const value = expectOk(validateMealInput(base({ carbClass: "meal" }), NOW));
    expect(value.carbClass).toBe("meal");
    expect(buildTreatment(value).absorptionTime).toBe(180);
  });

  it("rejects an unknown or missing carbClass", () => {
    expect(errorsFor(base({ carbClass: "dessert" }))).toContain("carbClass must be one of rescue, snack, meal");
    expect(errorsFor(base({ carbClass: undefined }))).toContain("carbClass must be one of rescue, snack, meal");
  });

  it("rejects an unknown or missing reason", () => {
    const msg = "reason must be one of low, forgot_bolus, other";
    expect(errorsFor(base({ reason: "hungry" }))).toContain(msg);
    expect(errorsFor(base({ reason: undefined }))).toContain(msg);
    expect(errorsFor(base({ reason: 3 }))).toContain(msg);
  });
});

describe("validateMealInput — eatenAt window", () => {
  it("rejects a non-string and an unparseable string", () => {
    const msg = "eatenAt must be an ISO 8601 string";
    expect(errorsFor(base({ eatenAt: 1757008800000 }))).toContain(msg);
    expect(errorsFor(base({ eatenAt: "yesterday" }))).toContain(msg);
  });

  it("accepts the 24-hour backdate edge and rejects beyond it", () => {
    const edge = new Date(NOW - MAX_BACKDATE_MS + 1000).toISOString();
    expect(expectOk(validateMealInput(base({ eatenAt: edge }), NOW)).eatenAt).toBe(Date.parse(edge));
    const tooOld = new Date(NOW - MAX_BACKDATE_MS - 1000).toISOString();
    expect(errorsFor(base({ eatenAt: tooOld }))).toContain("eatenAt must be within the last 24 hours");
  });

  it("accepts a clock up to 5 minutes ahead and rejects further", () => {
    const ahead = new Date(NOW + MAX_FUTURE_MS - 1000).toISOString();
    expect(expectOk(validateMealInput(base({ eatenAt: ahead }), NOW)).eatenAt).toBe(Date.parse(ahead));
    const tooFar = new Date(NOW + MAX_FUTURE_MS + 1000).toISOString();
    expect(errorsFor(base({ eatenAt: tooFar }))).toContain(
      "eatenAt must not be more than 5 minutes in the future"
    );
  });
});

describe("validateMealInput — description", () => {
  it("requires a string when present", () => {
    expect(errorsFor(base({ description: 12 }))).toContain("description must be a string");
  });

  it("accepts exactly 280 characters and rejects 281", () => {
    const ok = "a".repeat(MAX_DESCRIPTION_LEN);
    expect(expectOk(validateMealInput(base({ description: ok }), NOW)).description).toBe(ok);
    expect(errorsFor(base({ description: "a".repeat(MAX_DESCRIPTION_LEN + 1) }))).toContain(
      `description must be at most ${MAX_DESCRIPTION_LEN} characters`
    );
  });

  it("measures the length after trimming", () => {
    const padded = `  ${"a".repeat(MAX_DESCRIPTION_LEN)}  `;
    expect(expectOk(validateMealInput(base({ description: padded }), NOW)).description).toHaveLength(
      MAX_DESCRIPTION_LEN
    );
  });
});

// ── buildTreatment ──

function input(overrides: Partial<UncoveredCarbInput> = {}): UncoveredCarbInput {
  return {
    clientId: "cid-1",
    grams: 15,
    carbClass: "rescue",
    reason: "low",
    eatenAt: NOW,
    ...overrides,
  };
}

describe("buildTreatment", () => {
  it("writes a Carb Correction with the fast absorption span for rescue carbs", () => {
    expect(buildTreatment(input())).toEqual({
      eventType: "Carb Correction",
      carbs: 15,
      absorptionTime: 30,
      created_at: "2026-09-04T18:00:00.000Z",
      foodType: "low",
    });
  });

  it("uses the 180-minute default span for a snack", () => {
    expect(buildTreatment(input({ carbClass: "snack", grams: 40, reason: "forgot_bolus" }))).toEqual({
      eventType: "Carb Correction",
      carbs: 40,
      absorptionTime: 180,
      created_at: "2026-09-04T18:00:00.000Z",
      foodType: "forgot_bolus",
    });
  });

  it("carries the description into notes", () => {
    expect(buildTreatment(input({ description: "4 oz juice" }))).toMatchObject({
      notes: "4 oz juice",
    });
  });

  it("omits notes entirely when there is no description", () => {
    expect("notes" in buildTreatment(input())).toBe(false);
  });

  // Risk 1: an insulin field here would corrupt IOB. These carbs were, by
  // definition, not covered by any bolus.
  it("never sets insulin", () => {
    expect("insulin" in buildTreatment(input())).toBe(false);
  });

  // enteredBy is forced to "ClearSugar" by postTreatment (risk 2: a document
  // matching the tconnectsync regex would silently disable pump-staleness).
  it("does not set enteredBy — postTreatment owns provenance", () => {
    expect("enteredBy" in buildTreatment(input())).toBe(false);
  });

  it("stamps created_at from eatenAt, not from the wall clock", () => {
    const backdated = Date.parse("2026-09-04T12:34:56.000Z");
    expect(buildTreatment(input({ eatenAt: backdated })).created_at).toBe(
      "2026-09-04T12:34:56.000Z"
    );
  });
});

// ── logUncoveredCarbs ──

function makeDeps(overrides: Partial<LogUncoveredDeps> = {}) {
  let n = 0;
  const appended: MealLog[] = [];
  const deps: LogUncoveredDeps = {
    postTreatment: vi.fn(async () => ({ _id: "6512ab34cd56ef7890123456" })),
    store: {
      reserveMeal: async (meal) => meal,
        findMealByClientId: vi.fn(async () => null),
      appendMeal: vi.fn(async (m: MealLog) => {
        appended.push(m);
        return m;
      }),
    },
    now: () => NOW + 1000,
    uuid: () => `uuid-${++n}`,
    ...overrides,
  };
  return { deps, appended };
}

describe("logUncoveredCarbs — create", () => {
  it("reserves a stable Nightscout ID before mirroring and committing the row", async () => {
    const { deps, appended } = makeDeps();
    const { meal, replayed } = await logUncoveredCarbs(
      input({ description: "4 oz juice" }),
      "patient@example.com",
      deps
    );

    expect(replayed).toBe(false);
    expect(deps.postTreatment).toHaveBeenCalledWith({ ...buildTreatment(input({ description: "4 oz juice" })), _id: meal.nightscoutId });
    expect(meal).toEqual({
      schemaVersion: 1,
      eatenAtSource: undefined,
      carbGramsSource: "user_entered",
      childId: "patient", isTest: false,
      id: "uuid-1",
      createdAt: NOW + 1000,
      eatenAt: NOW,
      episodeId: "uuid-2",
      source: "user_logged",
      carbClass: "rescue",
      reason: "low",
      description: "4 oz juice",
      grams: 15,
      nightscoutId: "80aa1f4dcdcde45f241ecc5a",
      enteredBySub: "patient@example.com",
      clientId: "cid-1",
    });
    expect(appended).toEqual([meal]);
  });

  it("gives the meal its own id and a distinct episodeId", async () => {
    const { deps } = makeDeps();
    const { meal } = await logUncoveredCarbs(input(), "patient@example.com", deps);
    expect(meal.id).not.toBe(meal.episodeId);
  });

  it("checks the clientId before writing anything", async () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      postTreatment: vi.fn(async () => {
        order.push("post");
        return { _id: "6512ab34cd56ef7890123456" };
      }),
      store: {
        reserveMeal: async (meal) => meal,
        findMealByClientId: vi.fn(async () => {
          order.push("find");
          return null;
        }),
        appendMeal: vi.fn(async () => {
          order.push("append");
        }),
      },
    });
    await logUncoveredCarbs(input(), "patient@example.com", deps);
    expect(order).toEqual(["find", "post", "append"]);
  });

  it("omits description from the row when there was none", async () => {
    const { deps } = makeDeps();
    const { meal } = await logUncoveredCarbs(input(), "patient@example.com", deps);
    expect("description" in meal).toBe(false);
  });

  it("attributes the row to the authenticated sub, not anything in the body", async () => {
    const { deps } = makeDeps();
    const { meal } = await logUncoveredCarbs(input(), "someone@example.com", deps);
    expect(meal.enteredBySub).toBe("someone@example.com");
  });
});

describe("logUncoveredCarbs — replay", () => {
  it("returns the existing row and writes nothing", async () => {
    const existing: MealLog = {
      id: "meal-existing",
      createdAt: NOW - 60_000,
      eatenAt: NOW - 60_000,
      episodeId: "ep-existing",
      source: "user_logged",
      carbClass: "rescue",
      reason: "low",
      grams: 15,
      nightscoutId: "6512ab34cd56ef7890123456",
      enteredBySub: "patient@example.com",
      clientId: "cid-1",
    };
    const { deps } = makeDeps({
      store: {
        reserveMeal: async (meal) => meal,
        findMealByClientId: vi.fn(async () => existing),
        appendMeal: vi.fn(async () => {}),
      },
    });

    const result = await logUncoveredCarbs(input(), "patient@example.com", deps);
    expect(result).toEqual({ meal: existing, replayed: true });
    expect(deps.postTreatment).not.toHaveBeenCalled();
    expect(deps.store.appendMeal).not.toHaveBeenCalled();
  });

  it("replays even when the retry body differs — the clientId is the key", async () => {
    const existing = { id: "m1", clientId: "cid-1", grams: 15, enteredBySub: "patient@example.com" } as MealLog;
    const { deps } = makeDeps({
      store: {
        reserveMeal: async (meal) => meal,
        findMealByClientId: vi.fn(async () => existing),
        appendMeal: vi.fn(async () => {}),
      },
    });
    const result = await logUncoveredCarbs(input({ grams: 99 }), "patient@example.com", deps);
    expect(result.replayed).toBe(true);
    expect(result.meal.grams).toBe(15);
  });
});

describe("logUncoveredCarbs — Nightscout failure", () => {
  it("throws NightscoutMirrorError and persists nothing", async () => {
    const { deps, appended } = makeDeps({
      postTreatment: vi.fn(async () => {
        throw new Error("502 Bad Gateway");
      }),
    });

    await expect(logUncoveredCarbs(input(), "patient@example.com", deps)).rejects.toBeInstanceOf(
      NightscoutMirrorError
    );
    expect(deps.store.appendMeal).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
  });

  it("keeps the original failure as the cause and in the message", async () => {
    const boom = new Error("NIGHTSCOUT_URL not configured");
    const { deps } = makeDeps({
      postTreatment: vi.fn(async () => {
        throw boom;
      }),
    });
    const err = await logUncoveredCarbs(input(), "patient@example.com", deps).catch((e) => e);
    expect(err).toBeInstanceOf(NightscoutMirrorError);
    expect((err as NightscoutMirrorError).cause).toBe(boom);
    expect((err as Error).message).toContain("NIGHTSCOUT_URL not configured");
  });

  it("wraps a non-Error throw too", async () => {
    const { deps } = makeDeps({
      postTreatment: vi.fn(async () => {
        throw "string failure";
      }),
    });
    const err = await logUncoveredCarbs(input(), "patient@example.com", deps).catch((e) => e);
    expect(err).toBeInstanceOf(NightscoutMirrorError);
    expect((err as NightscoutMirrorError).cause).toBe("string failure");
  });

  it("lets an appendMeal failure surface as itself, not as a mirror error", async () => {
    const { deps } = makeDeps({
      store: {
        reserveMeal: async (meal) => meal,
        findMealByClientId: vi.fn(async () => null),
        appendMeal: vi.fn(async () => {
          throw new Error("ENOSPC");
        }),
      },
    });
    const err = await logUncoveredCarbs(input(), "patient@example.com", deps).catch((e) => e);
    expect(err).not.toBeInstanceOf(NightscoutMirrorError);
    expect((err as Error).message).toBe("ENOSPC");
  });
});

// ── Phase 3: photoId + a confirmed nutrition estimate ──────────────────────────

const PHOTO_ID = "3f2b1a0c-1111-4222-8333-444455556666";

/** What a client sends back after confirming an estimate from /api/meals/estimate. */
function estimate(over: Record<string, unknown> = {}) {
  return {
    carbs: { low: 45, mid: 60, high: 80 },
    protein: 24,
    fat: 18,
    fiber: 3,
    giClass: "high",
    confidence: 0.6,
    items: [{ name: "cheese pizza", portion: "2 slices", carbs: 58 }],
    model: "claude-vision-1",
    provider: "openai-compatible",
    estimatedAt: NOW - 30_000,
    rawResponse: '{"carbs":{"low":45,"mid":60,"high":80}}',
    ...over,
  };
}

/** A validated + provenance-stamped estimate, as it reaches buildTreatment. */
function nutrition(
  core: Record<string, unknown> = { carbs: { low: 45, mid: 60, high: 80 }, confidence: 0.6 },
  prov: Record<string, unknown> = {}
) {
  const validated = validateEstimate(core);
  if (!validated.ok) throw new Error(`bad fixture: ${validated.errors.join("; ")}`);
  return attachProvenance(validated.value, prov, NOW);
}

describe("validateMealInput — photoId", () => {
  it("accepts a UUID", () => {
    expect(expectOk(validateMealInput(base({ photoId: PHOTO_ID }), NOW)).photoId).toBe(PHOTO_ID);
  });

  it("omits the key when absent or null", () => {
    expect("photoId" in expectOk(validateMealInput(base(), NOW))).toBe(false);
    expect("photoId" in expectOk(validateMealInput(base({ photoId: null }), NOW))).toBe(false);
  });

  it("rejects anything that is not a UUID, so it can never become a path", () => {
    for (const bad of [
      "../../push/identities",
      "photos/x.jpg",
      PHOTO_ID.toUpperCase(),
      "short",
      7,
      `${PHOTO_ID}0`,
    ]) {
      expect(errorsFor(base({ photoId: bad }))).toContain("photoId must be a UUID");
    }
  });
});

describe("validateMealInput — nutrition", () => {
  it("accepts a confirmed estimate and keeps its provenance", () => {
    const value = expectOk(validateMealInput(base({ nutrition: estimate() }), NOW));
    expect(value.nutrition).toEqual({
      carbs: { low: 45, mid: 60, high: 80 },
      protein: 24,
      fat: 18,
      fiber: 3,
      giClass: "high",
      confidence: 0.6,
      items: [{ name: "cheese pizza", portion: "2 slices", carbs: 58 }],
      model: "claude-vision-1",
      provider: "openai-compatible",
      estimatedAt: NOW - 30_000,
      rawResponse: '{"carbs":{"low":45,"mid":60,"high":80}}',
    });
  });

  it("clamps an implausible estimate rather than trusting it", () => {
    const value = expectOk(
      validateMealInput(
        base({ nutrition: estimate({ carbs: { low: -5, mid: 40, high: 9000 }, confidence: 8 }) }),
        NOW
      )
    );
    expect(value.nutrition?.carbs).toEqual({ low: 0, mid: 40, high: 300 });
    expect(value.nutrition?.confidence).toBe(1);
  });

  it("defaults missing provenance rather than claiming a model said it", () => {
    const value = expectOk(
      validateMealInput(base({ nutrition: { carbs: 30, confidence: 0.5 } }), NOW)
    );
    expect(value.nutrition).toMatchObject({
      model: "unknown",
      provider: "unknown",
      estimatedAt: NOW,
      rawResponse: "",
    });
  });

  it("reports a validation failure under a nutrition: prefix", () => {
    expect(errorsFor(base({ nutrition: { confidence: 0.5 } }))).toEqual([
      "nutrition: carbs must be a number or an object with low/mid/high grams",
    ]);
    expect(errorsFor(base({ nutrition: "60 g of carbs" }))).toEqual([
      "nutrition: estimate must be a JSON object",
    ]);
  });

  it("omits the key when absent or null", () => {
    expect("nutrition" in expectOk(validateMealInput(base(), NOW))).toBe(false);
    expect("nutrition" in expectOk(validateMealInput(base({ nutrition: null }), NOW))).toBe(false);
  });
});

describe("validateMealInput — grams derived from an estimate", () => {
  function withoutGrams(over: Record<string, unknown> = {}) {
    const b = base(over) as Record<string, unknown>;
    delete b.grams;
    return b;
  }

  it("defaults grams to the rounded mid of the range", () => {
    const value = expectOk(
      validateMealInput(
        withoutGrams({ nutrition: estimate({ carbs: { low: 40, mid: 57.4, high: 75 } }) }),
        NOW
      )
    );
    expect(value.grams).toBe(57);
  });

  it("rounds half up", () => {
    const value = expectOk(
      validateMealInput(withoutGrams({ nutrition: estimate({ carbs: { mid: 12.5 } }) }), NOW)
    );
    expect(value.grams).toBe(13);
  });

  it("prefers an explicit grams over the estimate — the human confirmed a number", () => {
    const value = expectOk(validateMealInput(base({ grams: 45, nutrition: estimate() }), NOW));
    expect(value.grams).toBe(45);
    expect(value.nutrition?.carbs.mid).toBe(60);
  });

  it("still requires grams when there is no estimate to derive from", () => {
    expect(errorsFor(withoutGrams())).toContain("grams must be a finite number");
  });

  it("rejects a derived value outside 1..150 instead of writing it", () => {
    // A 220 g dinner is plausible, but this route may not write it unreviewed.
    expect(
      errorsFor(withoutGrams({ nutrition: estimate({ carbs: { low: 180, mid: 220, high: 260 } }) }))
    ).toContain("grams derived from nutrition.carbs.mid (220) must be between 1 and 150");
    // A zero-carb plate is not an uncovered-carb treatment.
    expect(
      errorsFor(withoutGrams({ nutrition: estimate({ carbs: { low: 0, mid: 0, high: 0 } }) }))
    ).toContain("grams derived from nutrition.carbs.mid (0) must be between 1 and 150");
  });

  it("does not derive grams from an estimate that failed validation", () => {
    const errors = errorsFor(withoutGrams({ nutrition: { carbs: "lots" } }));
    expect(errors).toContain("grams must be a finite number");
    expect(errors.some((e) => e.startsWith("nutrition:"))).toBe(true);
  });
});

describe("buildTreatment — with a confirmed estimate", () => {
  it("adds the Nightscout-standard protein, fat and fiber fields", () => {
    const doc = buildTreatment(
      input({
        nutrition: nutrition({
          carbs: { low: 45, mid: 60, high: 80 },
          confidence: 0.6,
          protein: 24,
          fat: 18,
          fiber: 3,
        }),
      })
    );
    expect(doc).toMatchObject({ protein: 24, fat: 18, fiber: 3 });
  });

  it("omits a macro the estimate did not carry", () => {
    const doc = buildTreatment(input({ nutrition: nutrition() }));
    expect("protein" in doc).toBe(false);
    expect("fat" in doc).toBe(false);
    expect("fiber" in doc).toBe(false);
  });

  it("still writes only the confirmed grams as carbs, never the range high", () => {
    const doc = buildTreatment(input({ grams: 55, nutrition: nutrition() }));
    expect(doc.carbs).toBe(55);
  });

  it("appends the range and confidence to notes so a chart reader sees the provenance", () => {
    expect(buildTreatment(input({ nutrition: nutrition() })).notes).toBe(
      "AI estimate: 45-80 g (conf 0.6)"
    );
  });

  it("keeps the patient's own description first when there is one", () => {
    const doc = buildTreatment(
      input({ description: "2 slices of pizza", nutrition: nutrition() })
    );
    expect(doc.notes).toBe("2 slices of pizza | AI estimate: 45-80 g (conf 0.6)");
  });

  it("collapses a zero-width range to a single number", () => {
    const doc = buildTreatment(
      input({ nutrition: nutrition({ carbs: 30, confidence: 0.9 }) })
    );
    expect(doc.notes).toBe("AI estimate: 30 g (conf 0.9)");
  });

  it("rounds the displayed range", () => {
    expect(
      nutritionNote(nutrition({ carbs: { low: 44.4, mid: 60, high: 79.6 }, confidence: 0.55 }))
    ).toBe("AI estimate: 44-80 g (conf 0.6)");
  });

  it("leaves the treatment untouched when there is no estimate", () => {
    expect(buildTreatment(input({ description: "4 oz juice" })).notes).toBe("4 oz juice");
    expect("protein" in buildTreatment(input())).toBe(false);
  });
});

describe("logUncoveredCarbs — photo and nutrition on the row", () => {
  it("stores photoId and nutrition, and marks the source photo_estimated", async () => {
    const est = nutrition(
      { carbs: { low: 45, mid: 60, high: 80 }, confidence: 0.6, protein: 24 },
      { model: "claude-vision-1", provider: "openai-compatible", estimatedAt: NOW, rawResponse: "{}" }
    );
    const { deps, appended } = makeDeps();
    const { meal } = await logUncoveredCarbs(
      input({ grams: 60, photoId: PHOTO_ID, nutrition: est }),
      "patient@example.com",
      deps
    );
    expect(meal.photoId).toBe(PHOTO_ID);
    expect(meal.nutrition).toEqual(est);
    expect(meal.source).toBe("photo_estimated");
    expect(appended[0]).toEqual(meal);
  });

  it("keeps user_logged when there is no estimate", async () => {
    const { deps } = makeDeps();
    const { meal } = await logUncoveredCarbs(input(), "patient@example.com", deps);
    expect(meal.source).toBe("user_logged");
    expect("photoId" in meal).toBe(false);
    expect("nutrition" in meal).toBe(false);
  });

  it("still mirrors exactly one carb-bearing treatment (risk 1)", async () => {
    const { deps } = makeDeps();
    await logUncoveredCarbs(
      input({ grams: 60, photoId: PHOTO_ID, nutrition: nutrition() }),
      "patient@example.com",
      deps
    );
    expect(deps.postTreatment).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.postTreatment).mock.calls[0][0].carbs).toBe(60);
  });
});
