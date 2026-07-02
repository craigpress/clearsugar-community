import { NextResponse, type NextRequest } from "next/server";
import { loadJSON, saveJSON } from "@/lib/local-store";
import { requireApiAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

const SETTINGS_KEY = "alerts/settings.json";

export interface AlertSettings {
  // Which detection rule categories are enabled
  rules: {
    site_sustained_high: boolean;       // ketone_risk + sustained_high_site
    site_failed_corrections: boolean;   // failed_corrections
    site_autobolus_stacking: boolean;   // autobolus_stacking
    site_rising_with_iob: boolean;      // rising_with_iob
    site_age: boolean;                  // old_site + old_site_highs
    cgm_noise: boolean;                 // cgm_heavy_noise + cgm_medium_noise
    cgm_gaps: boolean;                  // cgm_long_gap + cgm_frequent_gaps
    cgm_stuck: boolean;                 // cgm_stuck
    cgm_compression: boolean;           // cgm_compression
    cgm_sensor_aging: boolean;          // sensor_aging
    cgm_warmup: boolean;                // sensor_warmup
  };
  // Push notification preferences
  push: {
    enabled: boolean;
    quietHoursEnabled: boolean;
    quietHourStart: number; // 0-23
    quietHourEnd: number;   // 0-23
    minSeverityForPush: "moderate" | "high"; // moderate = more alerts, high = fewer
  };
}

export const DEFAULT_SETTINGS: AlertSettings = {
  rules: {
    site_sustained_high: true,
    site_failed_corrections: true,
    site_autobolus_stacking: true,
    site_rising_with_iob: true,
    site_age: true,
    cgm_noise: true,
    cgm_gaps: true,
    cgm_stuck: true,
    cgm_compression: true,
    cgm_sensor_aging: true,
    cgm_warmup: true,
  },
  push: {
    enabled: true,
    quietHoursEnabled: true,
    quietHourStart: 22,
    quietHourEnd: 7,
    minSeverityForPush: "high",
  },
};

export async function loadSettings(): Promise<AlertSettings> {
  const partial = await loadJSON<Partial<AlertSettings>>(SETTINGS_KEY, {});
  return {
    rules: { ...DEFAULT_SETTINGS.rules, ...partial.rules },
    push: { ...DEFAULT_SETTINGS.push, ...partial.push },
  };
}

/** GET /api/alerts/settings — returns current settings */
export async function GET(request: NextRequest) {
  try {
    const denied = await requireApiAuth(request);
    if (denied) return denied;
    return NextResponse.json(await loadSettings());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** PUT /api/alerts/settings — saves full settings object */
export async function PUT(request: NextRequest) {
  try {
    const denied = await requireApiAuth(request);
    if (denied) return denied;

    const body = await request.json().catch(() => null);
    if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

    const merged: AlertSettings = {
      rules: { ...DEFAULT_SETTINGS.rules, ...(body.rules ?? {}) },
      push: { ...DEFAULT_SETTINGS.push, ...(body.push ?? {}) },
    };

    await saveJSON(SETTINGS_KEY, merged);

    return NextResponse.json(merged);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
