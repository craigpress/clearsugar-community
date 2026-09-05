import { NextResponse } from "next/server";
import { loadJSON, saveJSON } from "@/lib/local-store";
import { requireApiAuth } from "@/lib/api-auth";


const ALERT_TOKENS_KEY = "push/alert-tokens.json";

// Maps APNs token → device name (for display only)
type AlertTokenMap = Record<string, string>;

export async function loadAlertTokens(): Promise<AlertTokenMap> {
  return loadJSON<AlertTokenMap>(ALERT_TOKENS_KEY, {});
}

async function saveAlertTokens(tokens: AlertTokenMap): Promise<void> {
  await saveJSON(ALERT_TOKENS_KEY, tokens);
}

/**
 * POST /api/push/register-alert
 *
 * Registers a regular APNs device token for clinical alert delivery.
 * Keyed by APNs token (stable unique identifier) rather than device name.
 *
 * Body: { token: string, device: string }
 */
export async function POST(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  try {
    const body = await req.json();
    const token = (body.token || body.pushToken || "").trim();
    const device = (body.device || "unknown").trim();

    if (!token) {
      return NextResponse.json({ error: "token required" }, { status: 400 });
    }

    const tokens = await loadAlertTokens();
    tokens[token] = device;
    await saveAlertTokens(tokens);

    console.log(`Registered alert token for '${device}': ${token.substring(0, 16)}... (${Object.keys(tokens).length} devices)`);

    return NextResponse.json({ registered: true, device, count: Object.keys(tokens).length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** GET /api/push/register-alert — list registered alert devices */
export async function GET(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  const tokens = await loadAlertTokens();
  const safe = Object.fromEntries(
    Object.entries(tokens).map(([token, device]) => [token.substring(0, 8) + "...", device])
  );
  return NextResponse.json({ devices: safe, count: Object.keys(tokens).length });
}
