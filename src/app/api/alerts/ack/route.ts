import { NextResponse } from "next/server";
import { loadJSON, saveJSON } from "@/lib/local-store";
import { requireApiAuth } from "@/lib/api-auth";
import { ALERT_CONFIG } from "@/lib/alert-classify";
import { recordDeviceAck, pruneExpiredAcks, type DeviceAckStore } from "@/lib/alert-policy";

export const dynamic = "force-dynamic";

const ACKS_KEY = "push/alert-acks.json";

export async function loadDeviceAcks(): Promise<DeviceAckStore> {
  return loadJSON<DeviceAckStore>(ACKS_KEY, {});
}

export async function saveDeviceAcks(store: DeviceAckStore): Promise<void> {
  await saveJSON(ACKS_KEY, store);
}

/**
 * POST /api/alerts/ack — per-device, per-type acknowledgement.
 *
 * Before 2026-07-24, tapping Acknowledge only cancelled the phone's LOCAL 60s
 * repeat; the server had no idea and kept alerting on its own schedule. the owner's
 * chosen semantics: an ack quiets exactly the acking phone, for exactly the
 * acked alert type, for that type's cooldown. Other phones keep alerting, and
 * escalation to a more urgent category still fires everywhere — so a casual ack
 * can never silence another caregiver or mask a worsening low.
 *
 * Body: { token: string, alertType: "urgentLow"|"low"|"high"|"urgentHigh", device?: string }
 */
export async function POST(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  try {
    const body = await req.json();
    const token = (body.token || "").trim();
    const alertType = String(body.alertType || "");
    const config = ALERT_CONFIG[alertType];

    if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });
    if (!config) return NextResponse.json({ error: `unknown alertType '${alertType}'` }, { status: 400 });

    const now = Date.now();
    const until = now + config.cooldownMs;
    const store = await loadDeviceAcks();
    pruneExpiredAcks(store, now);
    recordDeviceAck(store, token, alertType, until);
    await saveDeviceAcks(store);

    console.log(
      `[alerts/ack] ${body.device ?? "unknown"} acked ${alertType} for ${Math.round(config.cooldownMs / 60_000)} min (${token.slice(0, 10)}…)`,
    );
    return NextResponse.json({ acked: true, alertType, until });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
