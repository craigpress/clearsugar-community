import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/api-auth";
import { loadJSON, saveJSON } from "@/lib/local-store";
import { pushLiveActivityUpdate, pushAlertNotification, pushSilentBackground } from "@/lib/apns";
import { getTreatments, getProfile } from "@/lib/nightscout";
import {
  calculateIOB,
  calculateCOB,
} from "@/lib/prediction/physiological-model";
import { loadAlertTokens } from "@/app/api/push/register-alert/route";
import { loadLiveActivityTokens, saveLiveActivityTokens } from "@/app/api/push/register/route";
import { loadSnoozeState, saveSnoozeState } from "@/app/api/alerts/snooze/route";
import { loadAlertPrefs, getDevicePrefs } from "@/app/api/alerts/preferences/route";

export const dynamic = "force-dynamic";

// ── Glucose alert cooldowns & categories ──

const ALERT_CONFIG: Record<string, { cooldownMs: number; category: string }> = {
  urgentLow:  { cooldownMs: 5 * 60 * 1000,  category: "URGENT_GLUCOSE" },
  low:        { cooldownMs: 15 * 60 * 1000, category: "GLUCOSE_WARNING" },
  high:       { cooldownMs: 30 * 60 * 1000, category: "GLUCOSE_WARNING" },
  urgentHigh: { cooldownMs: 15 * 60 * 1000, category: "URGENT_GLUCOSE" },
};

/** Classify glucose against a device's thresholds */
function classifyGlucose(sgv: number, prefs: { thresholdUrgentLow: number; thresholdLow: number; thresholdHigh: number; thresholdUrgentHigh: number }): string | null {
  if (sgv < prefs.thresholdUrgentLow) return "urgentLow";
  if (sgv < prefs.thresholdLow) return "low";
  if (sgv >= prefs.thresholdUrgentHigh) return "urgentHigh";
  if (sgv >= prefs.thresholdHigh) return "high";
  return null;
}

const GLUCOSE_ALERT_STATE_KEY = "push/glucose-alert-state.json";

interface GlucoseAlertState {
  lastAlertType: string;
  lastAlertTime: number;
  lastSgv: number;
}

async function loadGlucoseAlertState(): Promise<GlucoseAlertState | null> {
  const state = await loadJSON<GlucoseAlertState | Record<string, never>>(GLUCOSE_ALERT_STATE_KEY, {});
  if (!state || !("lastAlertType" in state)) return null;
  return state as GlucoseAlertState;
}

async function saveGlucoseAlertState(state: GlucoseAlertState | null): Promise<void> {
  await saveJSON(GLUCOSE_ALERT_STATE_KEY, state ?? {});
}

/**
 * GET /api/push/send
 *
 * Called every 5 minutes via systemd timer. Fetches latest glucose,
 * IOB/COB, builds Live Activity content-state, and pushes to
 * all registered devices via APNs.
 *
 * Protected by CLEARSUGAR_API_KEY to prevent unauthorized triggers.
 */
export async function GET(req: Request) {
  // Verify API key (systemd timer passes this via curl header)
  const apiKey = req.headers.get("x-api-key");
  if (!apiKey || !process.env.CLEARSUGAR_API_KEY || !safeEqual(apiKey, process.env.CLEARSUGAR_API_KEY)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get Live Activity push tokens from stored registrations
  const storedTokenMap = await loadLiveActivityTokens();
  const tokens = Object.keys(storedTokenMap);

  if (tokens.length === 0) {
    return NextResponse.json({
      sent: 0,
      reason: "No push tokens. Open the app to register.",
    });
  }

  try {
    // Fetch latest glucose from Nightscout
    const nsUrl = process.env.NIGHTSCOUT_URL;
    if (!nsUrl) throw new Error("NIGHTSCOUT_URL not configured");

    const glucoseRes = await fetch(
      `${nsUrl}/api/v1/entries/current.json`,
      { cache: "no-store" }
    );
    if (!glucoseRes.ok) throw new Error(`Nightscout returned ${glucoseRes.status}`);
    const entries = await glucoseRes.json();
    const latest = entries[0];
    if (!latest) throw new Error("No glucose entries");

    // Fetch 3h of history for sparkline
    const since = Date.now() - 3 * 60 * 60 * 1000;
    const historyRes = await fetch(
      `${nsUrl}/api/v1/entries.json?count=36&find[type][$eq]=sgv&find[date][$gte]=${since}`,
      { cache: "no-store" }
    );
    const historyEntries = historyRes.ok ? await historyRes.json() : [];
    // Oldest first for sparkline
    const sparklineValues = historyEntries
      .map((e: { sgv: number }) => e.sgv)
      .reverse();

    // Fetch IOB/COB
    let iobDisplay: string | null = null;
    let cobDisplay: string | null = null;
    try {
      const [treatments, profiles] = await Promise.all([
        getTreatments(200, 6 * 60 * 60 * 1000),
        getProfile(),
      ]);
      const profile = profiles[0];
      if (profile) {
        const iob = Math.round(calculateIOB(treatments, profile, Date.now()) * 10) / 10;
        const cob = Math.round(calculateCOB(treatments, Date.now()));
        iobDisplay = `${iob} u`;
        cobDisplay = `${cob} g`;
      }
    } catch {
      // IOB/COB is optional, continue without it
    }

    // Fetch prediction (call our own auto-predict endpoint)
    let predictionValues: number[] | null = null;
    let predictedSgv: number | null = null;
    try {
      const origin = new URL(req.url).origin;
      const predRes = await fetch(`${origin}/api/predict/auto?horizon=30`, {
        headers: { "x-api-key": process.env.CLEARSUGAR_API_KEY || "" },
      });
      if (predRes.ok) {
        const predData = await predRes.json();
        if (predData.points) {
          predictionValues = predData.points
            .slice(0, 6)
            .map((p: { predicted: number }) => Math.round(p.predicted));
          const last = predData.points[predData.points.length - 1];
          predictedSgv = last ? Math.round(last.predicted) : null;
        }
      }
    } catch {
      // Prediction is optional
    }

    // Compute range category
    const sgv = latest.sgv;
    let rangeCategory: string;
    if (sgv < 55) rangeCategory = "urgentLow";
    else if (sgv < 70) rangeCategory = "low";
    else if (sgv <= 180) rangeCategory = "inRange";
    else if (sgv <= 250) rangeCategory = "high";
    else rangeCategory = "urgentHigh";

    // Compute delta
    const delta = latest.delta ?? 0;
    const deltaStr = delta >= 0 ? `+${Math.round(delta)}` : `${Math.round(delta)}`;

    // Compute trend arrow
    const arrows: Record<string, string> = {
      DoubleUp: "\u21C8",
      SingleUp: "\u2191",
      FortyFiveUp: "\u2197",
      Flat: "\u2192",
      FortyFiveDown: "\u2198",
      SingleDown: "\u2193",
      DoubleDown: "\u21CA",
    };
    const trendArrow = arrows[latest.direction] || "\u2192";

    // Build content-state matching GlucoseActivityAttributes.ContentState
    const contentState = {
      sgv,
      trendArrow,
      delta: deltaStr,
      timestamp: new Date(latest.date).getTime() / 1000, // Swift Date = seconds since epoch
      rangeCategory,
      sparklineValues: sparklineValues.slice(-36),
      predictionValues,
      predictedSgv,
      predictionMinutes: 30,
      iob: iobDisplay,
      cob: cobDisplay,
    };

    // Stale after 6 minutes (next Dexcom reading)
    const staleDate = Math.floor(Date.now() / 1000) + 360;

    // Push to all registered tokens
    const results = await Promise.allSettled(
      tokens.map((token) =>
        pushLiveActivityUpdate(token, contentState, staleDate)
      )
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    // Collect error messages for debugging
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason?.message || "unknown");

    // Auto-prune tokens that APNs rejects as invalid
    const PRUNE_REASONS = ["BadDeviceToken", "ExpiredToken", "Unregistered"];
    const badTokens: string[] = [];
    results.forEach((r, i) => {
      if (r.status === "rejected" && PRUNE_REASONS.some((reason) => r.reason?.message?.includes(reason))) {
        badTokens.push(tokens[i]);
      }
    });
    if (badTokens.length > 0) {
      const updated = { ...storedTokenMap };
      let pruned = 0;
      for (const t of badTokens) {
        if (t in updated) { delete updated[t]; pruned++; }
      }
      if (pruned > 0) {
        await saveLiveActivityTokens(updated);
        console.log(`Pruned ${pruned} bad Live Activity token(s)`);
      }
    }

    // ── Silent background push to wake app for widget/Watch refresh ──
    const alertTokenMap = await loadAlertTokens();
    const alertTokenList = Object.keys(alertTokenMap);
    let backgroundPushed = 0;
    if (alertTokenList.length > 0) {
      const bgResults = await Promise.allSettled(
        alertTokenList.map((t) => pushSilentBackground(t, sgv))
      );
      backgroundPushed = bgResults.filter((r) => r.status === "fulfilled").length;
    }

    // ── Glucose threshold alerts (per-device thresholds) ──

    let glucoseAlertPushed = 0;
    const alertTypes: string[] = [];

    const now = Date.now();
    const [alertState, snoozeState, allPrefs] = await Promise.all([
      loadGlucoseAlertState(),
      loadSnoozeState(),
      loadAlertPrefs(),
    ]);

    // Check snooze status (shared across devices)
    const isSnoozed = (() => {
      const cats = snoozeState.snoozedCategories;
      if (cats.length === 0) return false;
      const isTimedSnooze = snoozeState.snoozedUntil > 0 && snoozeState.snoozedUntil > now;
      const isUntilRange = snoozeState.untilRange;
      return isTimedSnooze || isUntilRange;
    })();

    // Check each device independently against its own thresholds
    // alertTokenMap is now token → deviceName
    const deviceEntries = Object.entries(alertTokenMap); // token → deviceName
    let anyDeviceOutOfRange = false;
    let strongestAlertType: string | null = null;

    if (!isSnoozed && deviceEntries.length > 0) {
      const pushPromises: Promise<{ success: boolean; status: number }>[] = [];

      for (const [token] of deviceEntries) {
        const prefs = getDevicePrefs(allPrefs, token);
        const alertType = classifyGlucose(sgv, prefs);

        if (!alertType) continue;
        anyDeviceOutOfRange = true;
        if (!alertTypes.includes(alertType)) alertTypes.push(alertType);

        const config = ALERT_CONFIG[alertType];
        if (!config) continue;

        // Check per-alert-type dedup cooldown
        const cooldownPassed = !alertState ||
          alertState.lastAlertType !== alertType ||
          (now - alertState.lastAlertTime) > config.cooldownMs;

        // Also check if this specific category is snoozed
        const catSnoozed = snoozeState.snoozedCategories.length > 0 &&
          (snoozeState.snoozedCategories.includes("all") || snoozeState.snoozedCategories.includes(alertType));

        if (!cooldownPassed || catSnoozed) continue;

        const isUrgent = alertType === "urgentLow" || alertType === "urgentHigh";
        const title = isUrgent
          ? (alertType === "urgentLow" ? "URGENT LOW" : "URGENT HIGH")
          : (alertType === "low" ? "Glucose Low" : "Glucose High");
        const body = `${sgv} mg/dL ${trendArrow} (${deltaStr})`;

        strongestAlertType = alertType;
        pushPromises.push(pushAlertNotification(token, title, body, config.category));
      }

      if (pushPromises.length > 0) {
        const results = await Promise.allSettled(pushPromises);
        glucoseAlertPushed = results.filter((r) => r.status === "fulfilled").length;

        if (glucoseAlertPushed > 0 && strongestAlertType) {
          await saveGlucoseAlertState({ lastAlertType: strongestAlertType, lastAlertTime: now, lastSgv: sgv });
        }
      }
    }

    // If no device is out of range, clear dedup + "until range" snooze
    if (!anyDeviceOutOfRange && deviceEntries.length > 0) {
      const saves: Promise<void>[] = [];
      if (alertState?.lastAlertType) {
        saves.push(saveGlucoseAlertState(null));
      }
      if (snoozeState.untilRange) {
        saves.push(
          saveSnoozeState({ snoozedUntil: 0, snoozedCategories: [], snoozedBy: "", untilRange: false })
        );
      }
      if (saves.length > 0) await Promise.all(saves);
    }

    return NextResponse.json({
      sent: succeeded,
      failed,
      backgroundPushed,
      sgv,
      trendArrow,
      iob: iobDisplay,
      cob: cobDisplay,
      glucoseAlertPushed,
      glucoseAlertTypes: alertTypes,
      snoozed: isSnoozed,
      ...(isSnoozed && { snoozeInfo: { until: snoozeState.snoozedUntil, untilRange: snoozeState.untilRange, categories: snoozeState.snoozedCategories } }),
      ...(errors.length > 0 && { errors }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
