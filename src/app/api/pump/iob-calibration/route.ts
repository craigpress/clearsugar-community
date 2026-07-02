import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/api-auth";
import { loadCalSamples, summarize } from "@/lib/prediction/iob-calibration";

export const dynamic = "force-dynamic";

/**
 * GET /api/pump/iob-calibration — review endpoint for Option 2.
 *
 * Returns the rolling pump-vs-computed IOB bias summary (and, with ?full=1, the
 * raw samples). Pure observability — samples are recorded by the advisor cron.
 * Protected by CLEARSUGAR_API_KEY.
 */
export async function GET(req: Request) {
  const apiKey = req.headers.get("x-api-key");
  if (!apiKey || !process.env.CLEARSUGAR_API_KEY || !safeEqual(apiKey, process.env.CLEARSUGAR_API_KEY)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const samples = await loadCalSamples();
  const url = new URL(req.url);
  const body: Record<string, unknown> = { summary: summarize(samples) };
  if (url.searchParams.get("full") === "1") body.samples = samples;
  return NextResponse.json(body);
}
