import { loadSnoozeState } from "@/lib/server/alert-snooze";
import { withStoreLock } from "@/lib/local-store";
import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/api-auth";
import { getEntries, getProfile, getPumpState, getTreatments } from "@/lib/nightscout";
import { pushAlertNotification } from "@/lib/apns";
import {
  loadAlertPrefs,
  loadIdentities,
  patientTokens as patientTokensFor,
} from "@/lib/server/alert-preferences";
import { isPumpSleep } from "@/lib/prediction/ciq-modes";
import { detectRescueCarbs } from "@/lib/prediction/rescue-carb-detector";
import { prunePhotos } from "@/lib/meals/photos";
import { loadMealProfiles } from "@/lib/meals/profiles";
import { mealScope } from "@/lib/meals/profile-storage";
import {
  appendEpisode,
  findByPumpKey,
  findOpenEpisodeNear,
  listActiveEpisodes,
  loadPromptState,
  savePromptState,
  updateEpisode,
} from "@/lib/meals/episodes";
import { runDetectTick, type DetectDeps } from "@/lib/meals/detect";

export const dynamic = "force-dynamic";

/**
 * GET /api/meals/detect — one meal-prompt detection tick (feature B, section 4c).
 *
 * Machine-only, exactly like /api/advisor/check: the shared `x-api-key` is the
 * ONLY accepted credential, because this is the systemd timer's endpoint and a
 * personal credential has no business firing pushes at Patient.
 *
 * `?dry=1` runs the same computation and writes nothing — no episode, no prompt
 * state, no push, no photo prune.
 *
 * 200 { shadow, opened, prompted, reconciled, expired, suppressed, pruned,
 *       deliveryFailures, notes }
 * 401 bad or missing key · 502 Nightscout unreachable
 *
 * Shadow by default (MEAL_PROMPT_SHADOW !== "false"): episodes are recorded
 * with shadow:true and no push is built. Flip the var only after the shadow-week
 * review (Phase 2 exit criteria).
 */
export async function GET(req: Request) {
  const apiKey = req.headers.get("x-api-key");
  if (
    !apiKey ||
    !process.env.CLEARSUGAR_API_KEY ||
    !safeEqual(apiKey, process.env.CLEARSUGAR_API_KEY)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dry = new URL(req.url).searchParams.get("dry") === "1";

  try {
    // Pump state supplies the real Control-IQ Sleep schedule for the quiet gate
    // (falls back to 22:00-05:00 inside isPumpSleep); the profile is only needed
    // by the rescue-carb inference that feeds the rise low-recovery exclusion.
    const [pumpState, profiles] = await Promise.all([
      getPumpState().catch(() => null),
      getProfile(1).catch(() => [] as Awaited<ReturnType<typeof getProfile>>),
    ]);
    const profile = profiles?.[0];

    const deps: DetectDeps = {
      getTreatments: (count, maxAgeMs) => getTreatments(count, maxAgeMs),
      getEntries: (count, maxAgeMs) => getEntries(count, maxAgeMs),
      loadPrefs: () => loadAlertPrefs(),
      loadIdentities: () => loadIdentities(),
      patientTokens: (prefs, identities) =>
        patientTokensFor(
          prefs as Parameters<typeof patientTokensFor>[0],
          identities as Parameters<typeof patientTokensFor>[1]
        ),
      push: ({ token, title, body, category, interruptionLevel, userInfo, collapseId }) =>
        pushAlertNotification(token, title, body, category, interruptionLevel, {
          collapseId,
          userInfo,
        }),
      isSnoozed: async (atMs) => {
        const state = await loadSnoozeState();
        return state.untilRange || state.snoozedUntil > atMs;
      },
      isPumpSleep: (atMs) => isPumpSleep(atMs, pumpState?.controlIQ?.sleepSchedule),
      episodes: {
        appendEpisode,
        updateEpisode,
        findByPumpKey: (key) => findByPumpKey(key),
        findOpenEpisodeNear: (anchorMs, before, after) =>
          findOpenEpisodeNear(anchorMs, before, after),
        listActiveEpisodes: (nowMs) => listActiveEpisodes(nowMs),
        loadPromptState: (nowMs) => loadPromptState(nowMs),
        savePromptState,
      },
      prunePhotos: async (maxAgeDays) => {
        const real = await prunePhotos(maxAgeDays);
        let deleted = real.deleted;
        for (const profile of await loadMealProfiles()) {
          if (profile.id !== "patient") deleted += (await mealScope.run(profile, () => prunePhotos(maxAgeDays))).deleted;
        }
        return { deleted };
      },
      rescueEvents: (readings, treatments) =>
        profile
          ? detectRescueCarbs(readings, treatments, profile).map((e) => e.timestamp)
          : [],
      uuid: () => crypto.randomUUID(),
    };

    const result = await withStoreLock("meal-detect", () => runDetectTick(deps, Date.now(), { dry }));
    return NextResponse.json({ ...result, dry });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
