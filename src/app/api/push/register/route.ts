import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { loadInstalls, saveInstalls, upsertToken } from "@/lib/live-activity-store";

export const dynamic = "force-dynamic";

/**
 * POST /api/push/register
 *
 * Registers a Live Activity token onto an install record. Accepts a stable
 * `installId` (build 8+) so the server can pair a device's push-to-start token
 * and per-activity update token; a build-7 payload with only `pushToken` still
 * works (the store synthesizes an install key from the token).
 *
 * Body: { installId?, device?, pushToken? , pushToStartToken? }
 */
export async function POST(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    const installId: string | undefined = (body.installId || "").trim() || undefined;
    const device = (body.device || "unknown").trim();
    const updateToken = (body.pushToken || body.token || "").trim();
    const startToken = (body.pushToStartToken || "").trim();

    if (!updateToken && !startToken) {
      return NextResponse.json({ error: "pushToken or pushToStartToken required" }, { status: 400 });
    }

    const store = await loadInstalls();
    let id = installId ?? "";
    if (updateToken) id = upsertToken(store, { installId, device, kind: "update", token: updateToken });
    if (startToken) id = upsertToken(store, { installId, device, kind: "start", token: startToken });
    await saveInstalls(store);

    return NextResponse.json({ registered: true, device, installId: id, count: Object.keys(store).length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function GET(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  const store = await loadInstalls();
  const safe = Object.fromEntries(
    Object.entries(store).map(([id, rec]) => {
      // Legacy/synthesized installs are keyed on the full APNs token — mask it.
      const maskedId = id.startsWith("tok:") ? `tok:${id.slice(4, 12)}…` : id;
      return [maskedId, {
        device: rec.device,
        hasUpdate: !!rec.updateToken,
        hasStart: !!rec.startToken,
      }];
    })
  );
  return NextResponse.json({ installs: safe, count: Object.keys(store).length });
}
