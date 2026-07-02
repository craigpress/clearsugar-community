import { NextResponse } from "next/server";
import { loadJSON, saveJSON } from "@/lib/local-store";
import { requireApiAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

const PREFS_KEY = "push/alert-preferences.json";

export interface DeviceAlertPrefs {
  device: string;  // display name only
  thresholdUrgentLow: number;
  thresholdLow: number;
  thresholdHigh: number;
  thresholdUrgentHigh: number;
}

const DEFAULT_PREFS: Omit<DeviceAlertPrefs, "device"> = {
  thresholdUrgentLow: 55,
  thresholdLow: 70,
  thresholdHigh: 180,
  thresholdUrgentHigh: 250,
};

// Maps APNs token → prefs (token is stable unique key; device name is display only)
type PrefsMap = Record<string, DeviceAlertPrefs>;

export async function loadAlertPrefs(): Promise<PrefsMap> {
  return loadJSON<PrefsMap>(PREFS_KEY, {});
}

async function saveAlertPrefs(prefs: PrefsMap): Promise<void> {
  await saveJSON(PREFS_KEY, prefs);
}

/** Returns prefs for a token, falling back to defaults for missing fields */
export function getDevicePrefs(prefs: PrefsMap, token: string): DeviceAlertPrefs {
  const p = prefs[token];
  return {
    device: p?.device ?? "unknown",
    thresholdUrgentLow: typeof p?.thresholdUrgentLow === "number" ? p.thresholdUrgentLow : DEFAULT_PREFS.thresholdUrgentLow,
    thresholdLow: typeof p?.thresholdLow === "number" ? p.thresholdLow : DEFAULT_PREFS.thresholdLow,
    thresholdHigh: typeof p?.thresholdHigh === "number" ? p.thresholdHigh : DEFAULT_PREFS.thresholdHigh,
    thresholdUrgentHigh: typeof p?.thresholdUrgentHigh === "number" ? p.thresholdUrgentHigh : DEFAULT_PREFS.thresholdUrgentHigh,
  };
}

/**
 * POST /api/alerts/preferences
 *
 * Stores per-device glucose alert thresholds.
 * Called by iOS app on launch and when settings change.
 *
 * Body: { token: string, device: string, thresholdUrgentLow?, thresholdLow?, thresholdHigh?, thresholdUrgentHigh? }
 */
export async function POST(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  try {
    const body = await req.json();
    const token = (body.token || "").trim();
    const device = (body.device || "unknown").trim();
    if (!token) {
      return NextResponse.json({ error: "token required" }, { status: 400 });
    }

    const prefs = await loadAlertPrefs();
    prefs[token] = {
      device,
      thresholdUrgentLow: typeof body.thresholdUrgentLow === "number" ? body.thresholdUrgentLow : DEFAULT_PREFS.thresholdUrgentLow,
      thresholdLow: typeof body.thresholdLow === "number" ? body.thresholdLow : DEFAULT_PREFS.thresholdLow,
      thresholdHigh: typeof body.thresholdHigh === "number" ? body.thresholdHigh : DEFAULT_PREFS.thresholdHigh,
      thresholdUrgentHigh: typeof body.thresholdUrgentHigh === "number" ? body.thresholdUrgentHigh : DEFAULT_PREFS.thresholdUrgentHigh,
    };
    await saveAlertPrefs(prefs);

    return NextResponse.json({ saved: true, device, token: token.substring(0, 8) + "...", prefs: prefs[token] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** GET /api/alerts/preferences — list all device preferences (tokens truncated) */
export async function GET(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  const prefs = await loadAlertPrefs();
  const safe = Object.fromEntries(
    Object.entries(prefs).map(([token, p]) => [token.substring(0, 8) + "...", p])
  );
  return NextResponse.json({ devices: safe, defaults: DEFAULT_PREFS });
}
