import { NextResponse, type NextRequest } from "next/server";
import { getEntries } from "@/lib/nightscout";
import { calculateStats } from "@/lib/statistics";
import { requireApiAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = await requireApiAuth(request);
  if (denied) return denied;
  const { searchParams } = request.nextUrl;
  const hours = parseInt(searchParams.get("hours") || "24", 10);
  const maxAge = hours * 60 * 60 * 1000;
  const count = Math.min(hours * 12, 26000);

  try {
    const entries = await getEntries(count, maxAge);
    const stats = calculateStats(entries);
    return NextResponse.json({ ...stats, hours, readingCount: entries.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
