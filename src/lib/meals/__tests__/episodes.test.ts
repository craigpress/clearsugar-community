import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MealEpisode } from "../types";

// local-store reads CLEARSUGAR_DATA_DIR at module load, so the env var must be
// set and the module registry reset before episodes.ts is imported.
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cs-episodes-"));
  process.env.CLEARSUGAR_DATA_DIR = dir;
  vi.resetModules();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function loadEpisodes() {
  return import("../episodes");
}

const MIN = 60_000;
const SEP = Date.parse("2026-09-04T18:00:00.000Z");
const AUG = Date.parse("2026-08-20T12:00:00.000Z");

function episode(over: Partial<MealEpisode> = {}): MealEpisode {
  return {
    id: "ep-1",
    openedAt: SEP,
    expiresAt: SEP + 120 * MIN,
    trigger: "pump_bolus",
    status: "open",
    promptCount: 0,
    shadow: true,
    ...over,
  };
}

describe("episode shards", () => {
  it("files an episode under meals/episodes/<yyyy-mm>.json", async () => {
    const store = await loadEpisodes();
    await store.appendEpisode(episode());
    expect(await readdir(join(dir, "meals", "episodes"))).toEqual(["2026-09.json"]);
  });

  it("splits months and reads both back newest first", async () => {
    const store = await loadEpisodes();
    await store.appendEpisode(episode({ id: "sep", openedAt: SEP }));
    await store.appendEpisode(episode({ id: "aug", openedAt: AUG }));
    expect((await readdir(join(dir, "meals", "episodes"))).sort()).toEqual([
      "2026-08.json",
      "2026-09.json",
    ]);
    const all = await store.listEpisodes(AUG - MIN, SEP);
    expect(all.map((e) => e.id)).toEqual(["sep", "aug"]);
  });

  it("excludes episodes older than the window", async () => {
    const store = await loadEpisodes();
    await store.appendEpisode(episode({ id: "old", openedAt: SEP - 48 * 60 * MIN }));
    await store.appendEpisode(episode({ id: "new", openedAt: SEP - 60 * MIN }));
    const recent = await store.listEpisodes(SEP - 24 * 60 * MIN, SEP);
    expect(recent.map((e) => e.id)).toEqual(["new"]);
  });

  it("updates in place and returns null for an unknown id", async () => {
    const store = await loadEpisodes();
    await store.appendEpisode(episode());
    const updated = await store.updateEpisode(
      episode({ status: "prompted", promptCount: 1, promptedAt: SEP })
    );
    expect(updated?.status).toBe("prompted");
    const found = await store.findEpisodeById("ep-1");
    expect(found?.promptCount).toBe(1);
    expect(await store.updateEpisode(episode({ id: "nope" }))).toBeNull();
  });
});

describe("findByPumpKey", () => {
  it("finds by pumpEventId and prefers it over bolusId", async () => {
    const store = await loadEpisodes();
    await store.appendEpisode(episode({ pumpEventId: "pump-1", bolusId: "t-1" }));
    expect((await store.findByPumpKey("pump-1"))?.id).toBe("ep-1");
    expect(await store.findByPumpKey("t-1")).toBeNull();
  });

  it("falls back to bolusId when the pump event id is absent", async () => {
    const store = await loadEpisodes();
    await store.appendEpisode(episode({ bolusId: "t-2" }));
    expect((await store.findByPumpKey("t-2"))?.id).toBe("ep-1");
  });

  it("is status-blind: an expired episode still blocks a second prompt", async () => {
    const store = await loadEpisodes();
    await store.appendEpisode(
      episode({ pumpEventId: "pump-9", status: "expired" })
    );
    expect((await store.findByPumpKey("pump-9"))?.status).toBe("expired");
  });

  it("returns null for an empty key", async () => {
    const store = await loadEpisodes();
    expect(await store.findByPumpKey("")).toBeNull();
  });
});

describe("findOpenEpisodeNear", () => {
  it("absorbs an event inside [anchor-30, anchor+90]", async () => {
    const store = await loadEpisodes();
    const anchor = SEP - 30 * MIN;
    await store.appendEpisode(
      episode({ trigger: "glucose_rise", riseDetectedAt: anchor, openedAt: anchor })
    );
    expect(await store.findOpenEpisodeNear(anchor + 60 * MIN, 30, 90, SEP)).not.toBeNull();
    expect(await store.findOpenEpisodeNear(anchor - 20 * MIN, 30, 90, SEP)).not.toBeNull();
  });

  it("does not absorb an event outside the window", async () => {
    const store = await loadEpisodes();
    const anchor = SEP - 30 * MIN;
    await store.appendEpisode(
      episode({ trigger: "glucose_rise", riseDetectedAt: anchor, openedAt: anchor })
    );
    expect(await store.findOpenEpisodeNear(anchor + 91 * MIN, 30, 90, SEP)).toBeNull();
    expect(await store.findOpenEpisodeNear(anchor - 31 * MIN, 30, 90, SEP)).toBeNull();
  });

  it("ignores final statuses", async () => {
    const store = await loadEpisodes();
    for (const status of ["reconciled", "expired", "closed"] as const) {
      await store.appendEpisode(
        episode({ id: `ep-${status}`, status, riseDetectedAt: SEP })
      );
    }
    expect(await store.findOpenEpisodeNear(SEP, 30, 90, SEP)).toBeNull();
  });

  it("keeps an answered episode absorbing (a late bolus must still pair)", async () => {
    const store = await loadEpisodes();
    await store.appendEpisode(
      episode({ status: "answered", trigger: "glucose_rise", riseDetectedAt: SEP })
    );
    expect((await store.findOpenEpisodeNear(SEP + 45 * MIN, 30, 90, SEP))?.id).toBe("ep-1");
  });

  it("returns the newest-anchored candidate when two overlap", async () => {
    const store = await loadEpisodes();
    await store.appendEpisode(
      episode({ id: "older", riseDetectedAt: SEP - 80 * MIN, trigger: "glucose_rise" })
    );
    await store.appendEpisode(
      episode({ id: "newer", riseDetectedAt: SEP - 10 * MIN, trigger: "glucose_rise" })
    );
    expect((await store.findOpenEpisodeNear(SEP, 30, 90, SEP))?.id).toBe("newer");
  });
});

describe("episodeAnchor", () => {
  it("prefers the eating tap, then the bolus, then the rise", async () => {
    const { episodeAnchor } = await loadEpisodes();
    expect(episodeAnchor(episode({ eatingAt: 3, bolusAt: 2, riseDetectedAt: 1 }))).toBe(3);
    expect(episodeAnchor(episode({ bolusAt: 2, riseDetectedAt: 1 }))).toBe(2);
    expect(episodeAnchor(episode({ riseDetectedAt: 1 }))).toBe(1);
    expect(episodeAnchor(episode())).toBe(SEP);
  });
});

describe("listActiveEpisodes", () => {
  it("returns only active episodes inside the lookback", async () => {
    const store = await loadEpisodes();
    await store.appendEpisode(episode({ id: "a", status: "open" }));
    await store.appendEpisode(episode({ id: "b", status: "closed" }));
    await store.appendEpisode(
      episode({ id: "c", status: "open", openedAt: SEP - 40 * 60 * MIN })
    );
    const active = await store.listActiveEpisodes(SEP, 24 * 60);
    expect(active.map((e) => e.id)).toEqual(["a"]);
  });
});

describe("findEpisodeByClientId", () => {
  it("replays an eating-now tap", async () => {
    const store = await loadEpisodes();
    await store.appendEpisode(
      episode({ trigger: "eating_now", eatingAt: SEP, clientId: "cid-1" })
    );
    expect((await store.findEpisodeByClientId("cid-1", 2, SEP))?.id).toBe("ep-1");
    expect(await store.findEpisodeByClientId("cid-2", 2, SEP)).toBeNull();
  });
});

describe("prompt state", () => {
  it("defaults to today with a zero counter", async () => {
    const store = await loadEpisodes();
    const state = await store.loadPromptState(SEP);
    expect(state.promptCount).toBe(0);
    expect(state.dayKey).toBe(store.promptDayKey(SEP));
    expect(state.riseSuppressedUntil).toBeUndefined();
  });

  it("round-trips the counter and the suppression", async () => {
    const store = await loadEpisodes();
    const dayKey = store.promptDayKey(SEP);
    await store.savePromptState({
      dayKey,
      promptCount: 3,
      riseSuppressedUntil: SEP + 60 * MIN,
    });
    const state = await store.loadPromptState(SEP);
    expect(state.promptCount).toBe(3);
    expect(state.riseSuppressedUntil).toBe(SEP + 60 * MIN);
    expect(await store.dailyPromptCount(dayKey)).toBe(3);
  });

  it("reports a stale day's counter as zero without rewriting it", async () => {
    const store = await loadEpisodes();
    await store.savePromptState({ dayKey: "2026-09-01", promptCount: 4 });
    const state = await store.loadPromptState(SEP);
    expect(state.promptCount).toBe(0);
    expect(state.dayKey).toBe(store.promptDayKey(SEP));
    // dailyPromptCount is day-scoped, so the old day is still 4 on disk.
    expect(await store.dailyPromptCount("2026-09-01")).toBe(4);
    expect(await store.dailyPromptCount(store.promptDayKey(SEP))).toBe(0);
  });

  it("treats a suppression in the past as expired", async () => {
    const store = await loadEpisodes();
    expect(
      store.riseSuppressed({ dayKey: "x", promptCount: 0, riseSuppressedUntil: SEP - 1 }, SEP)
    ).toBe(false);
    expect(
      store.riseSuppressed({ dayKey: "x", promptCount: 0, riseSuppressedUntil: SEP + 1 }, SEP)
    ).toBe(true);
    expect(store.riseSuppressed({ dayKey: "x", promptCount: 0 }, SEP)).toBe(false);
  });
});

describe("newEpisode", () => {
  it("sets the 120-minute TTL and the open defaults", async () => {
    const { newEpisode, EPISODE_TTL_MIN } = await loadEpisodes();
    const ep = newEpisode({ id: "n1", trigger: "glucose_rise", shadow: true }, SEP);
    expect(ep.status).toBe("open");
    expect(ep.promptCount).toBe(0);
    expect(ep.openedAt).toBe(SEP);
    expect(ep.expiresAt).toBe(SEP + EPISODE_TTL_MIN * MIN);
    expect(EPISODE_TTL_MIN).toBe(120);
  });
});
