import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DEFAULT_DAILY_CAP,
  MAX_PROMPT_AGE_MIN,
  dailyCap,
  isMealPromptShadow,
  runDetectTick,
  type DetectDeps,
  type DetectEpisodeStore,
} from "../detect";
import {
  PAIR_AFTER_MIN,
  PAIR_BEFORE_MIN,
  episodeAnchor,
  isActive,
} from "../episodes";
import { NO_REPLY_SUPPRESSION_MIN } from "../pairing";
import type { MealEpisode, PromptState } from "../types";
import type { GlucoseReading, Treatment } from "@/lib/types";

const MIN = 60_000;
const NOW = Date.parse("2026-09-04T18:00:00.000Z"); // 2:00 pm ET

// ── fakes ─────────────────────────────────────────────────────────────────────

/** In-memory episode store with the same window/key semantics as the real one. */
function fakeStore(seed: MealEpisode[] = [], state?: Partial<PromptState>) {
  const rows: MealEpisode[] = [...seed];
  let promptState: PromptState = {
    dayKey: "2026-09-04",
    promptCount: 0,
    ...state,
  };
  const store: DetectEpisodeStore & {
    rows: MealEpisode[];
    state: () => PromptState;
    appended: number;
    updated: number;
    saved: number;
  } = {
    rows,
    appended: 0,
    updated: 0,
    saved: 0,
    state: () => promptState,
    async appendEpisode(ep) {
      rows.push(ep);
      store.appended += 1;
      return ep;
    },
    async updateEpisode(ep) {
      const i = rows.findIndex((r) => r.id === ep.id);
      if (i < 0) return null;
      rows[i] = ep;
      store.updated += 1;
      return ep;
    },
    async findByPumpKey(key) {
      return rows.find((r) => (r.pumpEventId ?? r.bolusId) === key) ?? null;
    },
    async findOpenEpisodeNear(at, before = PAIR_BEFORE_MIN, after = PAIR_AFTER_MIN) {
      return (
        rows
          .filter(
            (r) =>
              isActive(r) &&
              at >= episodeAnchor(r) - before * MIN &&
              at <= episodeAnchor(r) + after * MIN
          )
          .sort((a, b) => episodeAnchor(b) - episodeAnchor(a))[0] ?? null
      );
    },
    async listActiveEpisodes() {
      return rows.filter(isActive);
    },
    async loadPromptState() {
      return { ...promptState };
    },
    async savePromptState(s) {
      promptState = { ...s };
      store.saved += 1;
    },
  };
  return store;
}

function mealBolus(atMs: number, over: Partial<Treatment> = {}): Treatment {
  return {
    _id: "t-1",
    eventType: "Meal Bolus",
    created_at: new Date(atMs).toISOString(),
    enteredBy: "tconnectsync",
    mills: atMs,
    utcOffset: 0,
    insulin: 6.2,
    carbs: 55,
    pump_event_id: "pump-1",
    ...over,
  };
}

function reading(atMs: number, sgv: number): GlucoseReading {
  return {
    _id: `e-${atMs}`,
    sgv,
    date: atMs,
    dateString: new Date(atMs).toISOString(),
    direction: "Flat",
    trend: 4,
    device: "test",
    type: "sgv",
    mills: atMs,
  };
}

/** Six readings ending at `now`, climbing by `step` from `start`. */
function risingTrace(now: number, start = 118, step = 8): GlucoseReading[] {
  return [25, 20, 15, 10, 5, 0].map((ago, i) => reading(now - ago * MIN, start + i * step));
}

function flatTrace(now: number, sgv = 120): GlucoseReading[] {
  return [25, 20, 15, 10, 5, 0].map((ago) => reading(now - ago * MIN, sgv));
}

interface DepsOverride {
  treatments?: Treatment[];
  readings?: GlucoseReading[];
  tokens?: string[];
  sleep?: boolean;
  env?: Record<string, string | undefined>;
  store?: ReturnType<typeof fakeStore>;
  pushImpl?: DetectDeps["push"];
  prunePhotos?: (days?: number) => Promise<{ deleted: number }>;
  rescueEvents?: number[];
}

function makeDeps(over: DepsOverride = {}) {
  const store = over.store ?? fakeStore();
  const push = vi.fn(over.pushImpl ?? (async () => ({ success: true, status: 200 })));
  let seq = 0;
  const deps: DetectDeps = {
    getTreatments: async () => over.treatments ?? [],
    getEntries: async () => over.readings ?? flatTrace(NOW),
    loadPrefs: async () => ({}),
    loadIdentities: async () => ({}),
    patientTokens: () => over.tokens ?? ["patient-token"],
    push,
    isPumpSleep: () => over.sleep === true,
    episodes: store,
    prunePhotos: over.prunePhotos,
    rescueEvents: () => over.rescueEvents ?? [],
    uuid: () => `ep-${++seq}`,
    env: over.env ?? { MEAL_PROMPT_SHADOW: "false" },
  };
  return { deps, store, push };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ── env gates ─────────────────────────────────────────────────────────────────

describe("env gates", () => {
  it("is shadow unless MEAL_PROMPT_SHADOW is exactly 'false'", () => {
    expect(isMealPromptShadow({})).toBe(true);
    expect(isMealPromptShadow({ MEAL_PROMPT_SHADOW: "true" })).toBe(true);
    expect(isMealPromptShadow({ MEAL_PROMPT_SHADOW: "" })).toBe(true);
    expect(isMealPromptShadow({ MEAL_PROMPT_SHADOW: "no" })).toBe(true);
    expect(isMealPromptShadow({ MEAL_PROMPT_SHADOW: "false" })).toBe(false);
    expect(isMealPromptShadow({ MEAL_PROMPT_SHADOW: "FALSE" })).toBe(false);
  });

  it("reads the shared daily cap, defaulting to 4", () => {
    expect(dailyCap({})).toBe(DEFAULT_DAILY_CAP);
    expect(dailyCap({ MEAL_PROMPT_DAILY_CAP: "2" })).toBe(2);
    expect(dailyCap({ MEAL_PROMPT_DAILY_CAP: "0" })).toBe(0);
    expect(dailyCap({ MEAL_PROMPT_DAILY_CAP: "nonsense" })).toBe(DEFAULT_DAILY_CAP);
  });
});

// ── (1) pump-bolus trigger ────────────────────────────────────────────────────

describe("pump-bolus candidates", () => {
  it("opens an episode and prompts once", async () => {
    const at = NOW - 50 * MIN;
    const { deps, store, push } = makeDeps({ treatments: [mealBolus(at)] });
    const res = await runDetectTick(deps, NOW);
    expect(res).toMatchObject({ shadow: false, opened: 1, prompted: 1, reconciled: 0 });
    expect(push).toHaveBeenCalledTimes(1);
    const call = push.mock.calls[0][0];
    expect(call.category).toBe("MEAL_PROMPT");
    expect(call.interruptionLevel).toBe("active");
    expect(call.body).toContain("bolus");
    // The bolus's OWN local time, not "just now" (the path is ~50 min late).
    expect(call.body).toContain("1:10 pm");
    expect(call.userInfo).toMatchObject({ kind: "meal_prompt", episodeId: "ep-1" });
    expect(store.rows[0]).toMatchObject({
      trigger: "pump_bolus",
      status: "prompted",
      promptCount: 1,
      pumpEventId: "pump-1",
      bolusInsulin: 6.2,
      bolusCarbs: 55,
    });
    expect(store.state().promptCount).toBe(1);
  });

  it("expires the episode 120 min after the BOLUS, not after the tick", async () => {
    const at = NOW - 70 * MIN;
    const { deps, store } = makeDeps({ treatments: [mealBolus(at)] });
    await runDetectTick(deps, NOW);
    expect(store.rows[0].expiresAt).toBe(at + MAX_PROMPT_AGE_MIN * MIN);
  });

  it("prompts once for the same pump key across two ticks", async () => {
    const at = NOW - 20 * MIN;
    const store = fakeStore();
    const first = makeDeps({ treatments: [mealBolus(at)], store });
    await runDetectTick(first.deps, NOW);
    const second = makeDeps({ treatments: [mealBolus(at)], store });
    const res = await runDetectTick(second.deps, NOW + 5 * MIN);
    expect(res.opened).toBe(0);
    expect(res.prompted).toBe(0);
    expect(second.push).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1);
  });

  it("collapses two documents that share a pump event id in one tick", async () => {
    const at = NOW - 20 * MIN;
    const { deps, store } = makeDeps({
      treatments: [mealBolus(at), mealBolus(at + MIN, { _id: "t-2" })],
    });
    const res = await runDetectTick(deps, NOW);
    expect(res.opened).toBe(1);
    expect(store.rows).toHaveLength(1);
  });

  it("ignores a bolus older than the 120-minute cutoff", async () => {
    const { deps, push } = makeDeps({
      treatments: [mealBolus(NOW - (MAX_PROMPT_AGE_MIN + 5) * MIN)],
    });
    const res = await runDetectTick(deps, NOW);
    expect(res.opened).toBe(0);
    expect(push).not.toHaveBeenCalled();
  });

  it("ignores an auto-bolus and a carb-free correction", async () => {
    const { deps, push } = makeDeps({
      treatments: [
        mealBolus(NOW - 10 * MIN, { notes: "Automatic Bolus", pump_event_id: "auto-1" }),
        mealBolus(NOW - 12 * MIN, { carbs: 0, pump_event_id: "corr-1", _id: "t-3" }),
      ],
    });
    const res = await runDetectTick(deps, NOW);
    expect(res.opened).toBe(0);
    expect(push).not.toHaveBeenCalled();
  });

  it("ignores a treatment tconnectsync does not own", async () => {
    const { deps } = makeDeps({
      treatments: [mealBolus(NOW - 10 * MIN, { enteredBy: "ClearSugar" })],
    });
    expect((await runDetectTick(deps, NOW)).opened).toBe(0);
  });
});

// ── (2) reconciliation ────────────────────────────────────────────────────────

describe("reconciliation", () => {
  it("pairs a bolus that lands 40 min after a prompted rise, with no second prompt", async () => {
    const riseAt = NOW - 40 * MIN;
    const rise: MealEpisode = {
      id: "rise-1",
      openedAt: riseAt,
      expiresAt: riseAt + 120 * MIN,
      trigger: "glucose_rise",
      status: "prompted",
      promptCount: 1,
      promptedAt: riseAt,
      lastPromptKind: "rise",
      shadow: false,
      riseDetectedAt: riseAt,
      riseSinceAt: riseAt - 30 * MIN,
    };
    const store = fakeStore([rise], { dayKey: "2026-09-04", promptCount: 1 });
    const { deps, push } = makeDeps({
      treatments: [mealBolus(NOW - 5 * MIN)],
      store,
    });
    const res = await runDetectTick(deps, NOW);
    expect(res).toMatchObject({ opened: 0, prompted: 0, reconciled: 1 });
    expect(push).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      id: "rise-1",
      status: "reconciled",
      pumpEventId: "pump-1",
      bolusCarbs: 55,
    });
    expect(store.rows[0].reconciledAt).toBe(NOW);
    expect(store.state().promptCount).toBe(1); // the cap was not charged twice
  });

  it("measures the delay when the episode came from an eating-now tap", async () => {
    const eatAt = NOW - 30 * MIN;
    const eating: MealEpisode = {
      id: "eat-1",
      openedAt: eatAt,
      expiresAt: eatAt + 120 * MIN,
      trigger: "eating_now",
      status: "open",
      promptCount: 0,
      shadow: false,
      eatingAt: eatAt,
    };
    const store = fakeStore([eating]);
    const { deps } = makeDeps({ treatments: [mealBolus(eatAt - 12 * MIN)], store });
    const res = await runDetectTick(deps, NOW);
    expect(res.reconciled).toBe(1);
    expect(store.rows[0].minutesBolusToEat).toBe(12);
  });

  it("does not pair a bolus outside the window", async () => {
    const riseAt = NOW - 100 * MIN;
    const store = fakeStore([
      {
        id: "rise-1",
        openedAt: riseAt,
        expiresAt: riseAt + 240 * MIN,
        trigger: "glucose_rise",
        status: "prompted",
        promptCount: 1,
        shadow: false,
        riseDetectedAt: riseAt,
      },
    ]);
    const { deps } = makeDeps({ treatments: [mealBolus(NOW - 2 * MIN)], store });
    const res = await runDetectTick(deps, NOW);
    expect(res.reconciled).toBe(0);
    expect(res.opened).toBe(1);
  });
});

// ── (3) rise trigger ──────────────────────────────────────────────────────────

describe("rise trigger", () => {
  it("opens a rise episode and prompts with the rise copy", async () => {
    const { deps, store, push } = makeDeps({ readings: risingTrace(NOW) });
    const res = await runDetectTick(deps, NOW);
    expect(res).toMatchObject({ opened: 1, prompted: 1 });
    expect(store.rows[0]).toMatchObject({
      trigger: "glucose_rise",
      status: "prompted",
      lastPromptKind: "rise",
      riseFromMgdl: 118,
      riseToMgdl: 158,
    });
    expect(push.mock.calls[0][0].body).toContain("Rising since");
  });

  it("does not fire during the pump Sleep window", async () => {
    const { deps, push } = makeDeps({ readings: risingTrace(NOW), sleep: true });
    const res = await runDetectTick(deps, NOW);
    expect(res.opened).toBe(0);
    expect(res.suppressed).toBe(1);
    expect(res.notes.join(" ")).toContain("Sleep");
    expect(push).not.toHaveBeenCalled();
  });

  it("does not fire when carbs were logged in the last 60 min", async () => {
    const carbs: Treatment = {
      _id: "c-1",
      eventType: "Carb Correction",
      created_at: new Date(NOW - 30 * MIN).toISOString(),
      enteredBy: "ClearSugar",
      mills: NOW - 30 * MIN,
      utcOffset: 0,
      carbs: 20,
    };
    const { deps } = makeDeps({ readings: risingTrace(NOW), treatments: [carbs] });
    const res = await runDetectTick(deps, NOW);
    expect(res.opened).toBe(0);
    expect(res.notes.join(" ")).toContain("carbs logged");
  });

  it("does not fire inside a No-reply suppression window", async () => {
    const store = fakeStore([], {
      riseSuppressedUntil: NOW + NO_REPLY_SUPPRESSION_MIN * MIN - MIN,
    });
    const { deps, push } = makeDeps({ readings: risingTrace(NOW), store });
    const res = await runDetectTick(deps, NOW);
    expect(res.opened).toBe(0);
    expect(res.suppressed).toBe(1);
    expect(res.notes.join(" ")).toContain("suppression");
    expect(push).not.toHaveBeenCalled();
  });

  it("fires again once the suppression has elapsed", async () => {
    const store = fakeStore([], { riseSuppressedUntil: NOW - MIN });
    const { deps } = makeDeps({ readings: risingTrace(NOW), store });
    expect((await runDetectTick(deps, NOW)).opened).toBe(1);
  });

  it("does not fire while another episode is open", async () => {
    const store = fakeStore([
      {
        id: "open-1",
        openedAt: NOW - 10 * MIN,
        expiresAt: NOW + 110 * MIN,
        trigger: "pump_bolus",
        status: "prompted",
        promptCount: 1,
        shadow: false,
        bolusAt: NOW - 10 * MIN,
        pumpEventId: "pump-x",
      },
    ]);
    const { deps } = makeDeps({ readings: risingTrace(NOW), store });
    const res = await runDetectTick(deps, NOW);
    expect(res.opened).toBe(0);
    // An open episode is the steady state, not a suppression worth counting.
    expect(res.suppressed).toBe(0);
  });

  it("skips a rise inside the rescue-carb low-recovery window", async () => {
    const { deps } = makeDeps({
      readings: risingTrace(NOW),
      rescueEvents: [NOW - 40 * MIN],
    });
    expect((await runDetectTick(deps, NOW)).opened).toBe(0);
  });
});

// ── (4) expiry ────────────────────────────────────────────────────────────────

describe("expiry", () => {
  it("expires an unanswered episode silently", async () => {
    const store = fakeStore([
      {
        id: "old-1",
        openedAt: NOW - 130 * MIN,
        expiresAt: NOW - 10 * MIN,
        trigger: "glucose_rise",
        status: "prompted",
        promptCount: 1,
        shadow: false,
        riseDetectedAt: NOW - 130 * MIN,
      },
    ]);
    const { deps, push } = makeDeps({ store });
    const res = await runDetectTick(deps, NOW);
    expect(res.expired).toBe(1);
    expect(store.rows[0].status).toBe("expired");
    expect(push).not.toHaveBeenCalled();
  });

  it("does not reconcile an episode whose TTL has elapsed", async () => {
    const riseAt = NOW - 130 * MIN;
    const store = fakeStore([
      {
        id: "rise-1",
        openedAt: riseAt,
        expiresAt: NOW - 10 * MIN,
        trigger: "glucose_rise",
        status: "answered",
        promptCount: 1,
        shadow: false,
        riseDetectedAt: riseAt,
      },
    ]);
    const { deps } = makeDeps({ treatments: [mealBolus(riseAt + 60 * MIN)], store });
    const res = await runDetectTick(deps, NOW);
    expect(res.reconciled).toBe(0);
    expect(res.expired).toBe(1);
    expect(store.rows[0].status).toBe("expired");
  });
});

// ── (5) prompting ─────────────────────────────────────────────────────────────

describe("prompting", () => {
  it("records the episode but sends nothing in shadow mode", async () => {
    const { deps, store, push } = makeDeps({
      treatments: [mealBolus(NOW - 20 * MIN)],
      env: {},
    });
    const res = await runDetectTick(deps, NOW);
    expect(res.shadow).toBe(true);
    expect(res.opened).toBe(1);
    expect(res.prompted).toBe(0);
    expect(push).not.toHaveBeenCalled();
    expect(store.rows[0]).toMatchObject({ shadow: true, status: "open", promptCount: 0 });
    expect(store.state().promptCount).toBe(0);
    expect(res.notes.join(" ")).toContain("shadow");
  });

  it("suppresses a prompt once the shared daily cap is reached", async () => {
    const store = fakeStore([], { dayKey: "2026-09-04", promptCount: 4 });
    const { deps, push } = makeDeps({
      treatments: [mealBolus(NOW - 20 * MIN)],
      store,
      env: { MEAL_PROMPT_SHADOW: "false", MEAL_PROMPT_DAILY_CAP: "4" },
    });
    const res = await runDetectTick(deps, NOW);
    expect(res.opened).toBe(1); // still recorded for the analytics
    expect(res.prompted).toBe(0);
    expect(res.suppressed).toBe(1);
    expect(res.notes.join(" ")).toContain("daily cap 4");
    expect(push).not.toHaveBeenCalled();
  });

  it("resets the counter on a new patient-local day", async () => {
    const store = fakeStore([], { dayKey: "2026-09-03", promptCount: 4 });
    const { deps, push } = makeDeps({ treatments: [mealBolus(NOW - 20 * MIN)], store });
    const res = await runDetectTick(deps, NOW);
    expect(res.prompted).toBe(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(store.state()).toMatchObject({ dayKey: "2026-09-04", promptCount: 1 });
  });

  it("delivers nothing when no patient device is assigned", async () => {
    const { deps, push, store } = makeDeps({
      treatments: [mealBolus(NOW - 20 * MIN)],
      tokens: [],
    });
    const res = await runDetectTick(deps, NOW);
    expect(res.prompted).toBe(0);
    expect(res.suppressed).toBe(1);
    expect(push).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
    expect(res.notes.join(" ")).toContain("no patient device");
    expect(store.rows[0].status).toBe("open"); // still recorded
  });

  it("drops to passive inside the Sleep window rather than buzzing a phone", async () => {
    const { deps, push } = makeDeps({
      treatments: [mealBolus(NOW - 20 * MIN)],
      sleep: true,
    });
    await runDetectTick(deps, NOW);
    expect(push.mock.calls[0][0].interruptionLevel).toBe("passive");
  });

  it("leaves the episode open and the cap uncharged when every push fails", async () => {
    const { deps, store, push } = makeDeps({
      treatments: [mealBolus(NOW - 20 * MIN)],
      pushImpl: async () => {
        throw new Error("APNs 410 BadDeviceToken");
      },
    });
    const res = await runDetectTick(deps, NOW);
    expect(res.prompted).toBe(0);
    expect(res.deliveryFailures).toBe(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(store.rows[0].status).toBe("open");
    expect(store.rows[0].promptCount).toBe(0);
    expect(store.state().promptCount).toBe(0);
  });

  it("counts a prompt delivered to one of two devices as delivered", async () => {
    const { deps, store } = makeDeps({
      treatments: [mealBolus(NOW - 20 * MIN)],
      tokens: ["good", "bad"],
      pushImpl: async ({ token }) => {
        if (token === "bad") throw new Error("410");
        return { success: true, status: 200 };
      },
    });
    const res = await runDetectTick(deps, NOW);
    expect(res.prompted).toBe(1);
    expect(res.deliveryFailures).toBe(1);
    expect(store.rows[0].status).toBe("prompted");
  });
});

// ── (6) photo prune ───────────────────────────────────────────────────────────

describe("photo prune", () => {
  it("prunes once per patient-local day with a 90-day retention", async () => {
    const prune = vi.fn(async () => ({ deleted: 3 }));
    const store = fakeStore();
    const first = makeDeps({ store, prunePhotos: prune });
    const res = await runDetectTick(first.deps, NOW);
    expect(res.pruned).toBe(3);
    expect(prune).toHaveBeenCalledWith(90);
    const second = makeDeps({ store, prunePhotos: prune });
    const res2 = await runDetectTick(second.deps, NOW + 5 * MIN);
    expect(res2.pruned).toBe(0);
    expect(prune).toHaveBeenCalledTimes(1);
  });

  it("survives a prune failure", async () => {
    const prune = vi.fn(async () => {
      throw new Error("EACCES");
    });
    const { deps } = makeDeps({ prunePhotos: prune });
    const res = await runDetectTick(deps, NOW);
    expect(res.pruned).toBe(0);
    expect(res.notes.join(" ")).toContain("photo prune failed");
  });

  it("skips the prune when the dependency is absent", async () => {
    const { deps } = makeDeps({});
    expect((await runDetectTick(deps, NOW)).pruned).toBe(0);
  });
});

// ── dry run ───────────────────────────────────────────────────────────────────

describe("dry run", () => {
  it("computes the same decisions and writes nothing", async () => {
    const prune = vi.fn(async () => ({ deleted: 1 }));
    const { deps, store, push } = makeDeps({
      treatments: [mealBolus(NOW - 20 * MIN)],
      prunePhotos: prune,
    });
    const res = await runDetectTick(deps, NOW, { dry: true });
    expect(res).toMatchObject({ opened: 1, prompted: 1 });
    expect(store.appended).toBe(0);
    expect(store.updated).toBe(0);
    expect(store.saved).toBe(0);
    expect(store.rows).toHaveLength(0);
    expect(prune).not.toHaveBeenCalled();
    // And it must never reach a phone.
    expect(push).not.toHaveBeenCalled();
  });
});

describe("delivery recovery and shadow policy", () => {
  it("retries after an APNs failure on a later tick without opening a second episode", async () => {
    const { deps, store, push } = makeDeps({ treatments: [mealBolus(NOW)] });
    push.mockRejectedValueOnce(new Error("APNs unavailable"));
    expect((await runDetectTick(deps, NOW)).deliveryFailures).toBe(1);
    expect((await runDetectTick(deps, NOW + 5 * MIN)).prompted).toBe(1);
    expect(store.rows).toHaveLength(1);
    expect(push).toHaveBeenCalledTimes(2);
    await runDetectTick(deps, NOW + 10 * MIN);
    expect(push).toHaveBeenCalledTimes(2);
  });
  it("applies the daily cap in shadow mode and does not re-count a would-send", async () => {
    const { deps, store, push } = makeDeps({ treatments: [mealBolus(NOW)], env: { MEAL_PROMPT_SHADOW: "true", MEAL_PROMPT_DAILY_CAP: "1" } });
    await runDetectTick(deps, NOW);
    await runDetectTick(deps, NOW + 5 * MIN);
    expect(store.state().shadowPromptCount).toBe(1);
    expect(store.state().promptCount).toBe(0);
    expect(push).not.toHaveBeenCalled();
    deps.getTreatments = async () => [mealBolus(NOW + 130 * MIN, { _id: "new", pump_event_id: "new" })];
    const result = await runDetectTick(deps, NOW + 130 * MIN);
    expect(result.notes).toContain("daily cap 1 reached");
  });
  it("honors snooze in shadow and live modes, then resumes eligible episodes", async () => {
    for (const shadow of ["true", "false"]) {
      const { deps, store, push } = makeDeps({ treatments: [mealBolus(NOW)], env: { MEAL_PROMPT_SHADOW: shadow } });
      deps.isSnoozed = async () => true;
      expect((await runDetectTick(deps, NOW)).notes).toContain("snoozed");
      expect(push).not.toHaveBeenCalled();
      expect(store.state().shadowPromptCount ?? 0).toBe(0);
      deps.isSnoozed = async () => false;
      await runDetectTick(deps, NOW + 5 * MIN);
      expect(shadow === "true" ? store.state().shadowPromptCount : store.state().promptCount).toBe(1);
    }
  });
  it("never replays a shadow episode as a live notification", async () => {
    const { deps, push } = makeDeps({ treatments: [mealBolus(NOW)], env: { MEAL_PROMPT_SHADOW: "true" } });
    await runDetectTick(deps, NOW);
    deps.env = { MEAL_PROMPT_SHADOW: "false" };
    await runDetectTick(deps, NOW + 5 * MIN);
    expect(push).not.toHaveBeenCalled();
  });
});
