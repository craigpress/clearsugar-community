import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/qr
 *
 * Returns a QR payload the companion app scans to learn which server to talk
 * to. Encodes a JSON blob { serverUrl } — the app then prompts for
 * username/password and calls POST /api/auth/mobile/token to pair.
 * No secret material is encoded. Only available to authenticated users.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const serverUrl = process.env.APP_URL || new URL(req.url).origin;
  const qrData = JSON.stringify({ serverUrl });

  return NextResponse.json({ qr_data: qrData });
}
