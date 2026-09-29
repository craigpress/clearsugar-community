"use client";

import { useState, useEffect, useCallback, useRef } from "react";

export type MealCarbClass = "rescue" | "snack" | "meal";
export type MealReason = "low" | "forgot_bolus" | "other";
export type GiClass = "low" | "medium" | "high";

/**
 * Local mirror of the server's NutritionEstimate shape
 * (src/lib/meals/types.ts, plan section 3/4c). Independent of that file so
 * this component tree has no build dependency on the server agent's timing.
 */
export interface NutritionEstimate {
  carbs: { low: number; mid: number; high: number };
  protein?: number;
  fat?: number;
  fiber?: number;
  giClass?: GiClass;
  confidence: number; // 0..1
  items?: { name: string; portion: string; carbs: number }[];
  model: string;
  provider?: string;
  estimatedAt?: number;
  rawResponse?: string;
  notes?: string;
}

/**
 * Local mirror of the server's MealLog shape (src/lib/meals/types.ts).
 * Kept independent so this file has no build dependency on that agent's
 * timing — only the fields the UI actually needs are declared here.
 */
export interface MealLog {
  childId?: string;
  isTest?: boolean;
  id: string;
  eatenAt: number; // epoch ms
  grams: number;
  carbClass: MealCarbClass;
  reason: MealReason;
  description?: string;
  nightscoutId?: string;
  createdAt: number; // epoch ms
  photoId?: string;
  nutrition?: NutritionEstimate;
  source?: "pump_bolus" | "user_logged" | "photo_estimated";
}

export interface LogMealInput {
  grams: number;
  carbClass: MealCarbClass;
  reason: MealReason;
  eatenAt?: string; // ISO
  description?: string;
  photoId?: string;
  nutrition?: NutritionEstimate;
}

export type UploadPhotoResult =
  | { ok: true; photoId: string; bytes: number }
  | { ok: false; status: number; error: string; notPatient?: boolean };

export interface EstimateInput {
  followUp?: string;
  previousEstimate?: NutritionEstimate;
  photoId?: string;
  description?: string;
}

export type EstimateResult =
  | { ok: true; estimate: NutritionEstimate }
  | { ok: false; status: number; error: string; raw?: string; notPatient?: boolean };

/** Longest edge (px) an uploaded photo is downscaled to before it's sent. */
const PHOTO_MAX_EDGE = 1024;
const PHOTO_JPEG_QUALITY = 0.85;

/**
 * Downscale an image file to at most `PHOTO_MAX_EDGE` px on its long edge and
 * re-encode as JPEG via a canvas. Re-encoding through canvas drops EXIF (the
 * server strips any that survives anyway — plan section 4c).
 */
async function downscaleToJpegBase64(
  file: File
): Promise<{ base64: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(
    1,
    PHOTO_MAX_EDGE / Math.max(bitmap.width, bitmap.height)
  );
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const dataUrl = canvas.toDataURL("image/jpeg", PHOTO_JPEG_QUALITY);
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { base64 };
}

export type LogMealResult =
  | { ok: true; meal: MealLog }
  | { ok: false; status: number; error: string; notPatient?: boolean };

export interface MealChild { id: string; name: string; isTest: boolean; localOnly?: boolean }

interface UseMealsReturn {
  children: MealChild[];
  childId: string;
  selectChild: (id: string) => void;
  meals: MealLog[];
  loading: boolean;
  error: string | null;
  notPatient: boolean;
  refresh: () => Promise<void>;
  logMeal: (input: LogMealInput) => Promise<LogMealResult>;
  deleteMeal: (id: string) => Promise<boolean>;
  pendingClientId: string | null;
  uploadPhoto: (file: File) => Promise<UploadPhotoResult>;
  estimate: (input: EstimateInput) => Promise<EstimateResult>;
}

export function useMeals(hours: number = 24): UseMealsReturn {
  const [children, setChildren] = useState<MealChild[]>([]);
  const [childId, setChildId] = useState("");
  const activeChild = useRef("");
  activeChild.current = childId;
  const [meals, setMeals] = useState<MealLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notPatient, setNotPatient] = useState(true);
  // The in-flight clientId, kept in state so a double-click on Save can't
  // mint (and send) a second one while the first request is outstanding.
  const [pendingClientId, setPendingClientId] = useState<string | null>(null);

  const fetchMeals = useCallback(async () => {
    try {
      const access = await fetch("/api/meals/access", { credentials: "same-origin", cache: "no-store" });
      if (!access.ok) { setNotPatient(true); return; }
      const permission = await access.json();
      setChildren(permission.children ?? []);
      setNotPatient(permission.canLogMeals !== true);
      if (!childId) { setChildId(permission.defaultChildId ?? ""); return; }
      const res = await fetch(`/api/meals?hours=${hours}&childId=${childId}`, {
        credentials: "same-origin",
      });
      if (res.status === 403) {
        setNotPatient(true);
        setError(null);
        return;
      }
      if (!res.ok) {
        setError(`Meal fetch failed: ${res.status}`);
        return;
      }
      const data: { meals: MealLog[] } = await res.json();
      if (activeChild.current !== childId) return;
      setMeals(data.meals);
      setError(null);
    } catch (err) {
      setNotPatient(true);
      setError(err instanceof Error ? err.message : "Meal fetch error");
    } finally {
      setLoading(false);
    }
  }, [hours, childId]);

  useEffect(() => {
    fetchMeals();
    const interval = setInterval(fetchMeals, 180_000); // 3 min, mirrors useTreatments
    return () => clearInterval(interval);
  }, [fetchMeals]);

  const pendingRef = useRef<string | null>(null);
  const retryRef = useRef<{ signature: string; clientId: string } | null>(null);

  const logMeal = useCallback(
    async (input: LogMealInput): Promise<LogMealResult> => {
      // Guard against a double-click starting a second request before the
      // first one's clientId lands in state.
      if (pendingRef.current) {
        return { ok: false, status: 0, error: "A save is already in progress" };
      }
      const signature = JSON.stringify({ ...input, childId });
      const clientId = retryRef.current?.signature === signature ? retryRef.current.clientId : crypto.randomUUID();
      retryRef.current = { signature, clientId };
      pendingRef.current = clientId;
      setPendingClientId(clientId);
      try {
        const res = await fetch("/api/meals", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-Meal-Child": childId },
          body: JSON.stringify({ clientId, ...input }),
        });
        if (res.status === 403) {
          setNotPatient(true);
          return { ok: false, status: 403, error: "Not the patient", notPatient: true };
        }
        if (!res.ok) {
          let message = `Save failed: ${res.status}`;
          try {
            const body = await res.json();
            message = body.error ?? (body.errors ? JSON.stringify(body.errors) : message);
          } catch {
            // ignore parse failure, keep default message
          }
          return { ok: false, status: res.status, error: message };
        }
        const data: { meal: MealLog } = await res.json();
        retryRef.current = null;
        await fetchMeals();
        return { ok: true, meal: data.meal };
      } catch (err) {
        return {
          ok: false,
          status: 0,
          error: err instanceof Error ? err.message : "Save failed",
        };
      } finally {
        pendingRef.current = null;
        setPendingClientId(null);
      }
    },
    [fetchMeals]
  );

  const uploadPhoto = useCallback(
    async (file: File): Promise<UploadPhotoResult> => {
      try {
        const { base64 } = await downscaleToJpegBase64(file);
        const clientId = crypto.randomUUID();
        const res = await fetch("/api/meals/photo", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-Meal-Child": childId },
          body: JSON.stringify({ clientId, imageBase64: base64 }),
        });
        if (res.status === 403) {
          setNotPatient(true);
          return { ok: false, status: 403, error: "Not the patient", notPatient: true };
        }
        if (!res.ok) {
          let message = res.status === 413 ? "Photo too large" : `Upload failed: ${res.status}`;
          try {
            const body = await res.json();
            message = body.error ?? message;
          } catch {
            // ignore parse failure, keep default message
          }
          return { ok: false, status: res.status, error: message };
        }
        const data: { photoId: string; bytes: number } = await res.json();
        return { ok: true, photoId: data.photoId, bytes: data.bytes };
      } catch (err) {
        return {
          ok: false,
          status: 0,
          error: err instanceof Error ? err.message : "Upload failed",
        };
      }
    },
    [childId]
  );

  const estimate = useCallback(
    async (input: EstimateInput): Promise<EstimateResult> => {
      try {
        const res = await fetch("/api/meals/estimate", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-Meal-Child": childId },
          body: JSON.stringify(input),
        });
        if (res.status === 403) {
          setNotPatient(true);
          return { ok: false, status: 403, error: "Not the patient", notPatient: true };
        }
        if (res.status === 422) {
          const body = await res.json().catch(() => ({}));
          return {
            ok: false,
            status: 422,
            error:
              body.error ??
              "The model couldn't read that — try another angle or describe it.",
            raw: body.raw,
          };
        }
        if (res.status === 502) {
          return {
            ok: false,
            status: 502,
            error: "The nutrition estimator is unavailable. You can enter carbohydrates manually.",
          };
        }
        if (!res.ok) {
          const detail = await res.json().catch(() => null);
          return { ok: false, status: res.status, error: detail?.error ?? `Estimate failed: ${res.status}` };
        }
        const data: { estimate: NutritionEstimate } = await res.json();
        return { ok: true, estimate: data.estimate };
      } catch (err) {
        return {
          ok: false,
          status: 0,
          error: err instanceof Error ? err.message : "Estimate failed",
        };
      }
    },
    [childId]
  );

  const deleteMeal = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const res = await fetch(`/api/meals/${id}?childId=${childId}`, {
          method: "DELETE",
          credentials: "same-origin",
        });
        if (!res.ok) return false;
        await fetchMeals();
        return true;
      } catch {
        return false;
      }
    },
    [fetchMeals]
  );

  return {
    children, childId, selectChild: id => { setMeals([]); setChildId(id); },
    meals,
    loading,
    error,
    notPatient,
    refresh: fetchMeals,
    logMeal,
    deleteMeal,
    pendingClientId,
    uploadPhoto,
    estimate,
  };
}
