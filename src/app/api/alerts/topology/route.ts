import { NextResponse } from "next/server";
import { loadJSON } from "@/lib/local-store";
import { requireApiAuth } from "@/lib/api-auth";
import { loadAlertPrefs } from "@/app/api/alerts/preferences/route";

export const dynamic = "force-dynamic";

/**
 * GET /api/alerts/topology — read-only view of every ALERT PATH that can
 * actually reach a phone, so the website reflects reality instead of the
 * legacy toggle list (which since the 2026-07-02 consolidation only filters
 * the in-app detection log).
 *
 * Two live layers:
 *  1. iOS glucose alerter (/api/push/send, 5-min timer) — per-device
 *     threshold alerts from push/alert-preferences.json.
 *  2. Action advisor (/api/advisor/check, 5-min timer) — smart alerts
 *     (impending low via ROC, CIQ-capped high, failing site, stale data).
 */

export async function GET(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  const [prefsMap, deliveryHealth] = await Promise.all([
    loadAlertPrefs(),
    loadJSON<{ mode?: string; lastRunAt?: number }>(
      "advisor/delivery-health.json",
      {}
    ),
  ]);

  const iosDevices = Object.entries(prefsMap).map(([token, p]) => ({
    device: p.device,
    tokenSuffix: token.slice(-6),
    thresholds: {
      urgentLow: p.thresholdUrgentLow,
      low: p.thresholdLow,
      high: p.thresholdHigh,
      urgentHigh: p.thresholdUrgentHigh,
    },
  }));

  return NextResponse.json({
    advisor: {
      mode: deliveryHealth.mode ?? null,
      lastRunAt: deliveryHealth.lastRunAt ?? null,
      rules: [
        { id: "impending_low", label: "Impending low (ROC projection)", delivery: "Both phones, time-sensitive; wake-critical severe lows pierce sleep gate" },
        { id: "ciq_capped_high", label: "CIQ-capped high (insulin can't keep up)", delivery: "High-alert recipients only (dosing decision)" },
        { id: "failing_site", label: "Failing infusion site (absorption deficit)", delivery: "Both phones, time-sensitive" },
        { id: "stale_data", label: "Pump/CGM data stale", delivery: "Both phones" },
      ],
    },
    iosGlucose: {
      cadence: "every 5 min",
      devices: iosDevices,
    },
    generatedAt: Date.now(),
  });
}
