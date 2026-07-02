"use client";

import { useEffect } from "react";
import type { GlucoseReading } from "@/lib/types";
import { TREND_ARROWS, TREND_LABELS } from "@/lib/types";
import { glucoseColorClass, glucoseStatus, minutesAgo } from "@/lib/statistics";

interface MovieModeProps {
  reading: GlucoseReading | null;
  onExit: () => void;
}

export function MovieMode({ reading, onExit }: MovieModeProps) {
  // Exit on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onExit]);

  // Prevent scrolling while in movie mode
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  if (!reading) return null;

  const mins = minutesAgo(reading.date);
  const isStale = mins > 15;
  const colorClass = glucoseColorClass(reading.sgv);
  const arrow = TREND_ARROWS[reading.direction] || "—";
  const trendLabel = TREND_LABELS[reading.direction] || "Unknown";
  const status = glucoseStatus(reading.sgv);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center cursor-pointer select-none"
      style={{
        backgroundColor:
          reading.sgv < 54 ? "rgba(30, 0, 0, 1)" :
          reading.sgv < 70 ? "rgba(20, 10, 0, 1)" :
          reading.sgv <= 180 ? "rgba(0, 5, 0, 1)" :
          reading.sgv <= 250 ? "rgba(20, 10, 0, 1)" :
          "rgba(30, 0, 0, 1)",
      }}
      onClick={onExit}
    >
      {/* Tap to exit hint — fades after 3 seconds */}
      <div className="absolute top-6 right-6 text-white/20 text-xs animate-pulse">
        Tap or press Esc to exit
      </div>

      {/* The number — massive, dimmed */}
      <div className="flex items-baseline gap-4">
        <span
          className={`text-[12rem] sm:text-[16rem] md:text-[20rem] font-light tabular-nums leading-none tracking-tighter ${colorClass}`}
          style={{ opacity: isStale ? 0.2 : 0.6 }}
        >
          {reading.sgv}
        </span>
        <span
          className={`text-6xl sm:text-8xl ${colorClass}`}
          style={{ opacity: isStale ? 0.15 : 0.5 }}
        >
          {arrow}
        </span>
      </div>

      {/* Trend and time — very subtle */}
      <div
        className="flex items-center gap-3 mt-4 text-lg sm:text-xl"
        style={{ color: "rgba(255,255,255,0.2)" }}
      >
        <span>{trendLabel}</span>
        <span style={{ opacity: 0.3 }}>·</span>
        <span>{status}</span>
      </div>

      {/* Stale indicator */}
      {isStale && (
        <div className="mt-6 text-amber-500/40 text-sm">
          {mins} min ago — data may be stale
        </div>
      )}

      {/* Time in corner */}
      <div
        className="absolute bottom-6 left-6 text-sm tabular-nums font-[family-name:var(--font-geist-mono)]"
        style={{ color: "rgba(255,255,255,0.1)" }}
      >
        {new Date().toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })}
      </div>

      {/* ClearSugar watermark */}
      <div
        className="absolute bottom-6 right-6 text-xs"
        style={{ color: "rgba(255,255,255,0.06)" }}
      >
        ClearSugar
      </div>
    </div>
  );
}
