/**
 * ClearSugar — meal-prompt detection tick (section 4c, steps 1-6)
 *
 * One tick of the 5-minute timer, as a pure orchestrator over injected deps so
 * every branch is testable without Nightscout, APNs or the filesystem.
 *
 * The order is load-bearing:
 *   1. pump-bolus candidates   — isMealBolus, age <= 120 min, not already keyed
 *   2. reconciliation          — a candidate absorbed by an open rise/eating
 *                                episode annotates it and must NOT prompt again
 *   3. rise candidates         — only when nothing else explains the rise
 *   4. expiry                  — silent, at expiresAt
 *   5. prompting               — patient devices only, shared daily cap, one
 *                                prompt per episode ever, skipped in shadow
 *   6. photo prune             — once per patient-local day
 *
 * Safety posture, all three from the plan's risk list:
 *   - SHADOW BY DEFAULT. `MEAL_PROMPT_SHADOW !== "false"` means shadow, so an
 *     env that forgot the variable cannot start pushing (advisor precedent).
 *   - An empty `patientTokens()` is "do not deliver", never "deliver to
 *     everyone": a meal prompt must never reach a parent's phone.
 *   - Nothing here writes a carb-bearing treatment. Only feature A does.
 */

import { isMealBolus, treatmentKey } from "@/lib/treatment-classify";
import { treatmentTime } from "@/lib/time";
import type { GlucoseReading, Treatment } from "@/lib/types";
import {
  EPISODE_TTL_MIN,
  PAIR_AFTER_MIN,
  PAIR_BEFORE_MIN,
  episodeAnchor,
  isActive,
  newEpisode,
  promptDayKey,
  riseSuppressed,
} from "./episodes";
import { pairEpisodeWithBolus } from "./pairing";
import { MEAL_PROMPT_CATEGORY, promptCopy, promptUserInfo } from "./prompt-copy";
import { detectRise, type RiseOpts } from "./rise-detector";
import type { MealEpisode, PromptState } from "./types";

const MIN = 60_000;

/** A bolus older than this is not worth asking about (decision 3). */
export const MAX_PROMPT_AGE_MIN = 120;
/** Default shared daily cap across both triggers (decision 3). */
export const DEFAULT_DAILY_CAP = 4;
/** No rise prompt when carbs are already logged this recently. */
export const RISE_NO_CARB_LOOKBACK_MIN = 60;

/** Only the episode-store surface a tick needs, so tests can pass a fake. */
export interface DetectEpisodeStore {
  appendEpisode(ep: MealEpisode): Promise<MealEpisode>;
  updateEpisode(ep: MealEpisode): Promise<MealEpisode | null>;
  findByPumpKey(key: string): Promise<MealEpisode | null>;
  findOpenEpisodeNear(
    anchorMs: number,
    before?: number,
    after?: number
  ): Promise<MealEpisode | null>;
  listActiveEpisodes(nowMs: number): Promise<MealEpisode[]>;
  loadPromptState(nowMs: number): Promise<PromptState>;
  savePromptState(state: PromptState): Promise<void>;
}

export interface DetectDeps {
  getTreatments(count: number, maxAgeMs: number): Promise<Treatment[]>;
  getEntries(count: number, maxAgeMs: number): Promise<GlucoseReading[]>;
  /** `loadAlertPrefs` / `loadIdentities` from api/alerts/preferences. Typed as
   *  `unknown` so this module does not depend on that route's private map
   *  types; the route narrows them where it builds the deps. */
  loadPrefs(): Promise<unknown>;
  loadIdentities(): Promise<unknown>;
  /** Tokens of devices assigned to the patient. [] means DO NOT DELIVER. */
  patientTokens(prefs: unknown, identities: unknown): string[];
  /** One APNs alert push. Rejects on failure, like pushAlertNotification. */
  push(args: {
    token: string;
    title: string;
    body: string;
    category: string;
    interruptionLevel: "passive" | "active" | "time-sensitive";
    userInfo: Record<string, unknown>;
    collapseId: string;
  }): Promise<unknown>;
  /** Pump Sleep-schedule quiet gate, already bound to the pump state. */
  isPumpSleep(atMs: number): boolean;
  isSnoozed?: (atMs: number) => Promise<boolean>;
  episodes: DetectEpisodeStore;
  /** Feature C's photo retention job (decision 1). Optional: absent = skip. */
  prunePhotos?: (maxAgeDays?: number) => Promise<{ deleted: number }>;
  /** Inferred rescue-carb timestamps, for the rise low-recovery exclusion. */
  rescueEvents?: (readings: GlucoseReading[], treatments: Treatment[]) => number[];
  uuid(): string;
  env?: Record<string, string | undefined>;
  riseOpts?: RiseOpts;
}

export interface DetectTickResult {
  shadow: boolean;
  opened: number;
  prompted: number;
  reconciled: number;
  expired: number;
  suppressed: number;
  pruned: number;
  /** Push attempts that failed; the episode stays open for the next tick. */
  deliveryFailures: number;
  /** Why candidates were suppressed — shadow-week observability. */
  notes: string[];
}

/** Shadow unless MEAL_PROMPT_SHADOW is explicitly "false" — safe default. */
export function isMealPromptShadow(env: Record<string, string | undefined>): boolean {
  return (env.MEAL_PROMPT_SHADOW ?? "true").toLowerCase() !== "false";
}

/** Shared daily cap, from MEAL_PROMPT_DAILY_CAP (default 4). */
export function dailyCap(env: Record<string, string | undefined>): number {
  const raw = env.MEAL_PROMPT_DAILY_CAP;
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DAILY_CAP;
}

/** Photo retention in days (decision 1). */
const PHOTO_RETENTION_DAYS = 90;

/** Was any carb-bearing treatment logged within `withinMin` of `now`? */
function hasRecentCarbs(treatments: Treatment[], now: number, withinMin: number): boolean {
  const floor = now - withinMin * MIN;
  return treatments.some((t) => {
    const carbs = t.carbs ?? 0;
    if (carbs <= 0) return false;
    const at = treatmentTime(t);
    return Number.isFinite(at) && at >= floor && at <= now + 5 * MIN;
  });
}

/**
 * Run one detection tick.
 *
 * `opts.dry` computes exactly the same decisions and writes nothing — no
 * episode, no prompt state, no push, no prune. `GET /api/meals/detect?dry=1`
 * uses it, and so do the tests that assert "recorded but not pushed".
 */
export async function runDetectTick(
  deps: DetectDeps,
  now: number,
  opts: { dry?: boolean } = {}
): Promise<DetectTickResult> {
  const env = deps.env ?? process.env;
  const dry = opts.dry === true;
  const shadow = isMealPromptShadow(env);
  const cap = dailyCap(env);
  const result: DetectTickResult = {
    shadow,
    opened: 0,
    prompted: 0,
    reconciled: 0,
    expired: 0,
    suppressed: 0,
    pruned: 0,
    deliveryFailures: 0,
    notes: [],
  };

  const [treatments, readings] = await Promise.all([
    deps.getTreatments(300, 8 * 60 * 60 * 1000),
    deps.getEntries(72, 6 * 60 * 60 * 1000),
  ]);

  const state = await deps.episodes.loadPromptState(now);
  let stateDirty = false;
  const dayKey = promptDayKey(now);
  if (state.dayKey !== dayKey) {
    state.dayKey = dayKey;
    state.promptCount = 0;
    state.shadowPromptCount = 0;
    stateDirty = true;
  }

  // Episodes newly written this tick are held here as well as persisted, so a
  // second candidate in the same tick sees them (the store is read-through).
  const openedThisTick: MealEpisode[] = [];
  const pumpKeysThisTick = new Set<string>();
  // Episodes already rewritten this tick, so expiry cannot overwrite the
  // `reconciled` status a pairing just set.
  const handledIds = new Set<string>();

  const persist = async (ep: MealEpisode, isNew: boolean): Promise<void> => {
    if (dry) return;
    if (isNew) await deps.episodes.appendEpisode(ep);
    else await deps.episodes.updateEpisode(ep);
  };

  const findAbsorbing = async (atMs: number): Promise<MealEpisode | null> => {
    const local = openedThisTick
      .filter(
        (ep) =>
          isActive(ep) &&
          atMs >= episodeAnchor(ep) - PAIR_BEFORE_MIN * MIN &&
          atMs <= episodeAnchor(ep) + PAIR_AFTER_MIN * MIN
      )
      .sort((a, b) => episodeAnchor(b) - episodeAnchor(a));
    if (local[0]) return local[0];
    const existing = await deps.episodes.findOpenEpisodeNear(atMs, PAIR_BEFORE_MIN, PAIR_AFTER_MIN);
    return existing && existing.expiresAt > now ? existing : null;
  };

  // ── (1) + (2) pump-bolus candidates and reconciliation ──────────────────────
  const promptQueue: { episode: MealEpisode; kind: "bolus" | "rise" }[] = [];
  const ageFloor = now - MAX_PROMPT_AGE_MIN * MIN;
  const candidates = treatments
    .filter((t) => isMealBolus(t))
    .map((t) => ({ t, at: treatmentTime(t) }))
    .filter(({ at }) => Number.isFinite(at) && at >= ageFloor && at <= now + 5 * MIN)
    .sort((a, b) => a.at - b.at);

  for (const { t, at } of candidates) {
    const key = treatmentKey(t);
    if (!key) continue;
    // "One prompt per bolus, ever": status-blind, so an expired or closed
    // episode for this pump event still blocks a second prompt.
    if (pumpKeysThisTick.has(key)) continue;
    if (await deps.episodes.findByPumpKey(key)) continue;

    const absorbing = await findAbsorbing(at);
    if (absorbing) {
      // Reconciliation: the rise (or eating) trigger already asked about this
      // meal. Annotate that episode and do NOT prompt again (risk 3).
      const paired = pairEpisodeWithBolus(absorbing, t, now);
      await persist(paired, false);
      const idx = openedThisTick.findIndex((e) => e.id === paired.id);
      if (idx >= 0) openedThisTick[idx] = paired;
      pumpKeysThisTick.add(key);
      handledIds.add(paired.id);
      result.reconciled += 1;
      continue;
    }

    const ep = newEpisode(
      {
        id: deps.uuid(),
        trigger: "pump_bolus",
        shadow,
        bolusId: t._id,
        bolusLinkSource: "pump_trigger",
        pumpEventId: t.pump_event_id,
        bolusAt: at,
        bolusInsulin: t.insulin ?? undefined,
        bolusCarbs: t.carbs ?? undefined,
      },
      now
    );
    // The TTL runs from the BOLUS, not from now: a bolus that reached us 70
    // minutes late must not buy itself a fresh 2-hour window.
    ep.expiresAt = at + EPISODE_TTL_MIN * MIN;
    await persist(ep, true);
    openedThisTick.push(ep);
    pumpKeysThisTick.add(key);
    result.opened += 1;
    promptQueue.push({ episode: ep, kind: "bolus" });
  }

  // ── (3) glucose-rise candidate ──────────────────────────────────────────────
  const activeExisting = await deps.episodes.listActiveEpisodes(now);
  const anyActive = activeExisting.length > 0 || openedThisTick.some(isActive);
  const riseBlocked: string | null = anyActive
    ? "open episode"
    : hasRecentCarbs(treatments, now, RISE_NO_CARB_LOOKBACK_MIN)
      ? "carbs logged in the last 60 min"
      : deps.isPumpSleep(now)
        ? "pump Sleep window"
        : riseSuppressed(state, now)
          ? "no-reply suppression"
          : null;

  if (riseBlocked === null) {
    const rescueEvents = deps.rescueEvents?.(readings, treatments) ?? [];
    const rise = detectRise(readings, now, { ...deps.riseOpts, rescueEvents });
    if (rise) {
      const ep = newEpisode(
        {
          id: deps.uuid(),
          trigger: "glucose_rise",
          shadow,
          riseDetectedAt: rise.detectedAt,
          riseSinceAt: rise.fromAt,
          riseFromMgdl: rise.fromMgdl,
          riseToMgdl: rise.toMgdl,
        },
        now
      );
      await persist(ep, true);
      openedThisTick.push(ep);
      result.opened += 1;
      promptQueue.push({ episode: ep, kind: "rise" });
    }
  } else if (riseBlocked !== "open episode") {
    // An open episode is the normal steady state, not a suppression worth
    // logging; the other three are what the shadow week is measuring.
    result.suppressed += 1;
    result.notes.push(`rise trigger blocked: ${riseBlocked}`);
  }

  // ── (4) expiry ──────────────────────────────────────────────────────────────
  for (const ep of activeExisting) {
    if (handledIds.has(ep.id)) continue;
    if (ep.expiresAt <= now) {
      const expired: MealEpisode = { ...ep, status: "expired" };
      await persist(expired, false);
      result.expired += 1;
    }
  }

  // Include undelivered episodes from earlier ticks; the pump key prevents
  // duplicate episodes but must not prevent retrying a failed delivery.
  const queued = new Map(promptQueue.map(item => [item.episode.id, item]));
  for (const episode of activeExisting) {
    if (!queued.has(episode.id) && episode.trigger !== "eating_now") {
      queued.set(episode.id, { episode, kind: episode.trigger === "pump_bolus" ? "bolus" : "rise" });
    }
  }
  const eligible = [...queued.values()].filter(({ episode }) =>
    !handledIds.has(episode.id) && episode.status === "open" && episode.promptCount === 0 &&
    episode.expiresAt > now && episode.shadow === shadow && !episode.shadowPromptedAt
  );
  if (eligible.length > 0) {
    const [prefs, identities, snoozed] = await Promise.all([
      deps.loadPrefs(), deps.loadIdentities(), deps.isSnoozed?.(now) ?? false,
    ]);
    const tokens = deps.patientTokens(prefs, identities);
    for (const { episode, kind } of eligible) {
      const count = shadow ? (state.shadowPromptCount ?? 0) : state.promptCount;
      const blocked = snoozed ? "snoozed" : tokens.length === 0 ? "no patient device assigned" : count >= cap ? 'daily cap ' + cap + ' reached' : null;
      if (blocked) {
        result.suppressed += 1;
        result.notes.push(blocked);
        if (tokens.length === 0) console.warn("meal-detect: no patient device assigned");
        continue;
      }
      if (shadow) {
        await persist({ ...episode, shadowPromptedAt: now, lastPromptKind: kind }, false);
        state.shadowPromptCount = count + 1;
        stateDirty = true;
        result.notes.push('shadow: 1 prompt(s) withheld');
        continue;
      }
      const copy = promptCopy(episode, kind);
      const results = dry ? [] : await Promise.allSettled(tokens.map(token => deps.push({
        token, title: copy.title, body: copy.body, category: MEAL_PROMPT_CATEGORY,
        interruptionLevel: deps.isPumpSleep(now) ? "passive" : "active",
        userInfo: promptUserInfo(episode, kind), collapseId: 'meal-prompt-' + episode.id,
      })));
      const delivered = dry ? tokens.length : results.filter(r => r.status === "fulfilled").length;
      result.deliveryFailures += results.filter(r => r.status === "rejected").length;
      if (delivered === 0) {
        result.notes.push('delivery failed for ' + episode.id);
        continue;
      }
      await persist({ ...episode, status: "prompted", promptedAt: now, promptCount: 1, lastPromptKind: kind }, false);
      state.promptCount += 1;
      stateDirty = true;
      result.prompted += 1;
    }
  }

  // ── (6) photo prune, once per patient-local day ─────────────────────────────
  if (deps.prunePhotos && state.photoPruneDayKey !== dayKey) {
    if (!dry) {
      try {
        const { deleted } = await deps.prunePhotos(PHOTO_RETENTION_DAYS);
        result.pruned = deleted;
        state.photoPruneDayKey = dayKey;
        state.photoPruneDeleted = deleted;
        stateDirty = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`meal-detect: photo prune failed: ${message}`);
        result.notes.push(`photo prune failed: ${message}`);
      }
    }
  }

  if (stateDirty && !dry) await deps.episodes.savePromptState(state);
  return result;
}
