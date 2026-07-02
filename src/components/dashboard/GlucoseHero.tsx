"use client";

import type { GlucoseReading } from "@/lib/types";
import { TREND_ARROWS, TREND_LABELS } from "@/lib/types";
import {
  glucoseColorClass,
  minutesAgo,
  formatMinutesAgo,
} from "@/lib/statistics";
import type { PredictionResult } from "@/lib/prediction/types";
import { PredictionBadge } from "@/components/prediction/PredictionBadge";

interface GlucoseHeroProps {
  reading: GlucoseReading | null;
  pumpIsStale: boolean;
  pumpStaleMinutes: number | null;
  prediction?: PredictionResult | null;
}

export function GlucoseHero({
  reading,
  pumpIsStale,
  pumpStaleMinutes,
  prediction,
}: GlucoseHeroProps) {
  if (!reading) {
    return (
      <div className="flex items-center justify-center h-32">
        <div className="text-[var(--text-secondary)] text-lg">
          Waiting for data...
        </div>
      </div>
    );
  }

  const mins = minutesAgo(reading.date);
  const isStale = mins > 15;
  const colorClass = glucoseColorClass(reading.sgv);
  const arrow = TREND_ARROWS[reading.direction] || "—";
  const trendLabel = TREND_LABELS[reading.direction] || "Unknown";

  return (
    <div className="flex flex-col items-center gap-1 py-4">
      {/* Current glucose — the hero number */}
      <div className="flex items-baseline gap-3">
        <span
          className={`text-7xl font-medium tabular-nums tracking-tight ${colorClass} ${isStale ? "opacity-50" : ""}`}
        >
          {reading.sgv}
        </span>
        <span className={`text-4xl ${colorClass}`}>{arrow}</span>
      </div>

      {/* Natural language status — answers "Is the patient okay?" at a glance */}
      <div className="text-sm text-center max-w-xs mx-auto mt-1 mb-0.5">
        <span className={`${reading.sgv < 70 ? "text-amber-400" : reading.sgv > 250 ? "text-red-400" : "text-[var(--text-secondary)]"}`}>
          {reading.sgv < 54
            ? `Urgent low — ${trendLabel.toLowerCase()}. Treat immediately.`
            : reading.sgv < 70
              ? `Low and ${trendLabel.toLowerCase()}. ${reading.direction === "SingleDown" || reading.direction === "DoubleDown" ? "Still dropping." : reading.direction === "Flat" || reading.direction === "FortyFiveUp" || reading.direction === "SingleUp" ? "Trending back up." : ""}`
              : reading.sgv <= 180
                ? `In range and ${trendLabel.toLowerCase()}. ${mins < 2 ? "Just updated." : formatMinutesAgo(mins) + "."}`
                : reading.sgv <= 250
                  ? `Running high — ${trendLabel.toLowerCase()}. ${reading.direction === "FortyFiveDown" || reading.direction === "SingleDown" ? "Coming down." : ""}`
                  : `Very high and ${trendLabel.toLowerCase()}. ${mins < 6 ? "" : formatMinutesAgo(mins) + "."}`
          }
        </span>
      </div>

      {/* Trend details — only what the status sentence doesn't already say
          (trend label and range status are always in the sentence) */}
      <div className="flex items-center gap-3 text-xs text-[var(--text-secondary)]">
        {reading.delta != null && (
          <>
            <span className="tabular-nums">
              {reading.delta >= 0 ? "+" : ""}
              {Math.round(reading.delta)} mg/dL
            </span>
            <span className="opacity-40">·</span>
          </>
        )}
        <span className={isStale ? "text-amber-400" : ""}>
          {formatMinutesAgo(mins)}
        </span>
      </div>

      {/* Prediction badge */}
      {prediction && <PredictionBadge prediction={prediction} />}

      {/* Pump connection warning */}
      {pumpIsStale && pumpStaleMinutes !== null && (
        <div className="mt-2 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-medium">
          ⚠ Pump data stale ({pumpStaleMinutes}m) — check t:connect app
        </div>
      )}

      {/* Stale CGM data warning */}
      {isStale && (
        <div className="mt-2 px-3 py-1.5 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-medium">
          ⚠ CGM data is {mins} minutes old
        </div>
      )}
    </div>
  );
}
