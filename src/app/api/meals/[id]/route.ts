import { withMealRoute } from "@/lib/meals/profile-route";
import { NextResponse } from "next/server";
import { isLocalMeal, deleteJSON } from "@/lib/meals/profile-storage";
import { deleteTreatment } from "@/lib/nightscout";
import { requireIdentity } from "@/lib/patient-auth";
import { findMealById, removeMeal } from "@/lib/meals/store";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/meals/[id] — undo a logged meal.
 *
 * 200 {} · 401 unauthenticated · 403 not the patient · 404 unknown id
 * 502 the Nightscout treatment could not be deleted
 *
 * Nightscout goes first: if that delete fails the MealLog row survives, so the
 * carbs and the row stay consistent and a retry can finish the job. The other
 * order would orphan a carb-bearing treatment with nothing left pointing at it.
 */
async function handleDELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireIdentity(req);
  if (!("sub" in auth)) return auth;

  const { id } = await params;
  const meal = await findMealById(id);
  if (!meal) {
    return NextResponse.json({ error: "Meal not found" }, { status: 404 });
  }

  if (meal.nightscoutId) {
    try {
      if (isLocalMeal()) await deleteJSON(`treatments/${meal.nightscoutId}.json`);
      else await deleteTreatment(meal.nightscoutId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[meals] Nightscout delete failed:", message);
      return NextResponse.json(
        { error: "Failed to delete the Nightscout treatment" },
        { status: 502 }
      );
    }
  }

  await removeMeal(meal.id);
  return NextResponse.json({});
}

export const DELETE = withMealRoute(handleDELETE, true);
