"use client";

import { useState, useEffect, useMemo } from "react";
import { useGlucose } from "@/lib/use-glucose";
import { useTreatments } from "@/lib/use-treatments";
import { usePredictions } from "@/lib/prediction/hooks/use-predictions";
import { usePredictionSettings } from "@/lib/prediction/hooks/use-prediction-settings";
import { PredictionSettings } from "@/components/prediction/PredictionSettings";
import type { ModelMetadata } from "@/lib/prediction/types";
import { AppHeader } from "@/components/layout/AppHeader";
import { GlucoseHero } from "@/components/dashboard/GlucoseHero";
import { AdvisorStatusStrip } from "@/components/dashboard/AdvisorStatusStrip";
import { GlucoseChart } from "@/components/charts/GlucoseChart";
import { StatsGrid } from "@/components/dashboard/StatsGrid";
import { PumpStatusCard } from "@/components/dashboard/PumpStatusCard";
import { DataTable } from "@/components/dashboard/DataTable";
import { MovieMode } from "@/components/dashboard/MovieMode";
import { OvernightSummary } from "@/components/dashboard/OvernightSummary";
import { formatMinutesAgo } from "@/lib/statistics";

const TIME_RANGES = [
  { label: "3h", hours: 3 },
  { label: "6h", hours: 6 },
  { label: "12h", hours: 12 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
] as const;

export default function Dashboard() {
  const [selectedRange, setSelectedRange] = useState(() => {
    // Smart default: 12h between 6-10 AM (show overnight), else localStorage or 6h
    if (typeof window !== "undefined") {
      const hour = new Date().getHours();
      if (hour >= 6 && hour <= 10) return 3; // 24h to capture overnight
      const saved = localStorage.getItem("clearsugar-range");
      if (saved !== null) return parseInt(saved, 10);
    }
    return 1; // default to 6h (more context than 3h)
  });
  const [movieMode, setMovieMode] = useState(false);
  const [predSettingsOpen, setPredSettingsOpen] = useState(false);

  // Persist range selection
  const handleRangeChange = (idx: number) => {
    setSelectedRange(idx);
    if (typeof window !== "undefined") {
      localStorage.setItem("clearsugar-range", String(idx));
    }
  };
  const hours = TIME_RANGES[selectedRange].hours;
  const {
    readings,
    latest,
    stats,
    pumpIsStale,
    pumpStaleMinutes,
    isLoading,
    error,
    lastFetch,
  } = useGlucose(hours);
  const { boluses, carbs, basals } = useTreatments(hours);

  // Prediction system
  const {
    settings: predSettings,
    setHorizon,
    setModel,
    toggleChart,
    toggleHero,
  } = usePredictionSettings();
  const allTreatments = useMemo(() => {
    // Deduplicate — Combo Bolus entries have both insulin AND carbs,
    // so they appear in both boluses[] and carbs[] arrays
    const seen = new Set<string>();
    const result: typeof boluses = [];
    for (const t of [...boluses, ...carbs, ...basals]) {
      if (!seen.has(t._id)) {
        seen.add(t._id);
        result.push(t);
      }
    }
    return result;
  }, [boluses, carbs, basals]);
  const { prediction } = usePredictions(readings, allTreatments, predSettings);

  // ML model metadata
  const [modelMeta, setModelMeta] = useState<ModelMetadata | null>(null);
  useEffect(() => {
    fetch("/api/model/meta")
      .then((r) => (r.ok ? r.json() : null))
      .then(setModelMeta)
      .catch(() => {});
  }, []);

  // Predictive alerting is owned entirely by the server-side action-advisor
  // (/api/advisor/check → APNs) — the removed client-side Web Notifications path
  // used naive non-CIQ math, could surface ML-derived lows (violating the
  // ROC-only-for-lows invariant), and only fired with a browser tab open. The
  // on-hero PredictionBadge remains as a passive glance cue.

  const statusIndicator = (
    <>
      {error && (
        <span className="text-red-400 flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
          {error}
        </span>
      )}
      {!error && lastFetch && (
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          Live
        </span>
      )}
    </>
  );

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {movieMode && (
        <MovieMode reading={latest} onExit={() => setMovieMode(false)} />
      )}

      <AppHeader
        onBedsideClick={() => setMovieMode(true)}
        statusIndicator={statusIndicator}
      />

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {isLoading && (
          <div className="flex items-center justify-center h-64">
            <div className="text-[var(--text-secondary)]">
              Connecting to Nightscout...
            </div>
          </div>
        )}

        {error && !isLoading && (
          <div className="rounded-2xl bg-red-500/10 border border-red-500/20 p-6 text-center">
            <div className="text-red-400 text-lg font-medium mb-2">
              Cannot reach Nightscout
            </div>
            <div className="text-[var(--text-secondary)] text-sm">
              {error}
            </div>
          </div>
        )}

        {!isLoading && !error && (
          <>
            <GlucoseHero
              reading={latest}
              pumpIsStale={pumpIsStale}
              pumpStaleMinutes={pumpStaleMinutes}
              prediction={predSettings.showOnHero ? prediction : null}
            />

            <AdvisorStatusStrip />

            {/* Overnight summary — auto-shows 6-10 AM */}
            <OvernightSummary />

            {/* Chart section */}
            <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] overflow-hidden">
              <div className="p-3 pb-0 space-y-2">
                {/* Time range row */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    {TIME_RANGES.map((range, idx) => (
                      <button
                        key={range.label}
                        onClick={() => handleRangeChange(idx)}
                        className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                          idx === selectedRange
                            ? "bg-[var(--accent)] text-white"
                            : "text-[var(--text-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--bg-elevated)]"
                        }`}
                      >
                        {range.label}
                      </button>
                    ))}
                  </div>
                  <div className="hidden sm:flex items-center gap-3 text-[10px] text-[var(--text-secondary)]">
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-sm bg-[var(--insulin-blue)]" />
                      Bolus
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-[var(--carb-amber)]" />
                      Carbs
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-sm bg-[var(--insulin-blue)] opacity-30" />
                      Basal
                    </span>
                    {prediction && (
                      <span className="flex items-center gap-1">
                        <span className="w-3 h-0.5 rounded bg-[oklch(0.7_0.15_250)] opacity-80" style={{ borderTop: '1px dashed oklch(0.7 0.15 250)' }} />
                        Predicted
                      </span>
                    )}
                  </div>
                </div>
                {/* Prediction horizon row (separate line for mobile) */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    {/* Model toggle */}
                    {(["physiological", "ml", "ensemble"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => setModel(m)}
                        className={`px-2 py-1 rounded-full text-[10px] font-medium transition-colors ${
                          predSettings.activeModel === m
                            ? m === "ensemble" ? "bg-purple-500/30 text-purple-300" : m === "ml" ? "bg-blue-500/30 text-blue-300" : "bg-zinc-500/30 text-zinc-300"
                            : "text-[var(--text-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--bg-elevated)]"
                        }`}
                      >
                        {m === "physiological" ? "PHY" : m === "ml" ? "ML" : "ENS"}
                      </button>
                    ))}
                    <span className="text-[var(--border)] mx-0.5">|</span>
                    {([15, 30, 60, 180] as const).map((h) => (
                      <button
                        key={h}
                        onClick={() => setHorizon(h)}
                        className={`px-2 py-1 rounded-full text-[10px] font-medium transition-colors ${
                          predSettings.horizon === h
                            ? "bg-[oklch(0.7_0.15_250)] text-white"
                            : "text-[var(--text-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--bg-elevated)]"
                        }`}
                      >
                        {h === 180 ? "3h" : `${h}m`}
                      </button>
                    ))}
                    <button
                      onClick={() => setPredSettingsOpen(true)}
                      className="px-1.5 py-1 rounded-full text-[10px] text-[var(--text-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--bg-elevated)] transition-colors"
                      title="Prediction settings"
                    >
                      ⚙
                    </button>
                  </div>
                  {prediction && (
                    <span className="text-[10px] text-[var(--text-tertiary)] tabular-nums">
                      {prediction.model === "ensemble" ? "ENS" : prediction.model === "ml" ? "ML" : "PHY"}
                      {prediction.model !== predSettings.activeModel && predSettings.activeModel !== "physiological" && " (fallback)"}
                    </span>
                  )}
                </div>
              </div>
              <div className="px-2">
                <GlucoseChart
                  readings={readings}
                  boluses={boluses}
                  carbs={carbs}
                  basals={basals}
                  predictions={predSettings.showOnChart && prediction ? prediction.points : []}
                  height={440}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2">
                <StatsGrid stats={stats} hours={hours} />
              </div>
              <div>
                <PumpStatusCard />
              </div>
            </div>

            <DataTable
              readings={readings}
              boluses={boluses}
              carbs={carbs}
              basals={basals}
            />

            <div className="text-center text-xs text-[var(--text-secondary)] pb-8">
              <span className="opacity-60">
                {readings.length} readings · {boluses.length} boluses ·{" "}
                {carbs.length} carb entries · Updated{" "}
                {lastFetch
                  ? formatMinutesAgo(
                      Math.round(
                        (Date.now() - lastFetch.getTime()) / 60_000
                      )
                    )
                  : "never"}
                {" · Polling every 2m"}
              </span>
            </div>
          </>
        )}
      </main>

      {/* Prediction settings slide-out */}
      <PredictionSettings
        open={predSettingsOpen}
        onClose={() => setPredSettingsOpen(false)}
        settings={predSettings}
        onSetModel={setModel}
        onSetHorizon={setHorizon}
        onToggleChart={toggleChart}
        onToggleHero={toggleHero}
        modelMeta={modelMeta}
      />
    </div>
  );
}
