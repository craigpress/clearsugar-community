import { withMealRoute } from "@/lib/meals/profile-route";
import { NextResponse } from "next/server";
import { isLocalMeal, saveJSON } from "@/lib/meals/profile-storage";
import { loadPhoto } from "@/lib/meals/photos";
import { postTreatment } from "@/lib/nightscout";
import { requireIdentity } from "@/lib/patient-auth";
import { appendMeal, reserveMeal, findMealByClientId, listMeals } from "@/lib/meals/store";
import {
  NightscoutMirrorError,
  logUncoveredCarbs,
  validateMealInput,
  type LogUncoveredDeps,
} from "@/lib/meals/log-uncovered";

export const dynamic = "force-dynamic";

/** Default read window for GET, and the widest one accepted. */
const DEFAULT_HOURS = 24;
const MAX_HOURS = 24 * 30;

const deps: LogUncoveredDeps = {
  postTreatment: async doc => {
    if (!isLocalMeal()) return postTreatment(doc);
    await saveJSON(`treatments/${doc._id}.json`, doc);
    return { _id: doc._id! };
  },
  store: {
    findMealByClientId: (clientId) => findMealByClientId(clientId),
    appendMeal,
    reserveMeal,
  },
  now: () => Date.now(),
  uuid: () => crypto.randomUUID(),
};

/**
 * POST /api/meals — log carbs eaten without a bolus (feature A).
 *
 * Body: { clientId, grams, carbClass: "rescue"|"snack",
 *         reason: "low"|"forgot_bolus"|"other", eatenAt?, description? }
 *
 * 201 { meal } created · 200 { meal } idempotent replay of a known clientId
 * 400 validation · 401 unauthenticated · 403 unauthorized role
 * 502 Nightscout write failed (no MealLog kept, so a retry is safe)
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

  const parsed = validateMealInput(body, Date.now());
  if (!parsed.ok) {
    return NextResponse.json(
      { error: "Validation failed", errors: parsed.errors },
      { status: 400 }
    );
  }

  if (parsed.value.photoId && !(await loadPhoto(parsed.value.photoId))) {
    return NextResponse.json({ error: "Photo not found for the selected child" }, { status: 400 });
  }

  try {
    const { meal, replayed } = await logUncoveredCarbs(parsed.value, auth.sub, deps);
    return NextResponse.json({ meal }, { status: replayed ? 200 : 201 });
  } catch (err) {
    if (err instanceof NightscoutMirrorError) {
      console.error("[meals] Nightscout mirror failed:", err.message);
      return NextResponse.json(
        { error: "Failed to write the carbs to Nightscout" },
        { status: 502 }
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[meals] POST failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/meals?hours=N — read the logs back, newest first.
 *
 * 200 { meals: MealLog[] } · 400 bad hours · 401 unauthenticated
 * 403 machine key (no person behind the request)
 *
 * Reads use the selected child's store. `hours` defaults to 24 and is capped
 * at 720 so a bad query cannot scan every shard on disk.
 */
async function handleGET(req: Request) {
  const auth = await requireIdentity(req);
  if (!("sub" in auth)) return auth;

  const raw = new URL(req.url).searchParams.get("hours");
  let hours = DEFAULT_HOURS;
  if (raw !== null) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json({ error: "hours must be a positive number" }, { status: 400 });
    }
    hours = Math.min(n, MAX_HOURS);
  }

  const now = Date.now();
  const meals = await listMeals(now - hours * 60 * 60 * 1000, now);
  return NextResponse.json({ meals });
}

export const POST = withMealRoute(handlePOST, true);

export const GET = withMealRoute(handleGET, false);
