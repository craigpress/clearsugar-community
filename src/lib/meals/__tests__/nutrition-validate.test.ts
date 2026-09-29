import { describe, it, expect } from "vitest";
import {
  MAX_CARBS_G,
  MAX_ITEMS,
  MAX_ITEM_NAME_LEN,
  MAX_MACRO_G,
  MAX_RAW_RESPONSE_LEN,
  attachProvenance,
  validateEstimate,
} from "../nutrition-validate";

const NOW = Date.parse("2026-09-04T18:00:00.000Z");

function raw(over: Record<string, unknown> = {}) {
  return {
    carbs: { low: 40, mid: 55, high: 75 },
    confidence: 0.6,
    ...over,
  };
}

function ok(input: unknown) {
  const result = validateEstimate(input);
  if (!result.ok) throw new Error(`expected ok, got ${result.errors.join("; ")}`);
  return result.value;
}

function errs(input: unknown): string[] {
  const result = validateEstimate(input);
  if (result.ok) throw new Error("expected validation to fail");
  return result.errors;
}

// ── shape ──

describe("validateEstimate — shape", () => {
  it("accepts the minimal usable estimate: carbs + confidence", () => {
    expect(ok(raw())).toEqual({
      carbs: { low: 40, mid: 55, high: 75 },
      confidence: 0.6,
    });
  });

  it("rejects anything that is not a JSON object", () => {
    for (const bad of [null, undefined, 42, "carbs: 40", [raw()], true]) {
      expect(errs(bad)).toEqual(["estimate must be a JSON object"]);
    }
  });

  it("keeps explanatory notes but drops unknown keys", () => {
    const value = ok(raw({ notes: "looks like pizza", calories: 900, sodium: 1200 }));
    expect(Object.keys(value).sort()).toEqual(["carbs", "confidence", "notes"]);
    expect(value.notes).toBe("looks like pizza");
  });
});

// ── carbs: the hard requirement ──

describe("validateEstimate — carbs", () => {
  it("rejects a missing, null or unusable carbs field", () => {
    const msg = "carbs must be a number or an object with low/mid/high grams";
    expect(errs({ confidence: 0.5 })).toContain(msg);
    expect(errs(raw({ carbs: null }))).toContain(msg);
    expect(errs(raw({ carbs: "about 40 g" }))).toContain(msg);
    expect(errs(raw({ carbs: {} }))).toContain(msg);
    expect(errs(raw({ carbs: [40, 55, 75] }))).toContain(msg);
    expect(errs(raw({ carbs: { low: "a", mid: "b", high: "c" } }))).toContain(msg);
    expect(errs(raw({ carbs: NaN }))).toContain(msg);
  });

  it("accepts a bare number as a point estimate", () => {
    expect(ok(raw({ carbs: 45 })).carbs).toEqual({ low: 45, mid: 45, high: 45 });
  });

  it("fills a partial triple from mid rather than failing", () => {
    expect(ok(raw({ carbs: { mid: 50 } })).carbs).toEqual({ low: 50, mid: 50, high: 50 });
    expect(ok(raw({ carbs: { mid: 50, high: 80 } })).carbs).toEqual({
      low: 50,
      mid: 50,
      high: 80,
    });
  });

  it("fills from the first present value when mid is the one missing", () => {
    expect(ok(raw({ carbs: { low: 30, high: 60 } })).carbs).toEqual({
      low: 30,
      mid: 30,
      high: 60,
    });
  });

  it("clamps each bound into 0..300", () => {
    expect(ok(raw({ carbs: { low: -20, mid: 150, high: 900 } })).carbs).toEqual({
      low: 0,
      mid: 150,
      high: MAX_CARBS_G,
    });
  });

  it("orders a swapped triple so low <= mid <= high always holds", () => {
    const value = ok(raw({ carbs: { low: 90, mid: 40, high: 60 } }));
    expect(value.carbs).toEqual({ low: 40, mid: 60, high: 90 });
    expect(value.carbs.low).toBeLessThanOrEqual(value.carbs.mid);
    expect(value.carbs.mid).toBeLessThanOrEqual(value.carbs.high);
  });

  it("still orders correctly after clamping collapses two bounds", () => {
    const value = ok(raw({ carbs: { low: 500, mid: 400, high: 10 } }));
    expect(value.carbs).toEqual({ low: 10, mid: MAX_CARBS_G, high: MAX_CARBS_G });
  });

  it("accepts zero carbs (a plate of chicken and salad)", () => {
    expect(ok(raw({ carbs: 0 })).carbs).toEqual({ low: 0, mid: 0, high: 0 });
  });
});

// ── confidence: required, then clamped ──

describe("validateEstimate — confidence", () => {
  it("rejects a missing or non-numeric confidence", () => {
    const msg = "confidence must be a number between 0 and 1";
    expect(errs({ carbs: 40 })).toContain(msg);
    expect(errs(raw({ confidence: null }))).toContain(msg);
    expect(errs(raw({ confidence: "high" }))).toContain(msg);
    expect(errs(raw({ confidence: NaN }))).toContain(msg);
  });

  it("clamps out-of-range values instead of rejecting them", () => {
    expect(ok(raw({ confidence: 95 })).confidence).toBe(1);
    expect(ok(raw({ confidence: -0.5 })).confidence).toBe(0);
  });

  it("accepts the inclusive bounds", () => {
    expect(ok(raw({ confidence: 0 })).confidence).toBe(0);
    expect(ok(raw({ confidence: 1 })).confidence).toBe(1);
  });

  it("reports both hard failures at once", () => {
    expect(errs({})).toHaveLength(2);
  });
});

// ── optional macros ──

describe("validateEstimate — protein/fat/fiber", () => {
  it("carries them through when plausible", () => {
    const value = ok(raw({ protein: 30, fat: 22, fiber: 4 }));
    expect(value).toMatchObject({ protein: 30, fat: 22, fiber: 4 });
  });

  it("omits the keys entirely when absent, rather than storing undefined", () => {
    const value = ok(raw());
    expect("protein" in value).toBe(false);
    expect("fat" in value).toBe(false);
    expect("fiber" in value).toBe(false);
  });

  it("clamps to 0..200", () => {
    const value = ok(raw({ protein: 900, fat: -5, fiber: MAX_MACRO_G }));
    expect(value).toMatchObject({ protein: MAX_MACRO_G, fat: 0, fiber: MAX_MACRO_G });
  });

  it("drops a malformed macro instead of failing the whole estimate", () => {
    const value = ok(raw({ protein: "lots", fat: null, fiber: NaN }));
    expect("protein" in value).toBe(false);
    expect("fat" in value).toBe(false);
    expect("fiber" in value).toBe(false);
    expect(value.carbs.mid).toBe(55);
  });
});

// ── giClass ──

describe("validateEstimate — giClass", () => {
  it("accepts the enum", () => {
    for (const gi of ["low", "medium", "high"] as const) {
      expect(ok(raw({ giClass: gi })).giClass).toBe(gi);
    }
  });

  it("normalises case and whitespace", () => {
    expect(ok(raw({ giClass: " HIGH " })).giClass).toBe("high");
  });

  it("drops anything outside the enum", () => {
    for (const bad of ["very high", "moderate", 2, null, {}]) {
      expect("giClass" in ok(raw({ giClass: bad }))).toBe(false);
    }
  });
});

// ── items ──

describe("validateEstimate — items", () => {
  it("normalises each entry", () => {
    const value = ok(
      raw({
        items: [
          { name: "  cheese pizza  ", portion: " 2 slices ", carbs: 60 },
          { name: "apple juice", portion: "8 oz", carbs: 28 },
        ],
      })
    );
    expect(value.items).toEqual([
      { name: "cheese pizza", portion: "2 slices", carbs: 60 },
      { name: "apple juice", portion: "8 oz", carbs: 28 },
    ]);
  });

  it("truncates a long name to 80 characters", () => {
    const value = ok(raw({ items: [{ name: "x".repeat(200), portion: "1", carbs: 5 }] }));
    expect(value.items?.[0].name).toHaveLength(MAX_ITEM_NAME_LEN);
  });

  it("caps the list at 20 entries", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `item ${i}`,
      portion: "1",
      carbs: 1,
    }));
    expect(ok(raw({ items: many })).items).toHaveLength(MAX_ITEMS);
  });

  it("skips unnamed and malformed entries", () => {
    const value = ok(
      raw({
        items: [
          { portion: "1 cup", carbs: 30 },
          "rice",
          null,
          { name: "   ", carbs: 10 },
          { name: "rice", carbs: 45 },
        ],
      })
    );
    expect(value.items).toEqual([{ name: "rice", portion: "", carbs: 45 }]);
  });

  it("defaults a missing item carb count to 0 and clamps a wild one", () => {
    const value = ok(
      raw({ items: [{ name: "a" }, { name: "b", carbs: 9999 }] })
    );
    expect(value.items).toEqual([
      { name: "a", portion: "", carbs: 0 },
      { name: "b", portion: "", carbs: MAX_CARBS_G },
    ]);
  });

  it("omits items entirely when the field is absent, empty or not an array", () => {
    expect("items" in ok(raw())).toBe(false);
    expect("items" in ok(raw({ items: [] }))).toBe(false);
    expect("items" in ok(raw({ items: "pizza, juice" }))).toBe(false);
    expect("items" in ok(raw({ items: [null, 3] }))).toBe(false);
  });
});

// ── attachProvenance ──

describe("attachProvenance", () => {
  const core = { carbs: { low: 40, mid: 55, high: 75 }, confidence: 0.6 };

  it("carries a well-formed provenance through", () => {
    expect(
      attachProvenance(core, {
        model: "claude-vision",
        provider: "openai-compatible",
        estimatedAt: NOW,
        rawResponse: "{...}",
      }, NOW + 5)
    ).toEqual({ ...core, model: "claude-vision", provider: "openai-compatible", estimatedAt: NOW, rawResponse: "{...}" });
  });

  it("defaults a missing provenance rather than dropping the fields", () => {
    expect(attachProvenance(core, {}, NOW)).toEqual({
      ...core,
      model: "unknown",
      provider: "unknown",
      estimatedAt: NOW,
      rawResponse: "",
    });
  });

  it("treats a non-object raw as no provenance at all", () => {
    expect(attachProvenance(core, "nope", NOW).model).toBe("unknown");
    expect(attachProvenance(core, null, NOW).provider).toBe("unknown");
  });

  it("rejects blank and non-string model names", () => {
    expect(attachProvenance(core, { model: "   " }, NOW).model).toBe("unknown");
    expect(attachProvenance(core, { model: 7 }, NOW).model).toBe("unknown");
  });

  it("bounds a huge rawResponse so one estimate cannot bloat a shard", () => {
    const huge = "x".repeat(MAX_RAW_RESPONSE_LEN * 3);
    expect(attachProvenance(core, { rawResponse: huge }, NOW).rawResponse).toHaveLength(
      MAX_RAW_RESPONSE_LEN
    );
  });

  it("does not let a client's estimatedAt be a non-number", () => {
    expect(attachProvenance(core, { estimatedAt: "yesterday" }, NOW).estimatedAt).toBe(NOW);
  });
});
