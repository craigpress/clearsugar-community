import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { loadInstalls, saveInstalls, markActivityEnded } from "@/lib/live-activity-store";

export const dynamic = "force-dynamic";

/**
 * POST /api/push/activity-ended
 *
 * The app reports that its Live Activity ended or was dismissed, so the server
 * can send a push-to-start deterministically instead of guessing.
 *
 * This exists because APNs is not a reliable liveness oracle: it keeps returning
 * `200` on the update token of an activity that has already ended on the device.
 * `decideStart` treated that 200 as proof the card was alive, so on 2026-07-21 an
 * expired card was never resurrected across all 91 overnight cycles — `started`
 * was 0 every time. An explicit ack from the app is the only positive signal.
 *
 * Body: { installId }
 * Unknown installs return 200 with `{ recorded: false }` rather than 404 — the
 * app should not retry, and a stale install that has already been pruned is an
 * expected, benign race, not a client error.
 */
export async function POST(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    const installId = (body.installId || "").trim();
    if (!installId) {
      return NextResponse.json({ error: "installId required" }, { status: 400 });
    }

    const store = await loadInstalls();
    const recorded = markActivityEnded(store, installId);
    if (recorded) await saveInstalls(store);

    return NextResponse.json({ recorded, installId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
