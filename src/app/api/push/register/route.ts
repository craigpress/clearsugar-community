import { NextResponse } from "next/server";
import { loadJSON, saveJSON } from "@/lib/local-store";
import { requireApiAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

const LIVE_ACTIVITY_TOKENS_KEY = "push/live-activity-tokens.json";

// Maps APNs push token → device name (for display only)
type LiveActivityTokenMap = Record<string, string>;

export async function loadLiveActivityTokens(): Promise<LiveActivityTokenMap> {
  return loadJSON<LiveActivityTokenMap>(LIVE_ACTIVITY_TOKENS_KEY, {});
}

export async function saveLiveActivityTokens(tokens: LiveActivityTokenMap): Promise<void> {
  await saveJSON(LIVE_ACTIVITY_TOKENS_KEY, tokens);
}

export async function POST(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  try {
    const body = await req.json();
    const token = (body.pushToken || body.token || "").trim();
    const device = (body.device || "unknown").trim();

    if (!token) {
      return NextResponse.json({ error: "token required" }, { status: 400 });
    }

    const tokens = await loadLiveActivityTokens();
    tokens[token] = device;
    await saveLiveActivityTokens(tokens);

    console.log(`Registered LA token for '${device}': ${token.substring(0, 16)}... (${Object.keys(tokens).length} devices)`);

    return NextResponse.json({ registered: true, device, count: Object.keys(tokens).length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function GET(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  const tokens = await loadLiveActivityTokens();
  const safe = Object.fromEntries(
    Object.entries(tokens).map(([token, device]) => [token.substring(0, 8) + "...", device])
  );
  return NextResponse.json({ devices: safe, count: Object.keys(tokens).length });
}
