"use client";

import { useState, useEffect, useCallback } from "react";
import type { Treatment } from "./types";

interface UseTreatmentsReturn {
  boluses: Treatment[];
  carbs: Treatment[];
  basals: Treatment[];
  isLoading: boolean;
  error: string | null;
}

export function useTreatments(hours: number = 3): UseTreatmentsReturn {
  const [boluses, setBoluses] = useState<Treatment[]>([]);
  const [carbs, setCarbs] = useState<Treatment[]>([]);
  const [basals, setBasals] = useState<Treatment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTreatments = useCallback(async () => {
    try {
      const res = await fetch(`/api/treatments?hours=${hours}`);
      if (!res.ok) {
        setError(`Treatment fetch failed: ${res.status}`);
        return;
      }
      const data: Treatment[] = await res.json();

      setBoluses(
        data.filter(
          (t) => t.insulin !== null && t.insulin !== undefined && t.insulin > 0
        )
      );
      setCarbs(
        data.filter(
          (t) => t.carbs !== null && t.carbs !== undefined && t.carbs > 0
        )
      );
      setBasals(
        data.filter((t) => t.eventType === "Temp Basal")
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Treatment fetch error");
    } finally {
      setIsLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    fetchTreatments();
    const interval = setInterval(fetchTreatments, 180_000); // 3 min — treatments change infrequently
    return () => clearInterval(interval);
  }, [fetchTreatments]);

  return { boluses, carbs, basals, isLoading, error };
}
