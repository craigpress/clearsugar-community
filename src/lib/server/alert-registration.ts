import { NextResponse } from "next/server";
import { loadJSON, saveJSON } from "@/lib/local-store";
import { requireApiAuth } from "@/lib/api-auth";
import { replaceAlertToken } from "@/lib/alert-token-store";


const ALERT_TOKENS_KEY = "push/alert-tokens.json";
const ALERT_INSTALLS_KEY = "push/alert-installs.json";
const PREFS_KEY = "push/alert-preferences.json";
const RECIPIENTS_KEY = "push/high-alert-recipients.json";

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
 *
 * Body: { token: string, device: string, installId?: string }
 *
 * When the app sends its installId (build 13+), the token is keyed to that
 * install: a re-register with a NEW token (APNs rotation, restore) replaces the
 * install's previous token everywhere — registration map, per-device prefs
 * (thresholds/role survive the rotation), and its high-alert recipient slot —
 * instead of accumulating. Without it, registration is append-only: tokens pile
 * up, every alert fans out to every stale endpoint, a phone holding two live
 * tokens gets each alert twice, and high-alert recipient slots end up pointing
 * at long-dead tokens. Builds that do not send installId keep the old behavior.
 */
export async function POST(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  try {
    const body = await req.json();
    const token = (body.token || body.pushToken || "").trim();
    const device = (body.device || "unknown").trim();
    const installId = (body.installId || "").trim();

    if (!token) {
      return NextResponse.json({ error: "token required" }, { status: 400 });
    }

    const tokens = await loadAlertTokens();
    let replaced: string | null = null;

    if (installId) {
      const installs = await loadJSON<Record<string, string>>(ALERT_INSTALLS_KEY, {});
      const oldToken = installs[installId];
      if (oldToken && oldToken !== token) {
        // Same install, new token → migrate everything keyed on the old one.
        const [prefs, recipients] = await Promise.all([
          loadJSON<Record<string, unknown>>(PREFS_KEY, {}),
          loadJSON<string[]>(RECIPIENTS_KEY, []),
        ]);
        const stores = { tokens, prefs, recipients };
        replaceAlertToken(stores, oldToken, token, device);
        await Promise.all([
          saveJSON(PREFS_KEY, stores.prefs),
          saveJSON(RECIPIENTS_KEY, stores.recipients),
        ]);
        replaced = oldToken;
      } else {
        tokens[token] = device;
      }
      installs[installId] = token;
      await saveJSON(ALERT_INSTALLS_KEY, installs);
    } else {
      tokens[token] = device;
    }

    await saveAlertTokens(tokens);

    console.log(
      `Registered alert token for '${device}': ${token.substring(0, 16)}...` +
        (replaced ? ` (replaced ${replaced.substring(0, 8)}…)` : "") +
        ` (${Object.keys(tokens).length} devices)`,
    );

    return NextResponse.json({
      registered: true,
      device,
      count: Object.keys(tokens).length,
      ...(replaced && { replacedToken: replaced.substring(0, 8) }),
    });
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
