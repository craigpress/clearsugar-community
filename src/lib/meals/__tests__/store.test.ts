import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MealLog } from "../types";

// local-store reads CLEARSUGAR_DATA_DIR at module load, so the env var must be
// set and the module registry reset before store.ts is imported.
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cs-meals-"));
  process.env.CLEARSUGAR_DATA_DIR = dir;
  vi.resetModules();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function loadStore() {
  return import("../store");
}

const SEP = Date.parse("2026-09-04T18:00:00.000Z");
const AUG = Date.parse("2026-08-20T12:00:00.000Z");
const JUL = Date.parse("2026-07-15T12:00:00.000Z");

function meal(over: Partial<MealLog> = {}): MealLog {
  return {
    id: "m1",
    createdAt: SEP,
    eatenAt: SEP,
    episodeId: "e1",
    source: "user_logged",
    carbClass: "rescue",
    reason: "low",
    grams: 15,
    nightscoutId: "6512ab34cd56ef7890123456",
    enteredBySub: "patient@example.com",
    clientId: "cid-1",
    ...over,
  };
}

describe("shardKey", () => {
  it("derives meals/<yyyy-mm>.json from the instant in UTC", async () => {
    const { shardKey } = await loadStore();
    expect(shardKey(SEP)).toBe("meals/2026-09.json");
    expect(shardKey(AUG)).toBe("meals/2026-08.json");
    expect(shardKey(Date.parse("2026-01-01T00:00:00.000Z"))).toBe("meals/2026-01.json");
    expect(shardKey(Date.parse("2026-12-31T23:59:59.999Z"))).toBe("meals/2026-12.json");
  });
});

describe("appendMeal", () => {
  it("files the row in the shard for its eatenAt, not for now", async () => {
    const { appendMeal } = await loadStore();
    await appendMeal(meal({ id: "sep", eatenAt: SEP }));
    await appendMeal(meal({ id: "aug", eatenAt: AUG, clientId: "cid-2" }));

    const files = (await readdir(join(dir, "meals"))).sort();
    expect(files).toEqual(["2026-08.json", "2026-09.json"]);
  });

  it("writes one JSON array per month and appends to it", async () => {
    const { appendMeal } = await loadStore();
    await appendMeal(meal({ id: "a", clientId: "cid-a" }));
    await appendMeal(meal({ id: "b", clientId: "cid-b" }));

    const raw = JSON.parse(await readFile(join(dir, "meals", "2026-09.json"), "utf-8"));
    expect(Array.isArray(raw)).toBe(true);
    expect(raw.map((m: MealLog) => m.id)).toEqual(["a", "b"]);
  });

  it("returns the meal it stored", async () => {
    const { appendMeal } = await loadStore();
    const m = meal();
    expect(await appendMeal(m)).toEqual(m);
  });
});

describe("findMealByClientId", () => {
  it("finds a row in the current month", async () => {
    const { appendMeal, findMealByClientId } = await loadStore();
    await appendMeal(meal({ id: "a", clientId: "cid-a" }));
    expect((await findMealByClientId("cid-a", 2, SEP))?.id).toBe("a");
  });

  it("finds a row in the previous month with the default lookback", async () => {
    const { appendMeal, findMealByClientId } = await loadStore();
    await appendMeal(meal({ id: "aug", eatenAt: AUG, clientId: "cid-aug" }));
    expect((await findMealByClientId("cid-aug", 2, SEP))?.id).toBe("aug");
  });

  it("does not reach past the lookback window", async () => {
    const { appendMeal, findMealByClientId } = await loadStore();
    await appendMeal(meal({ id: "jul", eatenAt: JUL, clientId: "cid-jul" }));
    expect(await findMealByClientId("cid-jul", 2, SEP)).toBeNull();
    expect((await findMealByClientId("cid-jul", 3, SEP))?.id).toBe("jul");
  });

  it("returns null for an unknown or empty clientId", async () => {
    const { appendMeal, findMealByClientId } = await loadStore();
    await appendMeal(meal({ clientId: "cid-a" }));
    expect(await findMealByClientId("nope", 2, SEP)).toBeNull();
    expect(await findMealByClientId("", 2, SEP)).toBeNull();
  });

  it("returns null when nothing has ever been written", async () => {
    const { findMealByClientId } = await loadStore();
    expect(await findMealByClientId("cid-a", 2, SEP)).toBeNull();
  });
});

describe("findMealById", () => {
  it("scans every shard on disk, however old", async () => {
    const { appendMeal, findMealById } = await loadStore();
    await appendMeal(meal({ id: "jul", eatenAt: JUL, clientId: "cid-jul" }));
    await appendMeal(meal({ id: "sep", eatenAt: SEP, clientId: "cid-sep" }));
    expect((await findMealById("jul"))?.clientId).toBe("cid-jul");
    expect((await findMealById("sep"))?.clientId).toBe("cid-sep");
  });

  it("returns null for an unknown id and for an empty id", async () => {
    const { appendMeal, findMealById } = await loadStore();
    await appendMeal(meal({ id: "a" }));
    expect(await findMealById("b")).toBeNull();
    expect(await findMealById("")).toBeNull();
  });
});

describe("listMeals", () => {
  it("returns rows inside the window, newest first", async () => {
    const { appendMeal, listMeals } = await loadStore();
    const hour = 3600_000;
    await appendMeal(meal({ id: "old", eatenAt: SEP - 5 * hour, clientId: "c1" }));
    await appendMeal(meal({ id: "new", eatenAt: SEP - 1 * hour, clientId: "c2" }));
    await appendMeal(meal({ id: "mid", eatenAt: SEP - 3 * hour, clientId: "c3" }));

    const rows = await listMeals(SEP - 6 * hour, SEP);
    expect(rows.map((m) => m.id)).toEqual(["new", "mid", "old"]);
  });

  it("excludes rows older than the window", async () => {
    const { appendMeal, listMeals } = await loadStore();
    const hour = 3600_000;
    await appendMeal(meal({ id: "inside", eatenAt: SEP - hour, clientId: "c1" }));
    await appendMeal(meal({ id: "outside", eatenAt: SEP - 10 * hour, clientId: "c2" }));

    const rows = await listMeals(SEP - 2 * hour, SEP);
    expect(rows.map((m) => m.id)).toEqual(["inside"]);
  });

  it("includes a row exactly on the boundary", async () => {
    const { appendMeal, listMeals } = await loadStore();
    await appendMeal(meal({ id: "edge", eatenAt: SEP - 3600_000, clientId: "c1" }));
    expect((await listMeals(SEP - 3600_000, SEP)).map((m) => m.id)).toEqual(["edge"]);
  });

  // A 24-hour read on the 1st of a month must reach back into the previous
  // month's shard, or the last night's rescue carbs vanish from the UI.
  it("spans a month boundary", async () => {
    const { appendMeal, listMeals } = await loadStore();
    const now = Date.parse("2026-09-01T06:00:00.000Z");
    await appendMeal(meal({ id: "aug31", eatenAt: Date.parse("2026-08-31T20:00:00.000Z"), clientId: "c1" }));
    await appendMeal(meal({ id: "sep01", eatenAt: Date.parse("2026-09-01T05:00:00.000Z"), clientId: "c2" }));

    const rows = await listMeals(now - 24 * 3600_000, now);
    expect(rows.map((m) => m.id)).toEqual(["sep01", "aug31"]);
  });

  // eatenAt may be up to 5 minutes ahead of the server clock, which can put the
  // row in the NEXT month's shard when now sits at a month boundary.
  it("still sees a slightly-future row filed in the next month's shard", async () => {
    const { appendMeal, listMeals } = await loadStore();
    const now = Date.parse("2026-08-31T23:58:00.000Z");
    await appendMeal(meal({ id: "ahead", eatenAt: Date.parse("2026-09-01T00:01:00.000Z"), clientId: "c1" }));

    const rows = await listMeals(now - 3600_000, now);
    expect(rows.map((m) => m.id)).toEqual(["ahead"]);
  });

  it("spans several months when the window is long", async () => {
    const { appendMeal, listMeals } = await loadStore();
    await appendMeal(meal({ id: "jul", eatenAt: JUL, clientId: "c1" }));
    await appendMeal(meal({ id: "aug", eatenAt: AUG, clientId: "c2" }));
    await appendMeal(meal({ id: "sep", eatenAt: SEP, clientId: "c3" }));

    const rows = await listMeals(JUL - 1000, SEP);
    expect(rows.map((m) => m.id)).toEqual(["sep", "aug", "jul"]);
  });

  it("returns an empty array when nothing is stored", async () => {
    const { listMeals } = await loadStore();
    expect(await listMeals(SEP - 3600_000, SEP)).toEqual([]);
  });

  it("skips rows with a non-numeric eatenAt rather than throwing", async () => {
    const { appendMeal, listMeals } = await loadStore();
    await appendMeal(meal({ id: "good", clientId: "c1" }));
    await appendMeal({ ...meal({ id: "bad", clientId: "c2" }), eatenAt: "oops" as unknown as number });
    // The bad row lands in whatever shard "oops" derives to; the good one is
    // still returned and nothing throws.
    const rows = await listMeals(SEP - 3600_000, SEP);
    expect(rows.map((m) => m.id)).toEqual(["good"]);
  });
});

describe("removeMeal", () => {
  it("removes the row and leaves its siblings", async () => {
    const { appendMeal, removeMeal, findMealById } = await loadStore();
    await appendMeal(meal({ id: "a", clientId: "c1" }));
    await appendMeal(meal({ id: "b", clientId: "c2" }));

    expect(await removeMeal("a")).toBe(true);
    expect(await findMealById("a")).toBeNull();
    expect((await findMealById("b"))?.id).toBe("b");
  });

  it("removes from an older shard too", async () => {
    const { appendMeal, removeMeal, findMealById } = await loadStore();
    await appendMeal(meal({ id: "jul", eatenAt: JUL, clientId: "c1" }));
    expect(await removeMeal("jul")).toBe(true);
    expect(await findMealById("jul")).toBeNull();
  });

  it("returns false for an unknown id, an empty id, and an empty store", async () => {
    const { appendMeal, removeMeal } = await loadStore();
    expect(await removeMeal("nope")).toBe(false);
    await appendMeal(meal({ id: "a" }));
    expect(await removeMeal("nope")).toBe(false);
    expect(await removeMeal("")).toBe(false);
  });

  it("is idempotent — a second delete is a no-op, not an error", async () => {
    const { appendMeal, removeMeal } = await loadStore();
    await appendMeal(meal({ id: "a" }));
    expect(await removeMeal("a")).toBe(true);
    expect(await removeMeal("a")).toBe(false);
  });
});

describe("durable meal operations", () => {
  it("keeps concurrent unique entries and commits repeated IDs only once", async () => {
    const store = await loadStore();
    const rows = Array.from({ length: 25 }, (_, i) => meal({ id: 'm' + i, clientId: 'c' + i }));
    await Promise.all([...rows, ...rows].map(row => store.appendMeal(row)));
    expect(await store.listMeals(SEP, SEP)).toHaveLength(25);
  });
  it("retains the original payload after a remote commit, local failure, and process restart", async () => {
    const store = await loadStore();
    const { logUncoveredCarbs } = await import("../log-uncovered");
    const remote = new Map<string, unknown>();
    const postTreatment = vi.fn(async (doc) => { remote.set(doc._id, doc); return { _id: doc._id }; });
    const value = { clientId: "retry-1", grams: 15, carbClass: "rescue" as const, reason: "low" as const, eatenAt: SEP };
    await expect(logUncoveredCarbs(value, "patient", {
      postTreatment, now: () => SEP, uuid: () => crypto.randomUUID(),
      store: { ...store, appendMeal: async () => { throw new Error("disk full"); } },
    })).rejects.toThrow("disk full");
    expect(await store.listMeals(SEP, SEP)).toHaveLength(0);
    const original = [...remote.values()][0];
    vi.resetModules();
    const recovered = await loadStore();
    const logger = await import("../log-uncovered");
    const deps = { postTreatment, store: recovered, now: () => SEP + 60_000, uuid: () => crypto.randomUUID() };
    await Promise.all(Array.from({ length: 3 }, () => logger.logUncoveredCarbs({ ...value, eatenAt: SEP + 60_000 }, "patient", deps)));
    expect(remote.size).toBe(1);
    expect([...remote.values()][0]).toEqual(original);
    expect(await recovered.listMeals(SEP, SEP)).toHaveLength(1);
  });
  it("does not send to Nightscout if the reservation cannot be persisted", async () => {
    const { logUncoveredCarbs } = await import("../log-uncovered");
    const store = await loadStore();
    const postTreatment = vi.fn();
    await expect(logUncoveredCarbs({ clientId: "x", grams: 15, carbClass: "rescue", reason: "low", eatenAt: SEP }, "patient", {
      postTreatment, now: () => SEP, uuid: () => crypto.randomUUID(),
      store: { ...store, reserveMeal: async () => { throw new Error("disk full"); } },
    })).rejects.toThrow("disk full");
    expect(postTreatment).not.toHaveBeenCalled();
  });
});
