"use client";

import { useState, useEffect } from "react";
import type { GlucoseStats } from "@/lib/types";

interface OvernightData {
  stats: GlucoseStats;
  minGlucose: number;
  maxGlucose: number;
  lowEvents: number; // readings < 70
  highEvents: number; // readings > 250
  hours: number;
}

export function OvernightSummary() {
  const [data, setData] = useState<OvernightData | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Only show between 6-10 AM
  const hour = new Date().getHours();
  const shouldShow = hour >= 6 && hour <= 10;

  useEffect(() => {
    if (!shouldShow || dismissed) return;

    // Fetch overnight stats (10 PM yesterday to 6 AM today)
    fetch("/api/glucose/stats?hours=10")
      .then((r) => r.json())
      .then((stats) => {
        // Also fetch the raw readings to compute overnight-specific metrics
        return fetch("/api/glucose/range?hours=10").then((r) => r.json()).then((readings) => {
          // Filter to overnight hours only (10 PM - 6 AM)
          const overnight = readings.filter((r: { date: number }) => {
            const h = new Date(r.date).getHours();
            return h >= 22 || h < 6;
          });
          if (overnight.length < 12) return; // not enough data

          const values = overnight.map((r: { sgv: number }) => r.sgv);
          const mean = Math.round(values.reduce((s: number, v: number) => s + v, 0) / values.length);
          const inRange = values.filter((v: number) => v >= 70 && v <= 180).length;
          const tir = Math.round((inRange / values.length) * 100);

          setData({
            stats: { ...stats, mean, timeInRange: { ...stats.timeInRange, inRange: tir } },
            minGlucose: Math.min(...values),
            maxGlucose: Math.max(...values),
            lowEvents: values.filter((v: number) => v < 70).length,
            highEvents: values.filter((v: number) => v > 250).length,
            hours: Math.round((overnight[0].date - overnight[overnight.length - 1].date) / 3_600_000),
          });
        });
      })
      .catch(() => {});
  }, [shouldShow, dismissed]);

  if (!shouldShow || dismissed || !data) return null;

  const isGoodNight = data.stats.timeInRange.inRange >= 70 && data.lowEvents === 0;
  const isBadNight = data.stats.timeInRange.inRange < 50 || data.lowEvents > 5;

  return (
    <div className={`rounded-2xl border p-4 ${
      isGoodNight
        ? "bg-emerald-500/5 border-emerald-500/15"
        : isBadNight
          ? "bg-red-500/5 border-red-500/15"
          : "bg-[var(--bg-surface)] border-[var(--border)]"
    }`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-sm font-medium mb-1">
            {isGoodNight ? "Good night" : isBadNight ? "Rough night" : "Overnight Summary"}
          </div>
          <div className="text-xs text-[var(--text-secondary)]">
            {data.stats.timeInRange.inRange}% in range · avg {data.stats.mean} mg/dL · {data.minGlucose}–{data.maxGlucose} range
            {data.lowEvents > 0 && ` · ${data.lowEvents} low readings`}
            {data.highEvents > 0 && ` · ${data.highEvents} high readings`}
          </div>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="text-[var(--text-secondary)] hover:text-[var(--foreground)] text-xs p-1"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
