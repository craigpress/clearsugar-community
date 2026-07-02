import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

const WEBHOOK_URL = process.env.TCONNECT_WEBHOOK_URL;
const WEBHOOK_TOKEN = process.env.TCONNECT_WEBHOOK_TOKEN ?? "";

/** The webhook authorizes POST /sync with a bearer token (it 401s without it). */
function webhookAuthHeaders(): HeadersInit {
  return WEBHOOK_TOKEN ? { Authorization: `Bearer ${WEBHOOK_TOKEN}` } : {};
}

export async function POST(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  try {
    if (!WEBHOOK_URL) {
      return NextResponse.json(
        { error: "Sync not configured (missing TCONNECT_WEBHOOK_URL)" },
        { status: 503 }
      );
    }
    const res = await fetch(`${WEBHOOK_URL}/sync`, {
      method: "POST",
      headers: webhookAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `Webhook returned ${res.status}: ${text}` },
        { status: 502 }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Cannot reach tconnect webhook: ${message}` },
      { status: 502 }
    );
  }
}

export async function GET(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  try {
    if (!WEBHOOK_URL) {
      return NextResponse.json({ available: false }, { status: 200 });
    }
    const res = await fetch(`${WEBHOOK_URL}/health`, {
      headers: webhookAuthHeaders(),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return NextResponse.json({ available: false }, { status: 200 });
    }

    const data = await res.json();
    return NextResponse.json({ available: true, ...data });
  } catch {
    return NextResponse.json({ available: false }, { status: 200 });
  }
}
