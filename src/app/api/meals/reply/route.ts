import { withMealRoute } from "@/lib/meals/profile-route";
import { NextResponse } from "next/server";
import { requireIdentity } from "@/lib/patient-auth";
import {
  findEpisodeById,
  loadPromptState,
  savePromptState,
  updateEpisode,
} from "@/lib/meals/episodes";
import { applyReply, validateReplyInput } from "@/lib/meals/pairing";
import { validateEstimate } from "@/lib/meals/nutrition-validate";
import { loadPhoto } from "@/lib/meals/photos";

export const dynamic = "force-dynamic";

/**
 * POST /api/meals/reply — the patient's answer to a meal prompt (section 4c).
 *
 * Body: { episodeId, kind: "chip"|"text"|"photo"|"dismiss", ateSomething?,
 *         bolused?, eatTiming?, text?, photoId?, nutrition?, mealLogId? }
 * 200 { episode } · 400 validation · 401 unauthenticated · 403 unauthorized role
 * 404 unknown episode
 *
 * A reply NEVER writes carbs (risk 1). `ateSomething: false` closes the episode
 * and starts a 60-minute rise suppression (decision 3a); anything else marks it
 * answered and leaves it open until expiry so a pump bolus arriving in the next
 * tconnectsync batch can still reconcile into it.
 *
 * Patient/parent writes are authorized and scoped by withMealRoute.
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

  const parsed = validateReplyInput(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: "Validation failed", errors: parsed.errors },
      { status: 400 }
    );
  }

  // A photo/text reply may carry the confirmed estimate. pairing.ts only checks
  // its shape; clamp the numbers with the same validator the estimate route
  // uses so an out-of-range figure can never be stored on an episode.
  let value = parsed.value;
  if (value.photoId && !(await loadPhoto(value.photoId))) {
    return NextResponse.json({ error: "Photo not found in this profile" }, { status: 400 });
  }
  if (value.nutrition !== undefined) {
    const v = validateEstimate(value.nutrition);
    if (!v.ok) {
      return NextResponse.json(
        { error: "Validation failed", errors: v.errors },
        { status: 400 }
      );
    }
    value = { ...value, nutrition: { ...value.nutrition, ...v.value } };
  }

  const episode = await findEpisodeById(value.episodeId);
  if (!episode) {
    return NextResponse.json({ error: "Unknown episode" }, { status: 404 });
  }

  const now = Date.now();
  const applied = applyReply(episode, value, now);
  const stored = await updateEpisode(applied.episode);
  if (!stored) {
    // The episode was found a moment ago, so a failed update means the shard
    // changed underneath us; surface it rather than reporting success.
    return NextResponse.json({ error: "Could not store the reply" }, { status: 502 });
  }

  if (applied.riseSuppressedUntil !== undefined) {
    const state = await loadPromptState(now);
    // Never shorten an existing suppression.
    const until = Math.max(state.riseSuppressedUntil ?? 0, applied.riseSuppressedUntil);
    await savePromptState({ ...state, riseSuppressedUntil: until });
  }

  return NextResponse.json({ episode: stored });
}

export const POST = withMealRoute(handlePOST, true);
