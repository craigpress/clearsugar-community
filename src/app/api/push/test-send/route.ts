import { NextResponse } from "next/server";
import { pushAlertNotification } from "@/lib/apns";
import { loadAlertTokens } from "@/app/api/push/register-alert/route";
import { requireApiAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/push/test-send — routing-identification helper.
 *
 * Sends a labeled test alert to every registered device so a human can say which
 * tag their phone showed, letting us map a person → APNs token (both devices are
 * named "iPhone", so name can't distinguish them). Used to populate
 * push/high-alert-recipients.json. Returns tag → token-prefix. Auth-protected.
 */
export async function POST(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  const map = await loadAlertTokens(); // token → deviceName
  const tokens = Object.keys(map);
  const results: { tag: string; device: string; tokenPrefix: string; ok: boolean }[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tag = String.fromCharCode(65 + i); // A, B, C…
    const token = tokens[i];
    let ok = false;
    try {
      const r = await pushAlertNotification(
        token,
        `Tag ${tag}`,
        `ClearSugar high-alert routing test. Reply "${tag}" to Claude to send the high-side (insulin) alerts to THIS phone.`,
        undefined,
        "active"
      );
      ok = r.success;
    } catch {
      ok = false;
    }
    results.push({ tag, device: map[token], tokenPrefix: token.slice(0, 10), ok });
  }

  return NextResponse.json({ sent: results.length, results });
}
