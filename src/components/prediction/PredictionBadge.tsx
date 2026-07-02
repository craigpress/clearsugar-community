"use client";

import type { PredictionResult } from "@/lib/prediction/types";
import { glucoseColorClass } from "@/lib/statistics";

interface PredictionBadgeProps {
  prediction: PredictionResult | null;
}

export function PredictionBadge({ prediction }: PredictionBadgeProps) {
  if (!prediction || prediction.points.length === 0) return null;

  // Show the final predicted value
  const finalPoint = prediction.points[prediction.points.length - 1];
  const minutesOut = Math.round(
    (finalPoint.timestamp - prediction.generatedAt) / 60_000
  );
  const colorClass = glucoseColorClass(finalPoint.sgv);

  // Urgent alert takes priority in display
  const urgentAlert = prediction.alerts.find((a) => a.severity === "urgent");
  const warningAlert = prediction.alerts.find((a) => a.severity === "warning");
  const alert = urgentAlert || warningAlert;

  return (
    <div className="flex flex-col items-center gap-0.5">
      {/* Predicted value */}
      <div className="flex items-center gap-1.5 text-sm">
        <span className="text-[var(--text-tertiary)]">→</span>
        <span className={`font-medium tabular-nums ${colorClass}`}>
          {finalPoint.sgv}
        </span>
        <span className="text-[var(--text-tertiary)]">
          in {minutesOut}m
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
          prediction.model === "ensemble"
            ? "bg-purple-500/20 text-purple-400"
            : prediction.model === "ml" || prediction.model === "ml-server" as string
              ? "bg-blue-500/20 text-blue-400"
              : "bg-zinc-500/20 text-zinc-400"
        }`}>
          {prediction.model === "ensemble"
            ? "ENS"
            : prediction.model === "ml" || prediction.model === ("ml-server" as string)
              ? "ML"
              : "PHY"}
        </span>
      </div>

      {/* Alert line */}
      {alert && (
        <div
          className={`text-xs font-medium ${
            alert.severity === "urgent"
              ? "text-red-400 animate-pulse"
              : "text-amber-400"
          }`}
        >
          Predicted {alert.type === "low" ? "low" : "high"} (
          {alert.predictedSgv}) in {alert.minutesUntil}m
        </div>
      )}

      {/* IOB / COB context */}
      <div className="flex gap-3 text-[10px] text-[var(--text-tertiary)] opacity-70">
        {prediction.iob > 0 && <span>IOB {prediction.iob}u</span>}
        {prediction.cob > 0 && <span>COB {prediction.cob}g</span>}
      </div>
    </div>
  );
}
