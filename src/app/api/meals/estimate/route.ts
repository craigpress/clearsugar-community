import { validateEstimate, attachProvenance } from "@/lib/meals/nutrition-validate";
import { withMealRoute } from "@/lib/meals/profile-route";
import { saveJSON, currentMealChild, isTestMeal } from "@/lib/meals/profile-storage";
import { NextResponse } from "next/server";
import { requireIdentity } from "@/lib/patient-auth";
import { loadPhoto, isValidPhotoId } from "@/lib/meals/photos";
import { MAX_DESCRIPTION_LEN } from "@/lib/meals/log-uncovered";
import {
  VisionOutputError,
  VisionUnavailableError,
  estimateNutrition,
} from "@/lib/insights/vision-client";

export const dynamic = "force-dynamic";

const MEAL_VISION_URL = process.env.MEAL_VISION_URL || "";
const MEAL_VISION_API_KEY = process.env.MEAL_VISION_API_KEY || "";
const MEAL_VISION_MODEL = process.env.MEAL_VISION_MODEL || "";

/**
 * POST /api/meals/estimate — photo (and/or text) -> NutritionEstimate.
 *
 * Body: { photoId?, description? } — at least one.
 *
 * 200 { estimate, latencyMs } · 400 neither field, or a bad one
 * 401 unauthenticated · 403 not the patient · 404 unknown photoId
 * 422 { error, raw } the model replied but not with a valid estimate
 * 500 the vision provider is not configured · 502 the model was unreachable
 *
 * Photo estimates retain a recoverable draft. Only a confirmed POST /api/meals
 * creates a carb log; estimation and revision never write carb treatments.
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
    return NextResponse.json({ error: "body must be a JSON object" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  if (b.followUp !== undefined && (typeof b.followUp !== "string" || b.followUp.length > 1000)) {
    return NextResponse.json({ error: "followUp must be text of at most 1000 characters" }, { status: 400 });
  }
  let previousEstimate;
  if (b.previousEstimate !== undefined) {
    const prior = validateEstimate(b.previousEstimate);
    if (!prior.ok) return NextResponse.json({ error: "Invalid previous estimate" }, { status: 400 });
    previousEstimate = attachProvenance(prior.value, b.previousEstimate, Date.now());
  }
  const hasPhoto = b.photoId !== undefined && b.photoId !== null;
  let description: string | undefined;
  if (b.description !== undefined && b.description !== null) {
    if (typeof b.description !== "string") {
      return NextResponse.json({ error: "description must be a string" }, { status: 400 });
    }
    const trimmed = b.description.trim();
    if (trimmed.length > MAX_DESCRIPTION_LEN) {
      return NextResponse.json(
        { error: `description must be at most ${MAX_DESCRIPTION_LEN} characters` },
        { status: 400 }
      );
    }
    if (trimmed.length > 0) description = trimmed;
  }

  if (!hasPhoto && description === undefined) {
    return NextResponse.json(
      { error: "photoId or description is required" },
      { status: 400 }
    );
  }

  let imageBase64: string | undefined;
  if (hasPhoto) {
    if (!isValidPhotoId(b.photoId)) {
      return NextResponse.json({ error: "photoId must be a UUID" }, { status: 400 });
    }
    const bytes = await loadPhoto(b.photoId);
    if (!bytes) {
      return NextResponse.json({ error: "Photo not found" }, { status: 404 });
    }
    imageBase64 = bytes.toString("base64");
  }

  if (!MEAL_VISION_URL || !MEAL_VISION_MODEL) {
    console.error(
      "[meals/estimate] vision provider not configured (MEAL_VISION_URL / MEAL_VISION_MODEL)"
    );
    return NextResponse.json(
      { error: "Nutrition estimates are not configured. You can attach a photo and enter carbohydrates manually." },
      { status: 503 }
    );
  }

  try {
    const { estimate, latencyMs } = await estimateNutrition({
      ...(imageBase64 !== undefined && { imageBase64 }),
      ...(description !== undefined && { description }),
      followUp: b.followUp as string | undefined,
      previousEstimate,
      model: MEAL_VISION_MODEL,
      baseUrl: MEAL_VISION_URL,
      apiKey: MEAL_VISION_API_KEY,
    });
    estimate.estimateId = crypto.randomUUID();
    const revision = { schemaVersion: 1, childId: currentMealChild(), isTest: isTestMeal(),
      estimate, description, photoId: b.photoId, previousEstimate, followUp: b.followUp,
      recordedAt: Date.now() };
    await saveJSON(`meal-estimate-revisions/${estimate.estimateId}.json`, revision);
    if (hasPhoto) await saveJSON(`meal-estimates/${b.photoId}.json`, revision);
    return NextResponse.json({ estimate, latencyMs });
  } catch (err) {
    if (err instanceof VisionOutputError) {
      console.error("[meals/estimate] unusable model output:", err.message);
      return NextResponse.json({ error: err.message, raw: err.raw }, { status: 422 });
    }
    if (err instanceof VisionUnavailableError) {
      console.error("[meals/estimate] vision model unreachable:", err.message);
      return NextResponse.json(
        { error: "The nutrition estimator is unreachable" },
        { status: 502 }
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[meals/estimate] POST failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const POST = withMealRoute(handlePOST, true);
