"use client";

import { useState } from "react";
import type {
  EstimateInput,
  EstimateResult,
  LogMealInput,
  LogMealResult,
  MealCarbClass,
  MealReason,
  NutritionEstimate,
  UploadPhotoResult,
} from "@/lib/use-meals";
import { PhotoEstimateField } from "@/components/meals/PhotoEstimateField";

const GRAM_CHIPS = [15, 20, 30] as const;
const MIN_GRAMS = 1;
const MAX_GRAMS = 150;
const MAX_DESCRIPTION = 280;
const BACKDATE_LIMIT_MS = 24 * 60 * 60 * 1000;
const FUTURE_SLACK_MS = 5 * 60 * 1000;

const REASON_LABELS: Record<MealReason, string> = {
  low: "Low",
  forgot_bolus: "Forgot bolus",
  other: "Other",
};

function defaultReasonFor(carbClass: MealCarbClass): MealReason {
  return carbClass === "rescue" ? "low" : "forgot_bolus";
}

/** Format a Date as a value a <input type="datetime-local"
              step={60}> will accept, in local time. */
function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

interface LogCarbsSheetProps {
  logMeal: (input: LogMealInput) => Promise<LogMealResult>;
  deleteMeal: (id: string) => Promise<boolean>;
  notPatient: boolean;
  uploadPhoto: (file: File) => Promise<UploadPhotoResult>;
  estimate: (input: EstimateInput) => Promise<EstimateResult>;
}

export function LogCarbsSheet({
  logMeal,
  deleteMeal,
  notPatient,
  uploadPhoto,
  estimate,
}: LogCarbsSheetProps) {
  const [open, setOpen] = useState(false);
  const [carbClass, setCarbClass] = useState<MealCarbClass>("rescue");
  const [gramsInput, setGramsInput] = useState<string>("15");
  const [reason, setReason] = useState<MealReason>("low");
  const [whenLocal, setWhenLocal] = useState<string>(() =>
    toDatetimeLocalValue(new Date())
  );
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [estimatePending, setEstimatePending] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    grams: number;
    id: string;
  } | null>(null);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [nutrition, setNutrition] = useState<NutritionEstimate | null>(null);
  // Bumped on every new estimate so PhotoEstimateField remounts and clears
  // its own photo/preview state after a save resets the form.
  const [photoFieldKey, setPhotoFieldKey] = useState(0);

  const resetForm = () => {
    setCarbClass("rescue");
    setGramsInput("15");
    setReason("low");
    setWhenLocal(toDatetimeLocalValue(new Date()));
    setDescription("");
    setValidationError(null);
    setPhotoId(null);
    setNutrition(null);
    setPhotoFieldKey((k) => k + 1);
  };

  const handleEstimated = (result: { photoId: string | null; nutrition: NutritionEstimate }) => {
    setPhotoId(result.photoId ?? null);
    setNutrition(result.nutrition);
    setGramsInput(String(Math.round(result.nutrition.carbs.mid)));
  };

  const handleClassChange = (next: MealCarbClass) => {
    setCarbClass(next);
    setReason(defaultReasonFor(next));
  };

  const validate = (): { grams: number; eatenAtDate: Date } | null => {
    const grams = Number(gramsInput);
    if (!gramsInput || Number.isNaN(grams)) {
      setValidationError("Enter a gram amount.");
      return null;
    }
    if (grams < MIN_GRAMS || grams > MAX_GRAMS) {
      setValidationError(`Grams must be between ${MIN_GRAMS} and ${MAX_GRAMS}.`);
      return null;
    }
    if (!whenLocal) {
      setValidationError("Enter when this was eaten.");
      return null;
    }
    const eatenAtDate = new Date(whenLocal);
    if (Number.isNaN(eatenAtDate.getTime())) {
      setValidationError("Invalid date/time.");
      return null;
    }
    const now = Date.now();
    if (eatenAtDate.getTime() > now + FUTURE_SLACK_MS) {
      setValidationError("Time can't be in the future.");
      return null;
    }
    if (eatenAtDate.getTime() < now - BACKDATE_LIMIT_MS) {
      setValidationError("Time can't be more than 24 hours ago.");
      return null;
    }
    if (description.length > MAX_DESCRIPTION) {
      setValidationError(`Note must be ${MAX_DESCRIPTION} characters or fewer.`);
      return null;
    }
    return { grams, eatenAtDate };
  };

  const handleSave = async () => {
    if (pending || estimatePending) return;
    setValidationError(null);
    const validated = validate();
    if (!validated) return;

    setPending(true);
    const result = await logMeal({
      grams: validated.grams,
      carbClass,
      reason,
      eatenAt: validated.eatenAtDate.toISOString(),
      description: description.trim() || undefined,
      photoId: photoId ?? undefined,
      nutrition: nutrition ?? undefined,
    });
    setPending(false);

    if (!result.ok) {
      if (result.notPatient) {
        // notPatient flag is surfaced by the parent's disabled state on
        // the next render; nothing more to show here.
        return;
      }
      setValidationError(result.error);
      return;
    }

    setConfirmation({ grams: result.meal.grams, id: result.meal.id });
    setOpen(false);
    resetForm();
    setTimeout(() => setConfirmation(null), 5000);
  };

  const handleUndo = async () => {
    if (!confirmation) return;
    await deleteMeal(confirmation.id);
    setConfirmation(null);
  };

  if (notPatient) {
    return (
      <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-4 text-sm text-[var(--text-secondary)]">
        Sign in with a patient or parent account to log meals.
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="log-carbs-panel"
        className="px-4 py-2 rounded-full text-sm font-medium bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
      >
        Log carbs
      </button>

      {confirmation && !open && (
        <div className="mt-2 flex items-center gap-2 text-sm text-emerald-400">
          <span>Logged {confirmation.grams} g</span>
          <button
            type="button"
            onClick={handleUndo}
            className="underline hover:text-emerald-300"
          >
            Undo
          </button>
        </div>
      )}

      {open && (
        <div
          id="log-carbs-panel"
          className="mt-2 w-full max-w-md rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-4 space-y-4 sm:absolute sm:z-30"
        >
          {/* Carb class */}
          <fieldset>
            <legend className="text-xs text-[var(--text-secondary)] uppercase tracking-wider mb-2">
              Type
            </legend>
            <div className="flex gap-1" role="radiogroup" aria-label="Carb type">
              {(
                [
                  ["meal", "Meal"],
                  ["snack", "Snack"],
                  ["rescue", "Quick sugar"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={carbClass === value}
                  onClick={() => handleClassChange(value)}
                  className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    carbClass === value
                      ? "bg-[var(--accent)] text-white"
                      : "text-[var(--text-secondary)] bg-[var(--bg-elevated)] hover:text-[var(--foreground)]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>

          {/* Grams */}
          <div>
            <label
              htmlFor="meal-grams"
              className="block text-xs text-[var(--text-secondary)] uppercase tracking-wider mb-2"
            >
              Grams
            </label>
            <div className="flex items-center gap-2">
              {GRAM_CHIPS.map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGramsInput(String(g))}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                    gramsInput === String(g)
                      ? "bg-[var(--accent)] text-white"
                      : "text-[var(--text-secondary)] bg-[var(--bg-elevated)] hover:text-[var(--foreground)]"
                  }`}
                >
                  {g} g
                </button>
              ))}
              <input
                id="meal-grams"
                type="number"
                inputMode="numeric"
                min={MIN_GRAMS}
                max={MAX_GRAMS}
                value={gramsInput}
                onChange={(e) => setGramsInput(e.target.value)}
                className="w-20 px-2 py-1.5 rounded-lg text-sm bg-[var(--bg-elevated)] border border-[var(--border)] text-[var(--foreground)]"
              />
            </div>
          </div>

          {/* Reason */}
          <fieldset>
            <legend className="text-xs text-[var(--text-secondary)] uppercase tracking-wider mb-2">
              Reason
            </legend>
            <div className="flex gap-1" role="radiogroup" aria-label="Reason">
              {(Object.keys(REASON_LABELS) as MealReason[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={reason === value}
                  onClick={() => setReason(value)}
                  className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    reason === value
                      ? "bg-[var(--accent)] text-white"
                      : "text-[var(--text-secondary)] bg-[var(--bg-elevated)] hover:text-[var(--foreground)]"
                  }`}
                >
                  {REASON_LABELS[value]}
                </button>
              ))}
            </div>
          </fieldset>

          {/* When */}
          <div>
            <label
              htmlFor="meal-when"
              className="block text-xs text-[var(--text-secondary)] uppercase tracking-wider mb-2"
            >
              When
            </label>
            <input
              id="meal-when"
              type="datetime-local"
              step={60}
              value={whenLocal}
              max={toDatetimeLocalValue(new Date())}
              onChange={(e) => setWhenLocal(e.target.value)}
              className="w-full px-2 py-1.5 rounded-lg text-sm bg-[var(--bg-elevated)] border border-[var(--border)] text-[var(--foreground)]"
            />
          </div>

          {/* Note */}
          <div>
            <label
              htmlFor="meal-description"
              className="block text-xs text-[var(--text-secondary)] uppercase tracking-wider mb-2"
            >
              Note
            </label>
            <input
              id="meal-description"
              type="text"
              placeholder="What was it? (optional)"
              maxLength={MAX_DESCRIPTION}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-2 py-1.5 rounded-lg text-sm bg-[var(--bg-elevated)] border border-[var(--border)] text-[var(--foreground)]"
            />
          </div>

          {/* Photo */}
          <div>
            <div className="block text-xs text-[var(--text-secondary)] uppercase tracking-wider mb-2">
              Photo
            </div>
            <PhotoEstimateField
              key={photoFieldKey}
              uploadPhoto={uploadPhoto}
              estimate={estimate}
              description={description}
              onEstimated={handleEstimated}
              onPhotoChanged={id => { setPhotoId(id); setNutrition(null); }}
              onPendingChange={setEstimatePending}
            />
          </div>

          {validationError && (
            <div className="text-xs text-red-400" role="alert">
              {validationError}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                resetForm();
              }}
              className="px-3 py-1.5 rounded-full text-xs text-[var(--text-secondary)] hover:text-[var(--foreground)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={pending || estimatePending}
              className={`px-4 py-1.5 rounded-full text-xs font-medium transition-colors ${
                pending
                  ? "bg-[var(--accent)]/60 text-white cursor-wait"
                  : "bg-[var(--accent)] text-white hover:opacity-90"
              }`}
            >
              {pending ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
