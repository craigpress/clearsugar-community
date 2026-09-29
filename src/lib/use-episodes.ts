"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { NutritionEstimate } from "@/lib/use-meals";

export type EatTiming =
  | "before_bolus"
  | "with_bolus"
  | "5"
  | "15"
  | "30"
  | "60plus"
  | "unknown";

export type EpisodeTrigger = "pump_bolus" | "glucose_rise" | "eating_now";
export type EpisodeStatus =
  | "open"
  | "prompted"
  | "answered"
  | "reconciled"
  | "expired"
  | "closed";
export type ReplyKind = "chip" | "text" | "photo" | "dismiss";

export interface EpisodeReply {
  kind: ReplyKind;
  ateSomething?: boolean;
  bolused?: boolean;
  eatTiming?: EatTiming;
  text?: string;
  photoId?: string;
  nutrition?: NutritionEstimate;
}

/**
 * Local mirror of the server's MealEpisode shape
 * (docs/MEAL_LOGGING_PLAN_2026-09-04.md section 4c). Kept independent of
 * src/lib/meals/** so this file has no build dependency on the server
 * agent's timing — only the fields the UI actually needs are declared here.
 */
export interface MealEpisode {
  id: string;
  openedAt: number;
  expiresAt: number;
  trigger: EpisodeTrigger;
  status: EpisodeStatus;
  bolusAt?: number;
  bolusInsulin?: number;
  bolusCarbs?: number;
  riseDetectedAt?: number;
  eatingAt?: number;
  promptedAt?: number;
  answeredAt?: number;
  reply?: EpisodeReply;
  minutesBolusToEat?: number;
  shadow: boolean;
}

export interface ReplyInput {
  episodeId: string;
  kind: ReplyKind;
  ateSomething?: boolean;
  bolused?: boolean;
  eatTiming?: EatTiming;
  text?: string;
  photoId?: string;
  nutrition?: NutritionEstimate;
}

export type ReplyResult =
  | { ok: true; episode: MealEpisode }
  | { ok: false; status: number; error: string; notPatient?: boolean };

export type EatingNowResult =
  | { ok: true; episode: MealEpisode }
  | { ok: false; status: number; error: string; notPatient?: boolean };

const POLL_INTERVAL_MS = 60_000;

interface UseEpisodesReturn {
  episodes: MealEpisode[];
  loading: boolean;
  error: string | null;
  notPatient: boolean;
  refresh: () => Promise<void>;
  reply: (input: ReplyInput) => Promise<ReplyResult>;
  eatingNow: () => Promise<EatingNowResult>;
}

export function useEpisodes(hours: number = 24, childId = "patient"): UseEpisodesReturn {
  const [episodes, setEpisodes] = useState<MealEpisode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notPatient, setNotPatient] = useState(true);
  const activeChild = useRef(childId);
  activeChild.current = childId;

  const fetchEpisodes = useCallback(async () => {
    if (!childId) return;
    try {
      const res = await fetch(`/api/meals/episodes?hours=${hours}&childId=${childId}`, {
        credentials: "same-origin",
      });
      if (res.status === 403) {
        setNotPatient(true);
        setError(null);
        return;
      }
      if (!res.ok) {
        setError(`Episode fetch failed: ${res.status}`);
        return;
      }
      const data: { episodes: MealEpisode[] } = await res.json();
      if (activeChild.current !== childId) return;
      setEpisodes(data.episodes);
      const access = await fetch("/api/meals/access", { credentials: "same-origin", cache: "no-store" });
      setNotPatient(!access.ok || (await access.json()).canLogMeals !== true);
      setError(null);
    } catch (err) {
      setNotPatient(true);
      setError(err instanceof Error ? err.message : "Episode fetch error");
    } finally {
      setLoading(false);
    }
  }, [hours, childId]);

  useEffect(() => {
    setEpisodes([]);
    fetchEpisodes();
    const interval = setInterval(fetchEpisodes, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchEpisodes]);

  const pendingClientIdRef = useRef<string | null>(null);

  const reply = useCallback(
    async (input: ReplyInput): Promise<ReplyResult> => {
      try {
        const res = await fetch("/api/meals/reply", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-Meal-Child": childId },
          body: JSON.stringify(input),
        });
        if (res.status === 403) {
          setNotPatient(true);
          return { ok: false, status: 403, error: "Not the patient", notPatient: true };
        }
        if (!res.ok) {
          let message = `Reply failed: ${res.status}`;
          try {
            const body = await res.json();
            message = body.error ?? message;
          } catch {
            // ignore parse failure, keep default message
          }
          return { ok: false, status: res.status, error: message };
        }
        const data: { episode: MealEpisode } = await res.json();
        await fetchEpisodes();
        return { ok: true, episode: data.episode };
      } catch (err) {
        return {
          ok: false,
          status: 0,
          error: err instanceof Error ? err.message : "Reply failed",
        };
      }
    },
    [fetchEpisodes]
  );

  const eatingNow = useCallback(async (): Promise<EatingNowResult> => {
    // Guard against a double-click minting two clientIds before the first
    // request lands — same pattern as useMeals().logMeal.
    if (pendingClientIdRef.current) {
      return { ok: false, status: 0, error: "Already in progress" };
    }
    const clientId = crypto.randomUUID();
    pendingClientIdRef.current = clientId;
    try {
      const res = await fetch("/api/meals/eating", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Meal-Child": childId },
        body: JSON.stringify({ clientId }),
      });
      if (res.status === 403) {
        setNotPatient(true);
        return { ok: false, status: 403, error: "Not the patient", notPatient: true };
      }
      if (!res.ok) {
        return { ok: false, status: res.status, error: `Eating-now failed: ${res.status}` };
      }
      const data: { episode: MealEpisode } = await res.json();
      await fetchEpisodes();
      return { ok: true, episode: data.episode };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : "Eating-now failed",
      };
    } finally {
      pendingClientIdRef.current = null;
    }
  }, [fetchEpisodes]);

  return {
    episodes,
    loading,
    error,
    notPatient,
    refresh: fetchEpisodes,
    reply,
    eatingNow,
  };
}
