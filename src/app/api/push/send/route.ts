import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/api-auth";
import { loadJSON, saveJSON } from "@/lib/local-store";
import { pushLiveActivityUpdate, pushLiveActivityStart, pushAlertNotification, pushSilentBackground } from "@/lib/apns";
import { getEntries, getTreatments, getProfile } from "@/lib/nightscout";
import { computeAutoPrediction } from "@/lib/prediction/auto";
import type { GlucoseReading, Treatment, PumpProfile } from "@/lib/types";
import {
  calculateIOB,
  calculateCOB,
} from "@/lib/prediction/physiological-model";
import { loadAlertTokens } from "@/lib/server/alert-registration";
import { loadInstalls, saveInstalls, removeToken, recordStartAttempt } from "@/lib/live-activity-store";
import { loadSnoozeState, saveSnoozeState } from "@/lib/server/alert-snooze";
import { loadAlertPrefs, getDevicePrefs } from "@/lib/server/alert-preferences";
import { isNewReading, decideStart, decideStaleAlert } from "@/lib/live-activity-policy";
import { classifyGlucose, ALERT_CONFIG } from "@/lib/alert-classify";
import { isValidSgv, sanitizeSparkline } from "@/lib/glucose-validity";
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
import { loadDeviceAcks, saveDeviceAcks } from "@/lib/server/alert-acks";

export const dynamic = "force-dynamic";

// Volatile: last CGM reading date we actually pushed. Resets on restart (worst
// case: one redundant push after a deploy). Enables idempotency so a faster
// timer adds no push volume.
let lastPushedDate: number | null = null;

// Push-to-start config + volatile per-install liveness tracking (installId → ms epoch).
const START_COOLDOWN_MS = 15 * 60_000;
const START_ENABLED = process.env.LIVE_ACTIVITY_PUSH_TO_START === "true";
/**
 * How long an APNs 200 on the update token may stand as proof the activity is
 * still alive. APNs keeps accepting updates for an activity that already ended,
 * so without an upper bound a dead card is never resurrected (2026-07-21: 91
 * overnight cycles, `started` 0 every one). iOS itself ends a Live Activity
 * after ~8h, so 4h is comfortably inside the window where a still-running
 * activity is plausible. Overriding via env allows tuning without a deploy.
 * The app's explicit end-ack is the precise signal; this is the safety net for
 * installs on builds that don't send one yet.
 */
const START_MAX_ASSUMED_LIFETIME_MS =
  Number(process.env.LIVE_ACTIVITY_MAX_ASSUMED_LIFETIME_MS) || 4 * 60 * 60_000;
/**
 * Upper bound on the retry backoff between unconfirmed push-to-starts. Attempts
 * escalate cooldown → 2× → 4× … up to this cap, so a wedged install keeps being
 * retried without ever spamming. Overridable without a deploy.
 */
const START_MAX_BACKOFF_MS =
  Number(process.env.LIVE_ACTIVITY_START_MAX_BACKOFF_MS) || 4 * 60 * 60_000;

// Single-flight guard: the 30s timer + curl --max-time can overlap if a cycle runs
// long, and a concurrent handler would race the on-disk read-modify-write.
let inFlight = false;

// ── Server-authoritative stale-data alert ──
// The server always knows the true age of the newest CGM reading, so it — not
// the phone — decides when data has genuinely stopped. The iOS watchdog is only
// a backstop for the server itself being unreachable.
const STALE_THRESHOLD_MS = 20 * 60_000;      // ~4 missed 5-min readings
const STALE_ALERT_COOLDOWN_MS = 30 * 60_000; // remind at most every 30 min while stale
// Volatile like lastPushedDate: worst case one redundant alert after a deploy.
let lastStaleAlertAt = 0;

// ── Glucose alert cooldowns & categories ──
// ALERT_CONFIG moved to lib/alert-classify.ts so /api/alerts/ack shares the
// same per-type cooldowns.

const GLUCOSE_ALERT_STATE_KEY = "push/glucose-alert-state.json";

/**
 * How long readings must stay in range before cooldowns and untilRange snoozes
 * clear. The old behavior cleared on ANY single in-range reading, so glucose
 * hovering at a threshold re-alerted on every crossing (2026-07-24 storm).
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

  // Skip re-entrant calls (see inFlight above).
  if (inFlight) {
    return NextResponse.json({ skipped: "cycle in flight" });
  }
  inFlight = true;
  try {
    // Fetch latest glucose from Nightscout
    const entries = await getEntries(1);
    const latest = entries[0];
    if (!latest) throw new Error("No glucose entries");

    // ── Stale-data alert (server-authoritative) ──
    // Evaluated BEFORE the idempotency return below: staleness IS "no new reading
    // for a long time", so it must fire on exactly the cycles that skip a push.
    const dataAgeMs = Date.now() - latest.date;
    if (dataAgeMs > STALE_THRESHOLD_MS) {
      const staleNow = Date.now();
      const [snoozeState, alertTokenMap] = await Promise.all([
        loadSnoozeState(),
        loadAlertTokens(),
      ]);
      const snoozeActive =
        snoozeState.untilRange ||
        (snoozeState.snoozedUntil > 0 && snoozeState.snoozedUntil > staleNow);
      const staleSnoozed =
        snoozeActive &&
        (snoozeState.snoozedCategories.includes("all") ||
          snoozeState.snoozedCategories.includes("stale"));
      if (
        decideStaleAlert({
          dataAgeMs,
          staleThresholdMs: STALE_THRESHOLD_MS,
          lastStaleAlertAt,
          now: staleNow,
          cooldownMs: STALE_ALERT_COOLDOWN_MS,
          isSnoozed: staleSnoozed,
        })
      ) {
        const minutes = Math.round(dataAgeMs / 60_000);
        const tokens = Object.keys(alertTokenMap);
        await Promise.allSettled(
          tokens.map((t) =>
            pushAlertNotification(
              t,
              "Sensor data stopped",
              `No new glucose for ${minutes} min. Check the sensor and phone.`,
              "GLUCOSE_WARNING",
              "time-sensitive",
            ),
          ),
        );
        lastStaleAlertAt = staleNow;
        console.log(`[push/send] stale-data alert sent (${minutes} min old, ${tokens.length} device(s))`);
      }
    } else {
      // Fresh again → reset dedup so the next outage alerts immediately.
      lastStaleAlertAt = 0;
    }

    // Idempotency: skip all pushes + predict/history work when the CGM reading
    // date hasn't advanced. Safe because a genuinely new reading always carries a
    // new date (a repeated date is a duplicate, not a missed reading), so this
    // drops only redundant timer fires — never a real reading or its alert.
    if (!isNewReading(latest.date, lastPushedDate)) {
      return NextResponse.json({ skipped: "no new reading", sgv: latest.sgv, dataAgeMin: Math.round(dataAgeMs / 60_000) });
    }

    // Valid-data invariant: a sensor-error sentinel (sgv 0-12) or impossible
    // value must never reach a Live Activity, widget, or threshold alert — a
    // 0 would otherwise display as "0 mg/dL" and classify as URGENT LOW. The
    // current iOS ContentState enum can't decode a sensorError category, so
    // we skip the push entirely; the activity's staleDate presentation and
    // the stale-data alert above (which already ran) cover the outage.
    if (!isValidSgv(latest.sgv)) {
      console.warn(`[push/send] invalid reading skipped (sgv=${latest.sgv})`);
      return NextResponse.json({ skipped: "invalid reading", sgv: latest.sgv });
    }

    // Fetch 3h of history for sparkline
    const historyEntries = await getEntries(36, 3 * 60 * 60_000);
    // Oldest first for sparkline
    const sparklineValues = sanitizeSparkline(
      historyEntries.map((e: { sgv: number }) => e.sgv)
    ).reverse();

    // Fetch IOB/COB + data reused for prediction (fetched once, larger count to
    // serve both). Hoisted so the direct prediction call below can reuse them.
    let iobDisplay: string | null = null;
    let cobDisplay: string | null = null;
    let treatmentsForPredict: Treatment[] = [];
    let profilesForPredict: PumpProfile[] = [];
    try {
      const [treatments, profiles] = await Promise.all([
        getTreatments(500, 6 * 60 * 60 * 1000),
        getProfile(),
      ]);
      treatmentsForPredict = treatments;
      profilesForPredict = profiles;
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

    // Prediction — direct call (no internal HTTP). Reuses readings/treatments/
    // profile already fetched above; failure is non-fatal (no prediction shown).
    let predictionValues: number[] | null = null;
    let predictedSgv: number | null = null;
    try {
      const pred = await computeAutoPrediction(
        historyEntries as GlucoseReading[],
        treatmentsForPredict,
        profilesForPredict,
        { horizon: 30, model: "ensemble" }
      );
      predictionValues = pred.points.slice(0, 6).map((p) => Math.round(p.predicted));
      const last = pred.points[pred.points.length - 1];
      predictedSgv = last ? Math.round(last.predicted) : null;
    } catch (err) {
      console.error("[push/send] prediction failed (non-fatal):", err);
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

    // ── Live Activity UPDATE: unconditional to every registered update token ──
    const installs = await loadInstalls();
    const installIds = Object.keys(installs);
    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];
    const prunedTokens: string[] = [];
    const got200 = new Set<string>();
    let storeDirty = false; // set when we mutate install records (activitySince backfill)
    const PRUNE_REASONS = ["BadDeviceToken", "ExpiredToken", "Unregistered"];

    await Promise.all(installIds.map(async (id) => {
      const rec = installs[id];
      if (!rec.updateToken) return;
      try {
        await pushLiveActivityUpdate(rec.updateToken, contentState, staleDate);
        succeeded++;
        got200.add(id);
        // Backfill: installs registered before activitySince existed have no
        // liveness clock, so the timeout net could never engage for them. Stamp
        // it on first sight — conservative (starts the window now, so it can
        // only delay a resurrection, never cause a spurious one).
        if (!rec.activitySince) {
          rec.activitySince = Date.now();
          storeDirty = true;
        }
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : "unknown";
        errors.push(msg);
        if (PRUNE_REASONS.some((r) => msg.includes(r))) prunedTokens.push(rec.updateToken!);
      }
    }));

    // ── Live Activity START (resurrection), flag-gated + de-duped via decideStart ──
    let started = 0;
    if (START_ENABLED) {
      const startNow = Date.now();
      await Promise.all(installIds.map(async (id) => {
        const rec = installs[id];
        if (!rec.startToken) return;
        const should = decideStart({
          got200ThisCycle: got200.has(id),
          now: startNow,
          cooldownMs: START_COOLDOWN_MS,
          // All persisted on the install, so they survive a service restart —
          // the old in-process maps re-armed every install on deploy.
          lastStartAt: rec.lastStartAt ?? 0,
          startAttempts: rec.startAttempts ?? 0,
          endedAckAt: rec.endedAt ?? 0,
          activitySince: rec.activitySince ?? 0,
          maxAssumedLifetimeMs: START_MAX_ASSUMED_LIFETIME_MS,
          maxBackoffMs: START_MAX_BACKOFF_MS,
        });
        if (!should) return;
        // Why this fired, so a silent night is diagnosable from the log alone —
        // the 2026-07-21 outage was invisible because `started:0` carried no reason.
        const trigger = !got200.has(id) ? "no-200"
          : (rec.endedAt ?? 0) > 0 ? "app-ack"
          : "liveness-timeout";
        try {
          await pushLiveActivityStart(rec.startToken, contentState, staleDate);
          started++;
          // Record the ATTEMPT only. This used to also restamp `rec.activitySince`
          // to bound a false-positive liveness-timeout to one refresh per lifetime
          // — but that reset the clock the retry itself depends on, so a start that
          // produced no card deferred the next attempt another 4h, every time, and
          // the card never came back (2026-07-22). The attempt counter now provides
          // that bound instead: backoff escalates per unconfirmed start and resets
          // only when a new update token proves an activity actually exists.
          recordStartAttempt(installs, id, startNow);
          storeDirty = true;
          console.log(`Live Activity start sent to ${id.slice(0, 8)} (trigger: ${trigger})`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown";
          console.log(`Live Activity start FAILED for ${id.slice(0, 8)} (trigger: ${trigger}): ${msg}`);
          if (PRUNE_REASONS.some((r) => msg.includes(r))) prunedTokens.push(rec.startToken!);
        }
      }));
    }

    // Auto-prune tokens that APNs rejects as invalid
    if (prunedTokens.length > 0) {
      for (const t of prunedTokens) removeToken(installs, t);
      storeDirty = true;
      console.log(`Pruned ${prunedTokens.length} bad Live Activity token(s)`);
    }
    if (storeDirty) await saveInstalls(installs);

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
    // alertTokenMap is now token → deviceName
    const deviceEntries = Object.entries(alertTokenMap); // token → deviceName
    let anyDeviceOutOfRange = false;
    const deadAlertTokens: string[] = [];

    {
      const pushes: { token: string; alertType: string; promise: Promise<{ success: boolean; status: number }> }[] = [];
      const firedTypes = new Set<string>();

      // Classification runs for EVERY cycle, snoozed or not. The old code
      // skipped this whole loop while snoozed, so anyDeviceOutOfRange stayed
      // false and the "back in range" branch below wiped an untilRange snooze
      // within one cycle of it being set — while glucose was still high. That
      // is why snoozes appeared not to work (observed 2026-07-24 04:27→04:31).
      for (const [token] of deviceEntries) {
        const prefs = getDevicePrefs(allPrefs, token);
        const alertType = classifyGlucose(sgv, prefs);

        if (!alertType) continue;
        anyDeviceOutOfRange = true;
        if (!alertTypes.includes(alertType)) alertTypes.push(alertType);
        if (isSnoozed) continue; // classified for range tracking; no push while snoozed

        const config = ALERT_CONFIG[alertType];
        if (!config) continue;

        // Per-CATEGORY cooldown. The old single {lastAlertType} record meant
        // devices classifying the same reading differently (one phone's
        // urgentHigh is another's high) overwrote each other's clock every
        // cycle and alerts fired every 5 minutes all night (2026-07-24).
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
            // instead of stacking (8 stacked "Glucose High" per phone before).
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
            // APNs told us this token is dead → prune it from the alert stores
            // (was previously logged and ignored, so dead tokens accumulated).
            const msg = r.reason instanceof Error ? r.reason.message : "";
            if (msg.includes("BadDeviceToken") || msg.includes("Unregistered") || msg.includes("ExpiredToken")) {
              deadAlertTokens.push(pushes[i].token);
            }
          }
        });

        if (firedTypes.size > 0) {
          for (const t of firedTypes) recordCategoryFired(alertState, t, now, sgv);
        }
      }
    }

    // Sustained in-range → clear cooldowns, untilRange snooze, and acks.
    // A single in-range reading only STARTS the clock (the old instant clear
    // re-alerted on every threshold crossing).
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
          saveJSON("push/high-alert-recipients.json", stores.recipients),
        ]);
        console.log(`[push/send] pruned ${pruned} dead alert token(s)`);
      }
    }

    // Mark this reading as pushed (idempotency guard for redundant timer fires).
    lastPushedDate = latest.date;

    return NextResponse.json({
      sent: succeeded,
      failed,
      started,
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
  } finally {
    inFlight = false;
  }
}
