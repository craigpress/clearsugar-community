import { NextResponse, type NextRequest } from "next/server";
import { getEntries } from "@/lib/nightscout";
import { requireApiAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = await requireApiAuth(request);
  if (denied) return denied;
  const { searchParams } = request.nextUrl;
  const hours = parseInt(searchParams.get("hours") || "3", 10);
  const maxAge = hours * 60 * 60 * 1000;

  // Cap at 90 days
  const cappedMaxAge = Math.min(maxAge, 90 * 24 * 60 * 60 * 1000);
  // Estimate count: 12 readings/hr, +20% and a flat 60-reading headroom to
  // absorb duplicate/backfilled uploads and the partial end-of-day hour.
  // Ceiling raised so 90 days (~25,920 readings) is never clipped.
  const count = Math.min(Math.ceil(hours * 12 * 1.2) + 60, 60000);

  try {
    const entries = await getEntries(count, cappedMaxAge);
    return NextResponse.json(entries, {
      headers: { "Cache-Control": "private, max-age=30" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
