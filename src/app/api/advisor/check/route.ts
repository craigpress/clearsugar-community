import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/api-auth";
import { loadJSON, saveJSON } from "@/lib/local-store";
import { getEntries, getTreatments, getProfile, getPumpState } from "@/lib/nightscout";
import { evaluateAdvisories } from "@/lib/prediction/advisor-engine";
import { recordFired } from "@/lib/prediction/feedback-store";
import { compareIob, recordCalSample } from "@/lib/prediction/iob-calibration";
import { trackSettingsChanges } from "@/lib/prediction/settings-tracker";
import { TIER_INTERRUPTION, SILENT_TIERS } from "@/lib/prediction/advisor-types";
import type { AdvisoryAction } from "@/lib/prediction/advisor-types";
import { isPumpSleep, getCiqMode } from "@/lib/prediction/ciq-modes";
import { pushAlertNotification } from "@/lib/apns";
import { loadAlertTokens } from "@/app/api/push/register-alert/route";
import { loadAlertPrefs, loadIdentities, parentTokens } from "@/app/api/alerts/preferences/route";

export const dynamic = "force-dynamic";

/**
 * GET /api/advisor/check — the action-advisor firing path.
 *
 * Runs evaluateAdvisories on the trailing window (same data shape as the cron),
 * applies a 2h-per-id cooldown (a worsening severity bypasses it), and ALWAYS
 * records each fired advisory to the feedback store so the outcome-harvest can
 * build the eval/training set.
 *
 * SHADOW MODE: sends NO pushes — it only computes, logs, and records. Real
 * pushes happen when ADVISOR_SHADOW is explicitly "false" (CURRENT PROD STATE:
 * live). The default remains shadow when the var is unset, so a fresh env is safe.
 *
 * Delivery integrity (Hard Safety): a wake-critical (T4_critical) advisory only
 * starts its cooldown once at least one push has actually been ACKed by APNs. A
 * transient APNs failure must never mark a severe low "fired" and suppress the
 * retry for 2h — it re-evaluates on the next 5-min tick instead. Delivery
 * failures are persisted to advisor/delivery-health.json for the liveness watchdog.
 *
 * Protected by CLEARSUGAR_API_KEY. Scheduled every 5 min via systemd timer.
 */
const COOLDOWN_KEY = "advisor/last-fired.json";
const ADVISOR_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h per id
const SEV_RANK = ["info", "low", "moderate", "high", "urgent"];

type LastFiredMap = Record<string, { at: number; severity: string }>;

/** Shadow unless ADVISOR_SHADOW is explicitly "false" — safe default. */
function isShadow(): boolean {
  return (process.env.ADVISOR_SHADOW ?? "true").toLowerCase() !== "false";
}

export async function GET(req: Request) {
  const apiKey = req.headers.get("x-api-key");
  if (!apiKey || !process.env.CLEARSUGAR_API_KEY || !safeEqual(apiKey, process.env.CLEARSUGAR_API_KEY)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [readings, treatments, profiles, pumpState] = await Promise.all([
      getEntries(72, 6 * 60 * 60 * 1000), // 6h readings
      getTreatments(300, 8 * 60 * 60 * 1000), // 8h treatments (IOB lookback)
      getProfile(),
      getPumpState(), // pump IOB + real Control-IQ settings (null when unpublished)
    ]);
    const profile = profiles?.[0];
    if (!profile) {
      return NextResponse.json({ error: "No pump profile found" }, { status: 502 });
    }

    const now = Date.now();
    const result = evaluateAdvisories({ readings, treatments, profile, now, pumpState });

    // Option 2 — pump-IOB calibration (SAFE, additive): shadow-compare the pump's
    // own IOB against ClearSugar's computed IOB at the pump timestamp and record
    // one deduped sample per pump event. Never affects firing.
    const calSample = compareIob(pumpState, treatments, profile, now);
    const calRecorded = await recordCalSample(calSample);

    // CIQ settings change tracker (SAFE, additive): diff the pump-state
    // settings snapshot so AI insights can flag regime changes by date.
    const settingsChanged = await trackSettingsChanges(pumpState, now).catch(
      () => [] as string[]
    );
    if (settingsChanged.length > 0) {
      console.log(`advisor: pump settings changed — ${settingsChanged.join("; ")}`);
    }

    // Cooldown: fire if outside the 2h window OR the situation worsened.
    const lastFired = await loadJSON<LastFiredMap>(COOLDOWN_KEY, {});
    const toFire: AdvisoryAction[] = [];
    for (const a of result.actions) {
      const prev = lastFired[a.id];
      const worsened = prev
        ? SEV_RANK.indexOf(a.severity) > SEV_RANK.indexOf(prev.severity)
        : true;
      const cooled = !prev || now - prev.at > ADVISOR_COOLDOWN_MS;
      if (cooled || worsened) toFire.push(a);
    }

    const shadow = isShadow();
    // Object.keys = the APNs tokens (map is token → deviceName). Using values
    // here would push to device names and silently fail — matches the working
    // glucose alerter (push/send uses Object.keys).
    const tokens = shadow ? [] : Object.keys(await loadAlertTokens());
    // Per-advisory routing: a high-side pen-correction is a parent DOSING
    // decision, so it goes ONLY to the designated high-alert recipient(s). If
    // none is configured it is NOT delivered (never blast an insulin suggestion
    // to every device). All other advisories go to every registered device.
    // Prefer role assignments: they resolve through the auth subject, so they
    // survive an APNs token rotation (a TestFlight/app update mints a new token,
    // and a hand-maintained token list silently goes stale at exactly that
    // moment). Falls back to the legacy token file while nothing is assigned.
    const prefsForRouting = shadow ? {} : await loadAlertPrefs();
    const identitiesForRouting = shadow ? {} : await loadIdentities();
    const assignedParents = parentTokens(prefsForRouting, identitiesForRouting);
    const highRecipients = shadow
      ? []
      : assignedParents.length > 0
        ? assignedParents
        : await loadJSON<string[]>("push/high-alert-recipients.json", []);
    // Option 3 / sleep wake-gate: use the pump's actual Sleep schedule (22:00–
    // 05:00, from the published pump-state) as the overnight quiet-hours window,
    // replacing the hardcoded 22:00–07:00. Falls back to
    // 22:00–05:00 when the pump-state doc is absent.
    const sleepQuiet = isPumpSleep(now, pumpState?.controlIQ?.sleepSchedule);
    // CIQ mode active now (sleep/exercise/normal) — labels the outcome record.
    const ciqMode = getCiqMode(treatments, now);
    let pushed = 0;
    let deliveryFailures = 0;
    const failureReasons: string[] = [];

    for (const a of toFire) {
      await recordFired(a, ciqMode); // always record — shadow or live — for outcome harvest

      let delivered = 0;
      let attempted = 0;

      if (!shadow && !SILENT_TIERS.has(a.tier)) {
        // High-side insulin advice → designated recipient(s) only; all else → all.
        const isHighSide = a.actionClass === "high_correction";
        const targets = isHighSide
          ? tokens.filter((t) => highRecipients.includes(t))
          : tokens;
        if (isHighSide && targets.length === 0) {
          console.warn(
            `advisor: ${a.id} fired but no high-alert recipient configured — not delivered`
          );
        }
        if (targets.length > 0) {
          // Wake-gate: during the pump's Sleep window, only a severe-projected low
          // (T4_critical) may use a waking channel; every other tier drops to
          // passive so non-severe night fires never wake the house. Outside the
          // Sleep window each tier keeps its normal interruption level.
          const level =
            sleepQuiet && a.tier !== "T4_critical" ? "passive" : TIER_INTERRUPTION[a.tier];
          const results = await Promise.allSettled(
            targets.map((t) =>
              // No app-name prefix: iOS renders the app name above every notification
              // already, so prefixing the title duplicated it and cost ~12 chars of
              // lock-screen headline.
              pushAlertNotification(t, a.headline, a.orElse, undefined, level)
            )
          );
          attempted = targets.length;
          delivered = results.filter((r) => r.status === "fulfilled").length;
          pushed += delivered;
          // A stale recipient list is indistinguishable from a correct one until
          // delivery is counted: targets.length > 0 with every push rejected (e.g.
          // tokens invalidated by an app update) reaches nobody while sailing past
          // the targets.length === 0 guard above. Insulin advice silently reaching
          // no one is the failure this whole path exists to avoid.
          if (isHighSide && delivered === 0) {
            console.error(
              `advisor: ${a.id} (high-side insulin) reached NOBODY — ${attempted} target(s), all rejected. Check the high-alert recipient assignment`
            );
          }
          for (const r of results) {
            if (r.status === "rejected") {
              deliveryFailures += 1;
              const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
              failureReasons.push(`${a.id}: ${reason}`);
              console.error(`advisor: push failed for ${a.id}: ${reason}`);
            }
          }
        }
      }

      // Cooldown policy (Hard Safety): a wake-critical low must NOT start its 2h
      // cooldown on a failed delivery — a transient APNs error would then silence a
      // real severe low until the next window. For T4_critical in LIVE mode, only
      // record the fire once ≥1 push actually delivered; otherwise leave it uncooled
      // so the next 5-min tick re-fires. All other advisories (and shadow/silent,
      // which never attempt delivery) keep the prior behavior.
      const mustDeliver = !shadow && a.tier === "T4_critical" && !SILENT_TIERS.has(a.tier);
      if (!mustDeliver || delivered > 0) {
        lastFired[a.id] = { at: now, severity: a.severity };
      } else {
        console.warn(
          `advisor: ${a.id} (T4_critical) not delivered (${delivered}/${attempted}) — cooldown NOT set, will re-fire next tick`
        );
      }
    }
    await saveJSON(COOLDOWN_KEY, lastFired);

    // Delivery-health signal for the liveness watchdog (deadman). Records the last
    // run's delivery outcome so a silent APNs death (200s but nobody reached, or
    // repeated rejections) is observable instead of failing quietly.
    await saveJSON("advisor/delivery-health.json", {
      lastRunAt: now,
      mode: shadow ? "shadow" : "live",
      fired: toFire.length,
      pushed,
      deliveryFailures,
      lastFailureReasons: failureReasons.slice(0, 5),
    });

    return NextResponse.json({
      mode: shadow ? "shadow" : "live",
      evaluated: result.actions.length,
      fired: toFire.map((a) => ({
        id: a.id,
        tier: a.tier,
        severity: a.severity,
        headline: a.headline,
        orElse: a.orElse,
        leadTimeMin: a.leadTimeMin,
      })),
      pushed,
      deliveryFailures,
      siteFailureVeto: result.siteFailureVeto,
      pumpStaleMin: result.pumpStaleMin,
      staleSuppressed: result.staleSuppressed,
      iobCalibration: calSample
        ? { recorded: calRecorded, ...calSample }
        : { recorded: false },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
