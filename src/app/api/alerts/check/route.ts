import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/api-auth";
import { loadJSON, saveJSON } from "@/lib/local-store";
import { getEntries, getTreatments } from "@/lib/nightscout";
import { detectSiteAndSensorIssues } from "@/lib/insights/site-sensor-detection";
import { DEFAULT_SETTINGS, type AlertSettings } from "@/lib/server/alert-settings";

export const dynamic = "force-dynamic";

const DEDUP_KEY = "alerts/last-fired.json";
const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours per alert id

type LastFiredMap = Record<string, number>; // alertId → epoch ms

/** Maps alert IDs → which settings rule key controls them */
const ALERT_RULE_MAP: Record<string, keyof AlertSettings["rules"]> = {
  ketone_risk:            "site_sustained_high",
  sustained_high_site:    "site_sustained_high",
  failed_corrections:     "site_failed_corrections",
  autobolus_stacking:     "site_autobolus_stacking",
  rising_with_iob:        "site_rising_with_iob",
  old_site:               "site_age",
  old_site_highs:         "site_age",
  cgm_heavy_noise:        "cgm_noise",
  cgm_medium_noise:       "cgm_noise",
  cgm_long_gap:           "cgm_gaps",
  cgm_frequent_gaps:      "cgm_gaps",
  cgm_stuck:              "cgm_stuck",
  cgm_compression:        "cgm_compression",
  cgm_quality_good:       "cgm_noise",
  sensor_aging:           "cgm_sensor_aging",
  sensor_warmup:          "cgm_warmup",
};

async function loadSettingsLocal(): Promise<AlertSettings> {
  const partial = await loadJSON<Partial<AlertSettings>>("alerts/settings.json", {});
  return {
    rules: { ...DEFAULT_SETTINGS.rules, ...partial.rules },
    push: { ...DEFAULT_SETTINGS.push, ...partial.push },
  };
}

/**
 * GET /api/alerts/check — legacy site/sensor detection, DEMOTED to silent-log
 * (2026-07-02 consolidation). Detections are recorded to alerts/last-fired.json
 * for in-app display and analysis but are NEVER pushed:
 *
 *  - Site-failure pushes are owned by the action-advisor's validated
 *    absorption-deficit detector (failing_site — catches the failed-corrections /
 *    rising-with-IOB / ketone class, incl. the Jun-12 archetype).
 *  - CGM noise/gap/stuck/compression alerts were Phase-0-rated low-actionability
 *    (docs/PHASE0_FINDINGS_2026-06-19.md) — in-app only.
 *  - The old push block had ALSO been delivering nothing since the alert-token
 *    map was re-keyed token→deviceName: it pushed to Object.values (device
 *    names), so every APNs call failed. Removing it loses no delivery.
 *
 * This collapses the app to ONE push path (the advisor) with one dedup file.
 * Protected by CLEARSUGAR_API_KEY. Scheduled every 15 minutes via systemd timer.
 */
export async function GET(req: Request) {
  const apiKey = req.headers.get("x-api-key");
  if (!apiKey || !process.env.CLEARSUGAR_API_KEY || !safeEqual(apiKey, process.env.CLEARSUGAR_API_KEY)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [readings, treatments, settings] = await Promise.all([
      getEntries(72, 6 * 60 * 60 * 1000), // 72 readings = 6h
      getTreatments(300, 8 * 60 * 60 * 1000), // 8h treatments (IOB lookback)
      loadSettingsLocal(),
    ]);

    // Run detection, then filter by user-enabled rules (the toggles' remaining
    // job: gating in-app alert noise).
    const allAlerts = detectSiteAndSensorIssues(readings, treatments);
    const ruleFiltered = allAlerts.filter((a) => {
      const ruleKey = ALERT_RULE_MAP[a.id];
      return ruleKey ? settings.rules[ruleKey] : true;
    });

    // Dedup so "fired" still means "newly detected since cooldown" in the log.
    const lastFired = await loadJSON<LastFiredMap>(DEDUP_KEY, {});
    const now = Date.now();
    const toFire = ruleFiltered.filter((a) => now - (lastFired[a.id] ?? 0) > ALERT_COOLDOWN_MS);

    for (const alert of toFire) {
      lastFired[alert.id] = now;
      console.log(`alerts (silent-log): ${alert.id} [${alert.severity}] ${alert.title}`);
    }
    if (toFire.length > 0) await saveJSON(DEDUP_KEY, lastFired);

    return NextResponse.json({
      checked: allAlerts.length,
      pushed: 0,
      pushDemoted: true,
      fired: toFire.map((a) => ({ id: a.id, severity: a.severity, title: a.title })),
      alerts: allAlerts.map((a) => ({ id: a.id, severity: a.severity, title: a.title })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
