"use client";

import type { MealLog, MealReason } from "@/lib/use-meals";
import { formatCarbRange } from "@/components/meals/PhotoEstimateField";

const UNDO_WINDOW_MS = 15 * 60 * 1000;

const REASON_LABELS: Record<MealReason, string> = {
  low: "Low",
  forgot_bolus: "Forgot bolus",
  other: "Other",
};

const SOURCE_LABELS: Record<NonNullable<MealLog["source"]>, string> = {
  pump_bolus: "Pump",
  user_logged: "Logged",
  photo_estimated: "Photo",
};

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

interface RecentMealsListProps {
  meals: MealLog[];
  loading: boolean;
  deleteMeal: (id: string) => Promise<boolean>;
}

export function RecentMealsList({
  meals,
  loading,
  deleteMeal,
}: RecentMealsListProps) {
  if (loading && meals.length === 0) {
    return null;
  }

  if (meals.length === 0) {
    return null;
  }

  // The undo window is evaluated when the list renders; the parent refreshes
  // every 3 min, which is fine for a 15-min window. Same pattern as the
  // "Updated Xm ago" line on the dashboard.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  return (
    <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-4">
      <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider mb-3">
        Logged carbs (24h)
      </div>
      <ul className="space-y-2">
        {meals.map((meal) => {
          const canUndo = now - meal.createdAt < UNDO_WINDOW_MS;
          return (
            <li
              key={meal.id}
              className="flex items-center justify-between gap-3 text-sm py-1.5 border-b border-[var(--border)] last:border-0"
            >
              <div className="flex items-center gap-2 min-w-0">
                {meal.photoId && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/meals/photo/${meal.photoId}?childId=${meal.childId ?? "patient"}`}
                    alt=""
                    className="w-8 h-8 rounded-lg object-cover border border-[var(--border)] shrink-0"
                  />
                )}
                <span className="text-[var(--text-secondary)] tabular-nums shrink-0">
                  {formatTime(meal.eatenAt)}
                </span>
                <span className="font-medium tabular-nums text-[var(--carb-amber)] shrink-0">
                  {meal.nutrition ? formatCarbRange(meal.nutrition) : `${meal.grams} g`}
                </span>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full border shrink-0 ${
                    meal.carbClass === "rescue"
                      ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                      : "bg-blue-500/10 text-blue-300 border-blue-500/20"
                  }`}
                >
                  {meal.carbClass === "rescue" ? "Quick sugar" : meal.carbClass === "meal" ? "Meal" : "Snack"}
                </span>
                <span className="text-xs text-[var(--text-secondary)] shrink-0">
                  {REASON_LABELS[meal.reason]}
                </span>
                {meal.source && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full border border-[var(--border)] text-[var(--text-tertiary)] shrink-0">
                    {SOURCE_LABELS[meal.source]}
                  </span>
                )}
                {meal.description && (
                  <span className="text-xs text-[var(--text-tertiary)] truncate">
                    {meal.description}
                  </span>
                )}
              </div>
              {canUndo && (
                <button
                  type="button"
                  onClick={() => deleteMeal(meal.id)}
                  aria-label={`Delete ${meal.grams} gram carb entry`}
                  className="text-xs text-[var(--text-secondary)] hover:text-red-400 shrink-0"
                >
                  Undo
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
