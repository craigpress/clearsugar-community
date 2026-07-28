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
import { classifyGlucose, ALERT_CONFIG } from "@/lib/alert-classify";
import {
  migrateAlertState,
  categoryCooldownPassed,
  recordCategoryFired,
  updateInRangeTracking,
  sustainedInRange,
  isDeviceAcked,
  pruneExpiredAcks,
  type GlucoseAlertStateV2,
} from "@/lib/alert-policy";
import { removeAlertToken } from "@/lib/alert-token-store";
import { loadDeviceAcks, saveDeviceAcks } from "@/app/api/alerts/ack/route";
import { isValidSgv, sanitizeSparkline } from "@/lib/glucose-validity";

export const dynamic = "force-dynamic";

// ── Glucose alert cooldowns & categories ──
// ALERT_CONFIG lives in lib/alert-classify.ts so /api/alerts/ack shares the
// same per-type cooldowns.

const GLUCOSE_ALERT_STATE_KEY = "push/glucose-alert-state.json";

/**
 * How long readings must stay in range before cooldowns and untilRange snoozes
 * clear. Clearing on ANY single in-range reading means glucose hovering at a
 * threshold re-alerts on every crossing.
 */
const SUSTAINED_IN_RANGE_MS =
  Number(process.env.ALERT_SUSTAINED_IN_RANGE_MS) || 15 * 60_000;

async function loadGlucoseAlertState(): Promise<GlucoseAlertStateV2> {
  const raw = await loadJSON<unknown>(GLUCOSE_ALERT_STATE_KEY, {});
  return migrateAlertState(raw);
}

async function saveGlucoseAlertState(state: GlucoseAlertStateV2): Promise<void> {
  await saveJSON(GLUCOSE_ALERT_STATE_KEY, state);
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

  // Load BOTH registration stores up front. A device may register for
  // threshold alerts without ever starting a Live Activity — alert delivery
  // must not depend on Live Activity registrations existing.
  const storedTokenMap = await loadLiveActivityTokens();
  const tokens = Object.keys(storedTokenMap);
  const alertTokenMap = await loadAlertTokens();

  if (tokens.length === 0 && Object.keys(alertTokenMap).length === 0) {
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

    // Valid-data invariant: a sensor-error sentinel (sgv 0-12) or impossible
    // value must never reach a Live Activity, widget, or threshold alert — a
    // 0 would otherwise display as "0 mg/dL" and classify as URGENT LOW. The
    // current iOS ContentState enum can't decode a sensorError category, so
    // we skip the push entirely and let the activity's staleDate presentation
    // cover the outage.
    if (!isValidSgv(latest.sgv)) {
      console.warn(`[push/send] invalid reading skipped (sgv=${latest.sgv})`);
      return NextResponse.json({ skipped: "invalid reading", sgv: latest.sgv });
    }

    // Fetch 3h of history for sparkline
    const since = Date.now() - 3 * 60 * 60 * 1000;
    const historyRes = await fetch(
      `${nsUrl}/api/v1/entries.json?count=36&find[type][$eq]=sgv&find[date][$gte]=${since}`,
      { cache: "no-store" }
    );
    const historyEntries = historyRes.ok ? await historyRes.json() : [];
    // Oldest first for sparkline; drop sensor-error values so they don't
    // render as dips to zero.
    const sparklineValues = sanitizeSparkline(
      historyEntries.map((e: { sgv: number }) => e.sgv)
    ).reverse();

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
    // (alertTokenMap loaded up front, before the token-count check)
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
    const [alertState, snoozeState, allPrefs, deviceAcks] = await Promise.all([
      loadGlucoseAlertState(),
      loadSnoozeState(),
      loadAlertPrefs(),
      loadDeviceAcks(),
    ]);
    let acksDirty = pruneExpiredAcks(deviceAcks, now);

    // Check snooze status (shared across devices)
    const isSnoozed = (() => {
      const cats = snoozeState.snoozedCategories;
      if (cats.length === 0) return false;
      const isTimedSnooze = snoozeState.snoozedUntil > 0 && snoozeState.snoozedUntil > now;
      const isUntilRange = snoozeState.untilRange;
      return isTimedSnooze || isUntilRange;
    })();

    // Check each device independently against its own thresholds
    const deviceEntries = Object.entries(alertTokenMap); // token → deviceName
    let anyDeviceOutOfRange = false;
    const deadAlertTokens: string[] = [];

    {
      const pushes: { token: string; alertType: string; promise: Promise<{ success: boolean; status: number }> }[] = [];
      const firedTypes = new Set<string>();

      // Classification runs EVERY cycle, snoozed or not. Skipping the loop
      // while snoozed leaves anyDeviceOutOfRange false, so the "back in range"
      // branch below wipes an untilRange snooze within one cycle of it being
      // set — while glucose is still out of range. That is the bug that makes
      // snoozes appear not to work at all.
      for (const [token] of deviceEntries) {
        const prefs = getDevicePrefs(allPrefs, token);
        const alertType = classifyGlucose(sgv, prefs);

        if (!alertType) continue;
        anyDeviceOutOfRange = true;
        if (!alertTypes.includes(alertType)) alertTypes.push(alertType);
        if (isSnoozed) continue; // classified for range tracking; no push while snoozed

        const config = ALERT_CONFIG[alertType];
        if (!config) continue;

        // Per-CATEGORY cooldown. A single {lastAlertType} record means devices
        // classifying the same reading differently (one phone's urgentHigh is
        // another's high) overwrite each other's clock every cycle, and alerts
        // then fire on every timer tick all night.
        if (!categoryCooldownPassed(alertState, alertType, now, config.cooldownMs)) continue;

        // Category-specific snooze
        const catSnoozed = snoozeState.snoozedCategories.length > 0 &&
          (snoozeState.snoozedCategories.includes("all") || snoozeState.snoozedCategories.includes(alertType));
        if (catSnoozed) continue;

        // Per-device ack: this phone acknowledged this alert type — skip it,
        // keep alerting the others. Escalation to a different (more urgent)
        // category is a different key and still fires here.
        if (isDeviceAcked(deviceAcks, token, alertType, now)) continue;

        const isUrgent = alertType === "urgentLow" || alertType === "urgentHigh";
        const title = isUrgent
          ? (alertType === "urgentLow" ? "URGENT LOW" : "URGENT HIGH")
          : (alertType === "low" ? "Glucose Low" : "Glucose High");
        const body = `${sgv} mg/dL ${trendArrow} (${deltaStr})`;

        pushes.push({
          token,
          alertType,
          promise: pushAlertNotification(token, title, body, config.category, "active", {
            // A repeat of the same alert type replaces the previous banner
            // instead of stacking another identical one.
            collapseId: `glucose-${alertType}`,
            alertType,
          }),
        });
      }

      if (pushes.length > 0) {
        const results = await Promise.allSettled(pushes.map((p) => p.promise));
        results.forEach((r, i) => {
          if (r.status === "fulfilled") {
            glucoseAlertPushed++;
            firedTypes.add(pushes[i].alertType);
          } else {
            // APNs told us this token is dead → prune it from the alert stores.
            // Logging and ignoring these lets dead tokens accumulate forever.
            const msg = r.reason instanceof Error ? r.reason.message : "";
            if (msg.includes("BadDeviceToken") || msg.includes("Unregistered") || msg.includes("ExpiredToken")) {
              deadAlertTokens.push(pushes[i].token);
            }
          }
        });

        for (const t of firedTypes) recordCategoryFired(alertState, t, now, sgv);
      }
    }

    // Sustained in-range → clear cooldowns, untilRange snooze, and acks.
    // A single in-range reading only STARTS the clock.
    updateInRangeTracking(alertState, !anyDeviceOutOfRange && deviceEntries.length > 0, now);
    if (sustainedInRange(alertState, now, SUSTAINED_IN_RANGE_MS)) {
      alertState.categories = {};
      alertState.inRangeSince = 0; // restart tracking; nothing left to clear
      if (snoozeState.untilRange) {
        await saveSnoozeState({ snoozedUntil: 0, snoozedCategories: [], snoozedBy: "", untilRange: false });
      }
      if (Object.keys(deviceAcks).length > 0) {
        for (const k of Object.keys(deviceAcks)) delete deviceAcks[k];
        acksDirty = true;
      }
    }
    await saveGlucoseAlertState(alertState);
    if (acksDirty) await saveDeviceAcks(deviceAcks);

    // Prune tokens APNs rejected (registration map + high-alert recipients).
    if (deadAlertTokens.length > 0) {
      const [prunePrefs, pruneRecipients] = await Promise.all([
        loadJSON<Record<string, unknown>>("push/alert-preferences.json", {}),
        loadJSON<string[]>("push/high-alert-recipients.json", []),
      ]);
      const stores = { tokens: alertTokenMap, prefs: prunePrefs, recipients: pruneRecipients };
      let pruned = 0;
      for (const t of deadAlertTokens) if (removeAlertToken(stores, t)) pruned++;
      if (pruned > 0) {
        await Promise.all([
          saveJSON("push/alert-tokens.json", stores.tokens),
          saveJSON("push/alert-preferences.json", stores.prefs),
          saveJSON("push/high-alert-recipients.json", stores.recipients),
        ]);
        console.log(`[push/send] pruned ${pruned} dead alert token(s)`);
      }
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
