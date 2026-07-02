"use client";

import { useState, useEffect, useCallback } from "react";
import type { GlucoseReading, GlucoseStats } from "./types";

const POLL_INTERVAL = 120_000; // 2 minutes — Dexcom updates every 5 min, no need to poll faster

interface UseGlucoseReturn {
  readings: GlucoseReading[];
  latest: GlucoseReading | null;
  stats: GlucoseStats | null;
  pumpStaleMinutes: number | null;
  pumpIsStale: boolean;
  isLoading: boolean;
  error: string | null;
  lastFetch: Date | null;
}

export function useGlucose(hours: number = 3): UseGlucoseReturn {
  const [readings, setReadings] = useState<GlucoseReading[]>([]);
  const [latest, setLatest] = useState<GlucoseReading | null>(null);
  const [stats, setStats] = useState<GlucoseStats | null>(null);
  const [pumpStaleMinutes, setPumpStaleMinutes] = useState<number | null>(null);
  const [pumpIsStale, setPumpIsStale] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [rangeRes, latestRes, statsRes] = await Promise.all([
        fetch(`/api/glucose/range?hours=${hours}`),
        fetch("/api/glucose/latest"),
        fetch(`/api/glucose/stats?hours=${hours}`),
      ]);

      if (!rangeRes.ok || !latestRes.ok || !statsRes.ok) {
        throw new Error("Failed to fetch glucose data");
      }

      const [rangeData, latestData, statsData] = await Promise.all([
        rangeRes.json(),
        latestRes.json(),
        statsRes.json(),
      ]);

      setReadings(rangeData);
      setLatest(latestData);
      setStats(statsData);
      setPumpStaleMinutes(latestData.pumpStaleMinutes ?? null);
      setPumpIsStale(latestData.pumpIsStale ?? false);
      setError(null);
      setLastFetch(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection error");
    } finally {
      setIsLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchData]);

  return {
    readings,
    latest,
    stats,
    pumpStaleMinutes,
    pumpIsStale,
    isLoading,
    error,
    lastFetch,
  };
}
