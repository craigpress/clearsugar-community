import { withMealRoute } from "@/lib/meals/profile-route";
import { NextResponse } from "next/server";
import { requireIdentity } from "@/lib/patient-auth";
import { listEpisodes } from "@/lib/meals/episodes";

export const dynamic = "force-dynamic";

/** Default read window, and the widest one accepted (matches GET /api/meals). */
const DEFAULT_HOURS = 24;
const MAX_HOURS = 24 * 30;

/**
 * GET /api/meals/episodes?hours=N — the prompt/reply log (section 4c).
 *
 * 200 { episodes } newest first · 401 unauthenticated · 403 machine key
 *
 * Person-scoped, any role (decision 4: parents view, they do not log), which is
 * also what the shadow-week review reads: every episode carries `shadow`,
 * `trigger`, `status` and the reply, so "what would have fired, how late, and
 * how many rise candidates a pump bolus later confirmed" is one GET.
 */
async function handleGET(req: Request) {
  const auth = await requireIdentity(req);
  if (!("sub" in auth)) return auth;

  const raw = new URL(req.url).searchParams.get("hours");
  const parsed = raw === null ? DEFAULT_HOURS : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return NextResponse.json({ error: "hours must be a positive number" }, { status: 400 });
  }
  const hours = Math.min(parsed, MAX_HOURS);

  const now = Date.now();
  const episodes = await listEpisodes(now - hours * 60 * 60 * 1000, now);
  return NextResponse.json({ episodes });
}

export const GET = withMealRoute(handleGET, false);
