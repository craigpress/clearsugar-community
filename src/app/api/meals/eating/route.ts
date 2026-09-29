import { withMealRoute } from "@/lib/meals/profile-route";
import { NextResponse } from "next/server";
import { requireIdentity } from "@/lib/patient-auth";
import {
  EPISODE_TTL_MIN,
  appendEpisode,
  findEpisodeByClientId,
  findOpenEpisodeNear,
  newEpisode,
  updateEpisode,
} from "@/lib/meals/episodes";
import { isMealPromptShadow } from "@/lib/meals/detect";
import { measuredMinutesBolusToEat } from "@/lib/meals/pairing";
import type { MealEpisode } from "@/lib/meals/types";

export const dynamic = "force-dynamic";

const MIN = 60_000;
/** An "eating now" tap may be backdated 30 min and post-dated 5 (clock skew). */
const MAX_BACKDATE_MS = 30 * MIN;
const MAX_FUTURE_MS = 5 * MIN;
const MAX_CLIENT_ID_LEN = 64;

/**
 * POST /api/meals/eating — a one-tap "eating now" timestamp (section 4c).
 *
 * Body: { clientId, at?: ISO }
 * 201 { episode } opened · 200 { episode } replay of a known clientId, or an
 * existing episode this tap was folded into · 400 validation · 401 · 403
 *
 * This is the ONLY exact eat time the system ever gets (section 2.2: the
 * notification timestamp is meaningless because the pump path is ~50 min late),
 * so it is recorded even when it opens no prompt. If an episode already covers
 * the moment — a bolus the pump reported, or an earlier tap — the tap annotates
 * THAT episode instead of opening a second one for the same meal (risk 3), and
 * `minutesBolusToEat` becomes a measured value rather than a chip.
 */
async function handlePOST(req: Request) {
  const auth = await requireIdentity(req);
  if (!("sub" in auth)) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Validation failed", errors: ["body must be a JSON object"] },
      { status: 400 }
    );
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  let clientId = "";
  if (typeof b.clientId !== "string") errors.push("clientId must be a string");
  else {
    clientId = b.clientId.trim();
    if (!clientId) errors.push("clientId must not be empty");
    else if (clientId.length > MAX_CLIENT_ID_LEN) {
      errors.push(`clientId must be at most ${MAX_CLIENT_ID_LEN} characters`);
    }
  }

  const now = Date.now();
  let at = now;
  if (b.at !== undefined) {
    if (typeof b.at !== "string") errors.push("at must be an ISO date string");
    else {
      const parsed = Date.parse(b.at);
      if (!Number.isFinite(parsed)) errors.push("at must be an ISO date string");
      else if (parsed < now - MAX_BACKDATE_MS) {
        errors.push("at must be within the last 30 minutes");
      } else if (parsed > now + MAX_FUTURE_MS) {
        errors.push("at must not be more than 5 minutes in the future");
      } else at = parsed;
    }
  }

  if (errors.length > 0) {
    return NextResponse.json({ error: "Validation failed", errors }, { status: 400 });
  }

  const replay = await findEpisodeByClientId(clientId);
  if (replay) return NextResponse.json({ episode: replay });

  const existing = await findOpenEpisodeNear(at);
  if (existing) {
    const updated: MealEpisode = {
      ...existing,
      eatingAt: at,
      eatingAtSource: b.at == null ? "server_received" : "client_reported",
      eatingReportedAt: now,
      clientId: existing.clientId ?? clientId,
    };
    const measured = measuredMinutesBolusToEat(updated);
    if (measured !== null) {
      updated.minutesBolusToEat = measured;
      updated.delaySource = "reported_time_minus_pump_time";
    }
    const stored = await updateEpisode(updated);
    if (!stored) {
      return NextResponse.json({ error: "Could not store the tap" }, { status: 502 });
    }
    return NextResponse.json({ episode: stored });
  }

  const episode = newEpisode(
    {
      id: crypto.randomUUID(),
      trigger: "eating_now",
      shadow: isMealPromptShadow(process.env),
      eatingAt: at,
      eatingAtSource: b.at == null ? "server_received" : "client_reported",
      eatingReportedAt: now,
      clientId,
    },
    now
  );
  // The TTL runs from the eat time, not from the request: a backdated tap must
  // not extend the window a late pump bolus can reconcile into.
  episode.expiresAt = at + EPISODE_TTL_MIN * MIN;
  await appendEpisode(episode);
  return NextResponse.json({ episode }, { status: 201 });
}

export const POST = withMealRoute(handlePOST, true);
