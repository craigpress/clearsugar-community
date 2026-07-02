"use client";

import { useState, useEffect, useMemo } from "react";
import { AppHeader } from "@/components/layout/AppHeader";
import { LinePath } from "@visx/shape";
import { scaleLinear } from "@visx/scale";
import { Group } from "@visx/group";
import { AxisLeft, AxisBottom } from "@visx/axis";
import { GridRows } from "@visx/grid";
import { curveMonotoneX } from "@visx/curve";
import { ParentSize } from "@visx/responsive";
import type { GlucoseReading, Treatment } from "@/lib/types";
import { GLUCOSE_RANGES } from "@/lib/types";
import { computeCoverage } from "@/lib/data-quality";
import {
  analyzeBolusResponses,
  analyzeMealEvents,
  analyzeBasalAdequacy,
  analyzeCarbRatios,
  analyzeISF,
  analyzeOutOfRangeEpisodes,
  analyzeGrowthHormoneCorrelation,
  type BolusResponse,
  type MealEvent,
  type BasalPeriodAnalysis,
  type CarbRatioResult,
  type ISFByPeriod,
  type ISFDataPoint,
  type EpisodeCluster,
  type OutOfRangeEpisode,
  type DaySummary,
  analyzeSitePeriods,
  getCurrentSiteAge,
  type SitePeriod,
  extractFastingTrajectories,
  type FastingTrajectory,
} from "@/lib/insulin-analysis";

const SUB_TABS = [
  { key: "meals", label: "After Meals" },
  { key: "isf", label: "Corrections" },
  { key: "basal", label: "Basal Rates" },
  { key: "carb", label: "Carb Coverage" },
  { key: "sites", label: "Pump Sites" },
  { key: "episodes", label: "Highs & Lows" },
  { key: "overnight", label: "Overnight" },
] as const;

type SubTab = (typeof SUB_TABS)[number]["key"];

const ANALYSIS_PREFS_KEY = "clearsugar.analysis.prefs";

// Minimum qualifying data points before a stat is shown as real (mirrors the
// n<4 threshold the insights LLM prompt uses).
const MIN_SAMPLE = 4;

const DURATION_OPTIONS = [
  { label: "7 days", days: 7 },
  { label: "14 days", days: 14 },
  { label: "30 days", days: 30 },
  { label: "60 days", days: 60 },
  { label: "90 days", days: 90 },
];

function formatDateInput(d: Date): string {
  // Format in the patient's timezone (Eastern) to match the rest of the app's
  // hour/day bucketing. toISOString() is UTC and rolls to "tomorrow" after
  // ~8 PM ET, which would default the date picker a day ahead.
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export default function AnalysisPage() {
  const [subTab, setSubTab] = useState<SubTab>("meals");
  const [readings, setReadings] = useState<GlucoseReading[]>([]);
  const [boluses, setBoluses] = useState<Treatment[]>([]);
  const [carbs, setCarbs] = useState<Treatment[]>([]);
  const [basals, setBasals] = useState<Treatment[]>([]);
  const [allTreatments, setAllTreatments] = useState<Treatment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Date range state — default: last 14 days ending today
  const [endDate, setEndDate] = useState(() => formatDateInput(new Date()));
  const [durationDays, setDurationDays] = useState(14);

  // Restore persisted durationDays (endDate stays defaulting to today)
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(ANALYSIS_PREFS_KEY);
      if (raw) {
        const prefs = JSON.parse(raw);
        if (typeof prefs.durationDays === "number") setDurationDays(prefs.durationDays);
      }
    } catch {
      // Ignore malformed/blocked storage
    }
  }, []);

  // Persist durationDays
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(ANALYSIS_PREFS_KEY, JSON.stringify({ durationDays }));
    } catch {
      // Ignore quota/blocked storage
    }
  }, [durationDays]);

  // Compute hours from endDate backward
  const hoursToFetch = useMemo(() => {
    const end = new Date(endDate + "T23:59:59");
    const start = new Date(end.getTime() - durationDays * 24 * 60 * 60_000);
    const now = new Date();
    // Hours from now back to start
    return Math.round((now.getTime() - start.getTime()) / 3_600_000);
  }, [endDate, durationDays]);

  // Filter readings to the selected window
  const filterWindow = useMemo(() => {
    const end = new Date(endDate + "T23:59:59").getTime();
    const start = end - durationDays * 24 * 60 * 60_000;
    return { start, end };
  }, [endDate, durationDays]);

  useEffect(() => {
    setIsLoading(true);
    setError(null);
    // Capture HTTP status alongside the parsed body so we can distinguish an
    // expired session (401) from other failures.
    const parse = async (url: string) => {
      // Always fetch fresh (avoid a stale cached/partial response wedging the
      // page) and retry once if a 200 comes back as non-JSON/empty — that can
      // happen on a cold load when the body fails to parse.
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await fetch(url, { cache: "no-store" });
        const body = await r.json().catch(() => null);
        if (r.status === 200 && body === null && attempt === 0) continue;
        return { status: r.status, body };
      }
      return { status: 200, body: null };
    };
    Promise.all([
      parse(`/api/glucose/range?hours=${hoursToFetch}`),
      parse(`/api/treatments?hours=${hoursToFetch}`),
    ]).then(([glucose, treatment]) => {
      const glucoseData = glucose.body;
      const treatmentData = treatment.body;
      // API routes return a non-array error object on non-200 (e.g. 401 after
      // an expired SSO session, or 502 if Nightscout is down). Guard against it
      // so the page degrades to an empty state instead of throwing.
      const gData = Array.isArray(glucoseData) ? glucoseData : [];
      const tData = Array.isArray(treatmentData) ? treatmentData : [];

      // Surface an error banner if either request failed (non-array body).
      if (!Array.isArray(glucoseData) || !Array.isArray(treatmentData)) {
        const status = glucose.status !== 200 ? glucose.status : treatment.status;
        if (status === 401) {
          setError("Your session expired — please re-login");
        } else {
          const msg =
            (!Array.isArray(glucoseData) && glucoseData?.error) ||
            (!Array.isArray(treatmentData) && treatmentData?.error) ||
            `request failed (${status})`;
          setError(`Couldn't load data: ${msg}`);
        }
      }
      // Filter to exact date window
      const gFiltered = gData.filter(
        (g: GlucoseReading) => g.date >= filterWindow.start && g.date <= filterWindow.end
      );
      const tFiltered = tData.filter((t: Treatment) => {
        const time = t.mills || new Date(t.created_at).getTime();
        return time >= filterWindow.start && time <= filterWindow.end;
      });

      setReadings(gFiltered);
      setBoluses(
        tFiltered.filter(
          (t: Treatment) =>
            t.insulin !== null && t.insulin !== undefined && t.insulin > 0
        )
      );
      setCarbs(
        tFiltered.filter(
          (t: Treatment) =>
            t.carbs !== null && t.carbs !== undefined && t.carbs > 0
        )
      );
      setBasals(tFiltered.filter((t: Treatment) => t.eventType === "Temp Basal"));
      setAllTreatments(tFiltered);
      setIsLoading(false);
    }).catch((e) => {
      console.error("Analysis data load failed:", e);
      setReadings([]);
      setBoluses([]);
      setCarbs([]);
      setBasals([]);
      setAllTreatments([]);
      setError(`Couldn't load data: ${e instanceof Error ? e.message : "network error"}`);
      setIsLoading(false);
    });
  }, [hoursToFetch, filterWindow]);

  const mealEvents = useMemo(
    () => analyzeMealEvents(readings, boluses, carbs),
    [readings, boluses, carbs]
  );
  const bolusResponses = useMemo(
    () => analyzeBolusResponses(readings, boluses, carbs),
    [readings, boluses, carbs]
  );
  const basalAnalysis = useMemo(
    () => analyzeBasalAdequacy(readings, boluses, carbs, basals),
    [readings, boluses, carbs, basals]
  );
  const carbRatios = useMemo(
    () => analyzeCarbRatios(readings, boluses, carbs),
    [readings, boluses, carbs]
  );
  const isfAnalysis = useMemo(
    () => analyzeISF(readings, boluses, carbs, allTreatments),
    [readings, boluses, carbs, allTreatments]
  );
  const sitePeriods = useMemo(
    () => analyzeSitePeriods(readings, allTreatments, boluses, carbs),
    [readings, allTreatments, boluses, carbs]
  );
  const currentSiteAge = useMemo(
    () => getCurrentSiteAge(allTreatments),
    [allTreatments]
  );
  const fastingTrajectories = useMemo(
    () => extractFastingTrajectories(readings, boluses, carbs),
    [readings, boluses, carbs]
  );
  const episodeAnalysis = useMemo(
    () => analyzeOutOfRangeEpisodes(readings, boluses, carbs, basals),
    [readings, boluses, carbs, basals]
  );
  const overnightAnalysis = useMemo(
    () => analyzeGrowthHormoneCorrelation(readings, boluses, carbs),
    [readings, boluses, carbs]
  );
  const coverage = useMemo(
    () => computeCoverage(readings, filterWindow.start, filterWindow.end),
    [readings, filterWindow]
  );

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <AppHeader />

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        {/* Sub-tabs — full width, wrapping */}
        <div className="flex flex-wrap items-center gap-1.5">
          {SUB_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setSubTab(tab.key)}
              className={`px-3.5 py-2 rounded-lg text-sm font-medium transition-colors ${
                subTab === tab.key
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--text-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--bg-elevated)]"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Date range controls — separate row below tabs */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            {DURATION_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                onClick={() => setDurationDays(opt.days)}
                className={`px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
                  durationDays === opt.days
                    ? "bg-[var(--bg-elevated)] text-[var(--foreground)]"
                    : "text-[var(--text-secondary)] hover:text-[var(--foreground)]"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
            <span>ending</span>
            <input
              type="date"
              value={endDate}
              max={formatDateInput(new Date())}
              onChange={(e) => setEndDate(e.target.value)}
              className="bg-[var(--bg-elevated)] border border-[var(--border)] rounded px-2 py-1.5 text-xs text-[var(--foreground)] font-[family-name:var(--font-geist-mono)] [color-scheme:dark]"
            />
          </div>
          <span className="text-xs text-[var(--text-secondary)] opacity-50">
            {readings.length} readings · {boluses.length} boluses · {carbs.length} carbs
          </span>
          {!isLoading && readings.length > 0 && (
            <span
              className={`text-xs ${
                coverage.pctActive < 70 ? "text-amber-400" : "text-[var(--text-secondary)] opacity-50"
              }`}
              title={`${coverage.actualReadings} of ~${coverage.expectedReadings} expected readings · ${coverage.daysWithData} days with data`}
            >
              CGM active {coverage.pctActive}% · longest gap {coverage.longestGapHours}h
            </span>
          )}
        </div>

        {error && (
          <div className="flex items-start justify-between gap-3 rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              className="text-red-400/70 hover:text-red-400 leading-none text-lg"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-4">
            <div className="h-24 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] animate-pulse" />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-28 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] animate-pulse" />
              ))}
            </div>
            <div className="h-64 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] animate-pulse" />
          </div>
        ) : (
          <>
            {subTab === "meals" && (
              <MealResponsePanel events={mealEvents} durationDays={durationDays} />
            )}
            {subTab === "isf" && (
              <ISFPanel analysis={isfAnalysis} />
            )}
            {subTab === "basal" && (
              <BasalAdequacyPanel analysis={basalAnalysis} trajectories={fastingTrajectories} />
            )}
            {subTab === "carb" && (
              <CarbRatioPanel results={carbRatios} />
            )}
            {subTab === "episodes" && (
              <EpisodesPanel analysis={episodeAnalysis} />
            )}
            {subTab === "overnight" && (
              <OvernightPanel summaries={overnightAnalysis} />
            )}
            {subTab === "sites" && (
              <SitePanel periods={sitePeriods} currentAgeHours={currentSiteAge} />
            )}
          </>
        )}
      </main>
    </div>
  );
}

// ── (old BolusResponsePanel removed — replaced by MealResponsePanel below) ──

// ── Basal Adequacy Panel ──

function BasalAdequacyPanel({ analysis, trajectories = [] }: { analysis: BasalPeriodAnalysis[]; trajectories?: FastingTrajectory[] }) {
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null);

  // Filter trajectories by selected block
  const filteredTrajectories = selectedBlock
    ? trajectories.filter((t) => t.blockLabel === selectedBlock)
    : trajectories;

  // Compute average trajectory per block for bold lines
  const avgByBlock = useMemo(() => {
    const map = new Map<string, { minutesIn: number; avgDelta: number }[]>();
    const blocks = [...new Set(filteredTrajectories.map((t) => t.blockLabel))];
    for (const block of blocks) {
      const blockTrajs = filteredTrajectories.filter((t) => t.blockLabel === block);
      const slots = new Map<number, number[]>();
      for (const traj of blockTrajs) {
        for (const pt of traj.points) {
          const bucket = Math.round(pt.minutesIn / 10) * 10;
          if (!slots.has(bucket)) slots.set(bucket, []);
          slots.get(bucket)!.push(pt.delta);
        }
      }
      const avg = [...slots.entries()]
        .map(([min, deltas]) => ({
          minutesIn: min,
          avgDelta: Math.round(deltas.reduce((s, d) => s + d, 0) / deltas.length),
        }))
        .sort((a, b) => a.minutesIn - b.minutesIn);
      map.set(block, avg);
    }
    return map;
  }, [filteredTrajectories]);

  const BLOCK_COLORS: Record<string, string> = {
    "12a–3a": "#7c4dff", "3a–6a": "#42a5f5", "6a–9a": "#66bb6a", "9a–12p": "#ffa726",
    "12p–3p": "#ef5350", "3p–6p": "#ab47bc", "6p–9p": "#26c6da", "9p–12a": "#ec407a",
  };

  return (
    <div className="space-y-4">
      {/* Summary cards — clickable to filter */}
      <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-4">
        <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider mb-1">
          Basal Adequacy by Time Block
        </div>
        <div className="text-[11px] text-[var(--text-secondary)] mb-4 opacity-60">
          Click a time block to filter the chart. Each line = a fasting period, normalized to Δ from start.
          Rising = basal too low. Falling = too high. Flat = adequate.
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {analysis.map((block) => {
            const isSelected = selectedBlock === block.label;
            const trajCount = trajectories.filter((t) => t.blockLabel === block.label).length;
            return (
              <div
                key={block.label}
                onClick={() => setSelectedBlock(isSelected ? null : block.label)}
                className={`rounded-xl p-3 cursor-pointer transition-all ${
                  isSelected
                    ? "bg-[var(--accent)]/10 border-2 border-[var(--accent)]/30"
                    : "bg-[var(--bg-elevated)] border-2 border-transparent hover:border-[var(--border-hover)]"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] text-[var(--text-secondary)] font-medium">{block.label}</span>
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: BLOCK_COLORS[block.label] || "#666" }} />
                </div>

                {block.verdict === "insufficient_data" || trajCount < MIN_SAMPLE ? (
                  <div className="text-xs text-[var(--text-secondary)] opacity-50">
                    {trajCount === 0 ? "No fasting data" : `insufficient data (n<${MIN_SAMPLE})`}
                  </div>
                ) : (
                  <>
                    <div className="flex items-baseline gap-1">
                      <span className={`text-xl font-semibold tabular-nums ${
                        block.verdict === "adequate" ? "text-[var(--glucose-in-range)]" : "text-amber-400"
                      }`}>
                        {block.avgGlucoseChange > 0 ? "+" : ""}{block.avgGlucoseChange}
                      </span>
                      <span className="text-xs text-[var(--text-secondary)]">mg/dL/hr</span>
                    </div>
                    <div className="mt-1 text-[11px]">
                      {block.verdict === "adequate" && <span className="text-[var(--glucose-in-range)]">✓ Adequate</span>}
                      {block.verdict === "too_low" && <span className="text-amber-400">↑ Too low</span>}
                      {block.verdict === "too_high" && <span className="text-amber-400">↓ Too high</span>}
                    </div>
                    <div className="mt-1 text-[10px] text-[var(--text-secondary)] opacity-50">
                      {trajCount} fasting periods
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Fasting trajectory chart */}
      {filteredTrajectories.length > 0 && (
        <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] overflow-hidden">
          <div className="p-3">
            <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider">
              Fasting Glucose Drift {selectedBlock ? `— ${selectedBlock}` : "— All Blocks"}
            </div>
            <div className="text-[11px] text-[var(--text-secondary)] mt-0.5 opacity-60">
              {filteredTrajectories.length} fasting periods. Y-axis = change from starting glucose (0 = flat = correct basal).
              Bold = average per time block. Faint = individual periods.
            </div>
          </div>
          <ParentSize>
            {({ width }) => width > 0 ? (
              <FastingTrajectoryChart
                trajectories={filteredTrajectories}
                avgByBlock={avgByBlock}
                blockColors={BLOCK_COLORS}
                width={width}
                height={300}
              />
            ) : null}
          </ParentSize>
        </div>
      )}

      <div className="rounded-2xl bg-amber-500/5 border border-amber-500/10 p-4 text-xs text-[var(--text-secondary)]">
        ⚕️ This analysis shows patterns in fasting glucose data. It is not medical advice.
        Always discuss basal rate changes with your endocrinologist.
      </div>
    </div>
  );
}

// ── Carb Ratio Panel ──

const MEAL_COLORS_CR: Record<string, string> = {
  Breakfast: "#ef5350", Lunch: "#42a5f5", Snack: "#66bb6a", Dinner: "#ffa726", "Late Night": "#ab47bc",
};

function CarbRatioPanel({ results }: { results: CarbRatioResult[] }) {
  const [selectedMeal, setSelectedMeal] = useState<string | null>(null);

  const byMeal = new Map<string, CarbRatioResult[]>();
  for (const r of results) {
    if (!byMeal.has(r.timeOfDay)) byMeal.set(r.timeOfDay, []);
    byMeal.get(r.timeOfDay)!.push(r);
  }

  const filtered = selectedMeal ? results.filter(r => r.timeOfDay === selectedMeal) : results;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-4">
        <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider mb-1">
          Carb Ratio Effectiveness
        </div>
        <div className="text-[11px] text-[var(--text-secondary)] mb-4 opacity-60">
          Click a meal type to filter. Green = in range at 2h. Amber = high. Red = very high.
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {["Breakfast", "Lunch", "Snack", "Dinner"].map((meal) => {
            const meals = byMeal.get(meal) || [];
            const isSelected = selectedMeal === meal;
            if (meals.length < MIN_SAMPLE) {
              return (
                <div key={meal} className="rounded-xl bg-[var(--bg-elevated)] p-3">
                  <div className="text-[11px] text-[var(--text-secondary)] font-medium mb-2">{meal}</div>
                  <div className="text-xs text-[var(--text-secondary)] opacity-50">
                    {meals.length === 0 ? "No data" : `insufficient data (n<${MIN_SAMPLE})`}
                  </div>
                </div>
              );
            }

            const inRange = meals.filter((m) => m.outcome === "in_range").length;
            const successRate = Math.round((inRange / meals.length) * 100);
            const avgRatio = Math.round(meals.reduce((s, m) => s + m.effectiveRatio, 0) / meals.length * 10) / 10;
            const avg2h = meals.filter((m) => m.glucoseAt2h !== null);
            const avg2hGlucose = avg2h.length > 0
              ? Math.round(avg2h.reduce((s, m) => s + (m.glucoseAt2h || 0), 0) / avg2h.length)
              : null;

            return (
              <div key={meal} onClick={() => setSelectedMeal(isSelected ? null : meal)}
                className={`rounded-xl p-3 cursor-pointer transition-all ${
                  isSelected ? "bg-[var(--accent)]/10 border-2 border-[var(--accent)]/30" : "bg-[var(--bg-elevated)] border-2 border-transparent hover:border-[var(--border-hover)]"
                }`}>
                <div className="text-base font-semibold mb-2" style={{ color: MEAL_COLORS_CR[meal] || "var(--foreground)" }}>{meal}</div>
                <div className="flex items-baseline gap-1">
                  <span className={`text-xl font-semibold tabular-nums ${
                    successRate >= 70 ? "text-[var(--glucose-in-range)]"
                    : successRate >= 50 ? "text-amber-400"
                    : "text-red-400"
                  }`}>
                    {successRate}%
                  </span>
                  <span className="text-xs text-[var(--text-secondary)]">in range</span>
                </div>
                <div className="mt-1 text-[10px] text-[var(--text-secondary)]">
                  Avg ratio: 1:{avgRatio} · {meals.length} meals
                </div>
                {avg2hGlucose && (
                  <div className="text-[10px] text-[var(--text-secondary)]">
                    Avg 2h glucose: {avg2hGlucose} mg/dL
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Detail table — filtered */}
      <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] overflow-hidden">
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--bg-surface)]">
              <tr className="text-[var(--text-secondary)] text-[11px] uppercase tracking-wider">
                <th className="text-left px-3 py-2 font-medium">Time</th>
                <th className="text-left px-3 py-2 font-medium">Meal</th>
                <th className="text-right px-3 py-2 font-medium">Carbs</th>
                <th className="text-right px-3 py-2 font-medium">Dose</th>
                <th className="text-right px-3 py-2 font-medium">Ratio</th>
                <th className="text-right px-3 py-2 font-medium">Pre</th>
                <th className="text-right px-3 py-2 font-medium">2h Post</th>
                <th className="text-right px-3 py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 50).map((r, i) => (
                <tr key={i} className="border-t border-[var(--border)] hover:bg-[var(--bg-elevated)]">
                  <td className="px-3 py-1.5 text-xs font-[family-name:var(--font-geist-mono)] text-[var(--text-secondary)]">
                    {new Date(r.mealTime).toLocaleDateString([], { month: "short", day: "numeric" })}{" "}
                    {new Date(r.mealTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </td>
                  <td className="px-3 py-1.5 text-xs font-medium" style={{ color: MEAL_COLORS_CR[r.timeOfDay] || "var(--foreground)" }}>{r.timeOfDay}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-[var(--carb-amber)]">{r.carbs}g</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-[var(--insulin-blue)]">{r.insulin}U</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">1:{r.effectiveRatio}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.preMeal}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.glucoseAt2h ?? "—"}</td>
                  <td className="px-3 py-1.5 text-right text-xs">
                    <span className={`px-1.5 py-0.5 rounded ${
                      r.outcome === "in_range" ? "bg-emerald-500/10 text-emerald-400"
                      : r.outcome === "low" ? "bg-red-500/10 text-red-400"
                      : r.outcome === "high" ? "bg-amber-500/10 text-amber-400"
                      : "bg-red-500/10 text-red-400"
                    }`}>
                      {r.outcome === "in_range" ? "✓" : r.outcome === "low" ? "LOW" : r.outcome === "high" ? "HIGH" : "V.HIGH"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-2xl bg-amber-500/5 border border-amber-500/10 p-4 text-xs text-[var(--text-secondary)]">
        ⚕️ This analysis compares actual vs expected glucose outcomes. It is not medical advice.
        Discuss carb ratio changes with your endocrinologist.
      </div>
    </div>
  );
}

// ── Meal Response Panel (carb-anchored, normalized, averaged by meal type) ──

const MEAL_COLORS: Record<string, string> = {
  Breakfast: "#ef5350",
  Lunch: "#42a5f5",
  Snack: "#66bb6a",
  Dinner: "#ffa726",
};

function MealResponsePanel({ events, durationDays = 14 }: { events: MealEvent[]; durationDays?: number }) {
  const [viewMode, setViewMode] = useState<"normalized" | "absolute">("normalized");
  const [selectedMeal, setSelectedMeal] = useState<string | null>(null);
  const meals = events.filter((e) => e.totalCarbs > 0 && e.trajectory.length > 3);

  // Group by meal type
  const byType = new Map<string, MealEvent[]>();
  for (const m of meals) {
    if (!byType.has(m.timeOfDay)) byType.set(m.timeOfDay, []);
    byType.get(m.timeOfDay)!.push(m);
  }

  // Compute averaged trajectory per meal type (normalized: change from baseline)
  const avgTrajectories = new Map<string, { minutesAfter: number; avgDelta: number; avgAbsolute: number }[]>();
  for (const [type, typeMeals] of byType) {
    const slots = new Map<number, { deltas: number[]; absolutes: number[] }>();
    for (const meal of typeMeals) {
      const baseline = meal.preMeal || meal.trajectory[0]?.sgv || 0;
      for (const pt of meal.trajectory) {
        const bucket = Math.round(pt.minutesAfter / 10) * 10; // 10-min buckets
        if (bucket < -10 || bucket > 240) continue;
        if (!slots.has(bucket)) slots.set(bucket, { deltas: [], absolutes: [] });
        slots.get(bucket)!.deltas.push(pt.sgv - baseline);
        slots.get(bucket)!.absolutes.push(pt.sgv);
      }
    }
    const avg = [...slots.entries()]
      .map(([min, { deltas, absolutes }]) => ({
        minutesAfter: min,
        avgDelta: Math.round(deltas.reduce((s, v) => s + v, 0) / deltas.length),
        avgAbsolute: Math.round(absolutes.reduce((s, v) => s + v, 0) / absolutes.length),
      }))
      .sort((a, b) => a.minutesAfter - b.minutesAfter);
    avgTrajectories.set(type, avg);
  }

  const filtered = selectedMeal ? meals.filter(m => m.timeOfDay === selectedMeal) : meals;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] overflow-hidden">
        <div className="p-3 flex items-center justify-between">
          <div>
            <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider">Meal Response ({durationDays} days)</div>
            <div className="text-[11px] text-[var(--text-secondary)] mt-0.5 opacity-60">
              Anchored on carb entries. Bold lines = average per meal type. Faint = individual meals.
              {viewMode === "normalized" ? " Y-axis shows change from pre-meal glucose." : " Y-axis shows absolute glucose."}
            </div>
          </div>
          <div className="flex gap-1">
            <button onClick={() => setViewMode("normalized")}
              className={`px-2.5 py-1 rounded text-[11px] font-medium ${viewMode === "normalized" ? "bg-[var(--accent)] text-white" : "text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]"}`}>
              Δ Change
            </button>
            <button onClick={() => setViewMode("absolute")}
              className={`px-2.5 py-1 rounded text-[11px] font-medium ${viewMode === "absolute" ? "bg-[var(--accent)] text-white" : "text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]"}`}>
              Absolute
            </button>
          </div>
        </div>

        {/* Meal type filter pills */}
        <div className="px-3 pb-2 flex items-center gap-1.5">
          <button onClick={() => setSelectedMeal(null)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${!selectedMeal ? "bg-[var(--bg-elevated)] text-[var(--foreground)]" : "text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]"}`}>
            All ({meals.length})
          </button>
          {["Breakfast", "Lunch", "Snack", "Dinner"].map(type => {
            const count = byType.get(type)?.length || 0;
            if (count === 0) return null;
            return (
              <button key={type} onClick={() => setSelectedMeal(selectedMeal === type ? null : type)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors flex items-center gap-1 ${selectedMeal === type ? "bg-[var(--bg-elevated)] text-[var(--foreground)]" : "text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]"}`}>
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: MEAL_COLORS[type] }} />
                {type} ({count})
              </button>
            );
          })}
        </div>

        <ParentSize>
          {({ width }) => width > 0 ? (
            <MealResponseChart
              meals={filtered}
              avgTrajectories={selectedMeal ? new Map([[selectedMeal, avgTrajectories.get(selectedMeal) || []]]) : avgTrajectories}
              viewMode={viewMode}
              width={width}
              height={320}
            />
          ) : null}
        </ParentSize>
      </div>

      {/* Per-meal-type summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {["Breakfast", "Lunch", "Snack", "Dinner"].map(type => {
          const typeMeals = byType.get(type) || [];
          if (typeMeals.length < MIN_SAMPLE) return (
            <div key={type} className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-4">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: MEAL_COLORS[type] }} />
                <span className="text-xs text-[var(--text-secondary)] uppercase tracking-wider">{type}</span>
              </div>
              <div className="text-xs text-[var(--text-secondary)] opacity-50">
                {typeMeals.length === 0 ? "No data" : `insufficient data (n<${MIN_SAMPLE})`}
              </div>
            </div>
          );
          const avgPeak = Math.round(typeMeals.reduce((s, m) => s + m.peakGlucose, 0) / typeMeals.length);
          const avgPeakTime = Math.round(typeMeals.reduce((s, m) => s + m.peakTimeMin, 0) / typeMeals.length);
          const avgCarbs = Math.round(typeMeals.reduce((s, m) => s + m.totalCarbs, 0) / typeMeals.length);
          const avgInsulin = (typeMeals.reduce((s, m) => s + m.totalInsulin, 0) / typeMeals.length).toFixed(1);
          const at2h = typeMeals.filter(m => m.glucoseAt120 !== null);
          const avg2h = at2h.length > 0 ? Math.round(at2h.reduce((s, m) => s + (m.glucoseAt120 || 0), 0) / at2h.length) : null;
          const inRange2h = at2h.filter(m => (m.glucoseAt120 || 0) >= 70 && (m.glucoseAt120 || 0) <= 180).length;
          const successRate = at2h.length > 0 ? Math.round((inRange2h / at2h.length) * 100) : 0;

          return (
            <div key={type} className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-4 hover:border-[var(--border-hover)] transition-colors cursor-pointer"
              onClick={() => setSelectedMeal(selectedMeal === type ? null : type)}>
              <div className="flex items-center gap-1.5 mb-2">
                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: MEAL_COLORS[type] }} />
                <span className="text-xs text-[var(--text-secondary)] uppercase tracking-wider">{type}</span>
                <span className="text-[10px] text-[var(--text-secondary)] ml-auto">{typeMeals.length} meals</span>
              </div>
              <div className="text-xl font-semibold tabular-nums">{avgPeak} <span className="text-xs text-[var(--text-secondary)] font-normal">peak</span></div>
              <div className="text-[10px] text-[var(--text-secondary)] mt-1 space-y-0.5">
                <div>Peak at ~{avgPeakTime}m · {avgCarbs}g avg carbs · {avgInsulin}U avg</div>
                {avg2h && <div>2h glucose: {avg2h} · {successRate}% in range at 2h</div>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Meal detail table */}
      <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] overflow-hidden">
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--bg-surface)]">
              <tr className="text-[var(--text-secondary)] text-[11px] uppercase tracking-wider">
                <th className="text-left px-3 py-2 font-medium">Time</th>
                <th className="text-left px-3 py-2 font-medium">Meal</th>
                <th className="text-right px-3 py-2 font-medium">Carbs</th>
                <th className="text-right px-3 py-2 font-medium">Insulin</th>
                <th className="text-right px-3 py-2 font-medium">Pre</th>
                <th className="text-right px-3 py-2 font-medium">Peak</th>
                <th className="text-right px-3 py-2 font-medium">Δ Rise</th>
                <th className="text-right px-3 py-2 font-medium">2h</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 50).map((e, i) => {
                const rise = e.peakGlucose - e.preMeal;
                return (
                  <tr key={i} className="border-t border-[var(--border)] hover:bg-[var(--bg-elevated)]">
                    <td className="px-3 py-1.5 text-xs font-[family-name:var(--font-geist-mono)] text-[var(--text-secondary)]">
                      {new Date(e.startTime).toLocaleDateString([], { month: "short", day: "numeric" })}{" "}
                      {new Date(e.startTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="flex items-center gap-1 text-xs">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: MEAL_COLORS[e.timeOfDay] }} />
                        {e.timeOfDay}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-[var(--carb-amber)]">{e.totalCarbs}g</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-[var(--insulin-blue)]">{e.totalInsulin}U</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{e.preMeal}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{e.peakGlucose} <span className="text-[10px] text-[var(--text-secondary)]">@{e.peakTimeMin}m</span></td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${rise > 80 ? "text-red-400" : rise > 50 ? "text-amber-400" : "text-[var(--glucose-in-range)]"}`}>
                      +{rise}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{e.glucoseAt120 ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function MealResponseChart({
  meals,
  avgTrajectories,
  viewMode,
  width,
  height,
}: {
  meals: MealEvent[];
  avgTrajectories: Map<string, { minutesAfter: number; avgDelta: number; avgAbsolute: number }[]>;
  viewMode: "normalized" | "absolute";
  width: number;
  height: number;
}) {
  const margin = { top: 16, right: 16, bottom: 40, left: 52 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const xScale = scaleLinear({ domain: [-10, 240], range: [0, innerW] });

  // Y domain depends on view mode
  const yDomain: [number, number] = viewMode === "normalized" ? [-80, 150] : [40, 350];
  const yScale = scaleLinear({ domain: yDomain, range: [innerH, 0], nice: true });

  return (
    <svg width={width} height={height}>
      <Group left={margin.left} top={margin.top}>
        {/* Target band or zero line */}
        {viewMode === "normalized" ? (
          <line x1={0} x2={innerW} y1={yScale(0)} y2={yScale(0)}
            stroke="var(--text-secondary)" strokeWidth={1} strokeDasharray="4,4" opacity={0.3} />
        ) : (
          <rect x={0} y={yScale(180)} width={innerW}
            height={yScale(70) - yScale(180)} fill="var(--range-band)" />
        )}

        <GridRows scale={yScale} width={innerW} stroke="var(--grid-line)" numTicks={6} />

        {/* Bolus time marker */}
        <line x1={xScale(0)} x2={xScale(0)} y1={0} y2={innerH}
          stroke="var(--text-secondary)" strokeWidth={1} strokeDasharray="3,3" opacity={0.3} />

        {/* Individual meal curves (faint) */}
        {meals.map((meal, i) => {
          const baseline = meal.preMeal || meal.trajectory[0]?.sgv || 0;
          return (
            <LinePath key={i}
              data={meal.trajectory.filter(pt => pt.minutesAfter >= -10 && pt.minutesAfter <= 240)}
              x={(d) => xScale(d.minutesAfter)}
              y={(d) => {
                const val = viewMode === "normalized" ? d.sgv - baseline : d.sgv;
                return yScale(Math.min(Math.max(val, yDomain[0]), yDomain[1]));
              }}
              stroke={MEAL_COLORS[meal.timeOfDay] || "var(--text-secondary)"}
              strokeWidth={1} curve={curveMonotoneX} opacity={0.15}
            />
          );
        })}

        {/* Average curves (bold) */}
        {[...avgTrajectories.entries()].map(([type, pts]) => (
          <LinePath key={type}
            data={pts}
            x={(d) => xScale(d.minutesAfter)}
            y={(d) => {
              const val = viewMode === "normalized" ? d.avgDelta : d.avgAbsolute;
              return yScale(Math.min(Math.max(val, yDomain[0]), yDomain[1]));
            }}
            stroke={MEAL_COLORS[type] || "var(--accent)"}
            strokeWidth={3} curve={curveMonotoneX} opacity={0.9}
            strokeLinecap="round"
          />
        ))}

        <AxisLeft scale={yScale} numTicks={6} stroke="var(--border)" tickStroke="var(--border)"
          tickFormat={(v) => viewMode === "normalized" ? `${Number(v) > 0 ? "+" : ""}${v}` : `${v}`}
          tickLabelProps={() => ({ fill: "var(--text-secondary)", fontSize: 11, fontFamily: "var(--font-geist-mono)", textAnchor: "end" as const, dx: -4, dy: 3 })} />
        <AxisBottom scale={xScale} top={innerH} stroke="var(--border)" tickStroke="var(--border)"
          tickValues={[0, 30, 60, 90, 120, 180, 240]} tickFormat={(v) => `${v}m`}
          tickLabelProps={() => ({ fill: "var(--text-secondary)", fontSize: 11, fontFamily: "var(--font-geist-mono)", textAnchor: "middle" as const, dy: 4 })} />

        {/* Y-axis label */}
        <text x={-innerH / 2} y={-40} transform="rotate(-90)" textAnchor="middle"
          fill="var(--text-secondary)" fontSize={10} fontFamily="var(--font-geist-mono)">
          {viewMode === "normalized" ? "Δ mg/dL from pre-meal" : "mg/dL"}
        </text>
      </Group>
    </svg>
  );
}

// ── ISF Panel ──

function ISFPanel({ analysis }: { analysis: { dataPoints: ISFDataPoint[]; byPeriod: ISFByPeriod[] } }) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-4">
        <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider mb-1">Insulin Sensitivity by Time of Day</div>
        <div className="text-[11px] text-[var(--text-secondary)] mb-4 opacity-60">
          Observed ISF (mg/dL drop per unit) from correction boluses with no carbs nearby.
          Higher = more sensitive. Negative = insulin was ineffective (possible site issue).
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {analysis.byPeriod.map((p) => (
            <div key={p.period} className="rounded-xl bg-[var(--bg-elevated)] p-3">
              <div className="text-[11px] text-[var(--text-secondary)] mb-2">{p.label}</div>
              {p.dataPoints.length < MIN_SAMPLE ? (
                <div className="text-xs text-[var(--text-secondary)] opacity-50">
                  {p.dataPoints.length === 0 ? "No data" : `insufficient data (n<${MIN_SAMPLE})`}
                </div>
              ) : (
                <>
                  <div className="flex items-baseline gap-1">
                    <span className={`text-2xl font-semibold tabular-nums ${p.avgISF > 0 ? "" : "text-red-400"}`}>
                      {p.avgISF}
                    </span>
                    <span className="text-xs text-[var(--text-secondary)]">mg/dL/U</span>
                  </div>
                  <div className="mt-1 text-[10px] text-[var(--text-secondary)]">
                    Median: {p.medianISF} · {p.dataPoints.length} corrections
                  </div>
                  <div className="mt-1">
                    <div className="flex items-center justify-between text-[10px] text-[var(--text-secondary)]">
                      <span>Effective</span>
                      <span className={`tabular-nums ${p.effectiveRate >= 70 ? "text-[var(--glucose-in-range)]" : p.effectiveRate >= 40 ? "text-amber-400" : "text-red-400"}`}>
                        {p.effectiveRate}%
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-[var(--bg-surface)] mt-0.5 overflow-hidden">
                      <div className="h-full rounded-full" style={{
                        width: `${p.effectiveRate}%`,
                        backgroundColor: p.effectiveRate >= 70 ? "var(--glucose-in-range)" : p.effectiveRate >= 40 ? "var(--carb-amber)" : "var(--glucose-urgent-high)"
                      }} />
                    </div>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ISF scatter plot by hour */}
      <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] overflow-hidden">
        <div className="p-3 text-xs text-[var(--text-secondary)] uppercase tracking-wider">ISF by Hour</div>
        <ParentSize>
          {({ width }) => width > 0 ? <ISFScatterChart dataPoints={analysis.dataPoints} width={width} height={250} /> : null}
        </ParentSize>
      </div>

      <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] overflow-hidden">
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--bg-surface)]">
              <tr className="text-[var(--text-secondary)] text-[11px] uppercase tracking-wider">
                <th className="text-left px-3 py-2 font-medium">Time</th>
                <th className="text-right px-3 py-2 font-medium">Dose</th>
                <th className="text-right px-3 py-2 font-medium">Pre</th>
                <th className="text-right px-3 py-2 font-medium">2h Post</th>
                <th className="text-right px-3 py-2 font-medium">Drop</th>
                <th className="text-right px-3 py-2 font-medium">ISF</th>
                <th className="text-right px-3 py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {analysis.dataPoints.slice(0, 40).map((d, i) => (
                <tr key={i} className="border-t border-[var(--border)] hover:bg-[var(--bg-elevated)]">
                  <td className="px-3 py-1.5 text-xs font-[family-name:var(--font-geist-mono)] text-[var(--text-secondary)]">
                    {new Date(d.time).toLocaleDateString([], { month: "short", day: "numeric" })}{" "}
                    {new Date(d.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-[var(--insulin-blue)]">{d.insulin}U</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{d.preBolus}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{d.glucoseAt2h}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{d.drop > 0 ? `-${d.drop}` : `+${Math.abs(d.drop)}`}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${d.isf > 0 ? "" : "text-red-400"}`}>{d.isf}</td>
                  <td className="px-3 py-1.5 text-right">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${d.effective ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
                      {d.effective ? "✓" : "✗"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-2xl bg-amber-500/5 border border-amber-500/10 p-4 text-xs text-[var(--text-secondary)]">
        ⚕️ Negative or very low ISF values may indicate site absorption problems, insulin degradation, or unusual insulin resistance.
        Discuss persistent patterns with your endocrinologist.
      </div>
    </div>
  );
}

function ISFScatterChart({ dataPoints, width, height }: { dataPoints: ISFDataPoint[]; width: number; height: number }) {
  const margin = { top: 16, right: 16, bottom: 32, left: 44 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const xScale = scaleLinear({ domain: [0, 24], range: [0, innerW] });
  const maxISF = Math.max(150, ...dataPoints.filter(d => d.isf > 0).map(d => d.isf));
  const minISF = Math.min(-50, ...dataPoints.map(d => d.isf));
  const yScale = scaleLinear({ domain: [minISF, maxISF], range: [innerH, 0], nice: true });

  return (
    <svg width={width} height={height}>
      <Group left={margin.left} top={margin.top}>
        <GridRows scale={yScale} width={innerW} stroke="var(--grid-line)" numTicks={5} />
        <line x1={0} x2={innerW} y1={yScale(0)} y2={yScale(0)} stroke="var(--text-secondary)" strokeDasharray="3,3" opacity={0.3} />
        {dataPoints.map((d, i) => (
          <circle key={i} cx={xScale(d.hour + Math.random() * 0.5)} cy={yScale(d.isf)}
            r={Math.max(3, d.insulin * 2)} fill={d.effective ? "var(--insulin-blue)" : "var(--glucose-urgent-high)"}
            opacity={0.6} />
        ))}
        <AxisLeft scale={yScale} numTicks={5} stroke="var(--border)" tickStroke="var(--border)"
          tickLabelProps={() => ({ fill: "var(--text-secondary)", fontSize: 10, fontFamily: "var(--font-geist-mono)", textAnchor: "end" as const, dx: -4, dy: 3 })} />
        <AxisBottom scale={xScale} top={innerH} stroke="var(--border)" tickStroke="var(--border)"
          tickValues={[0, 3, 6, 9, 12, 15, 18, 21]}
          tickFormat={(v) => { const n = Number(v); return n === 0 ? '12a' : n === 12 ? '12p' : n < 12 ? n + 'a' : (n - 12) + 'p'; }}
          tickLabelProps={() => ({ fill: "var(--text-secondary)", fontSize: 10, fontFamily: "var(--font-geist-mono)", textAnchor: "middle" as const, dy: 4 })} />
      </Group>
    </svg>
  );
}

// ── Episodes Panel ──

function EpisodesPanel({ analysis }: { analysis: { episodes: OutOfRangeEpisode[]; clusters: EpisodeCluster[] } }) {
  const { episodes, clusters } = analysis;
  const [selectedCluster, setSelectedCluster] = useState<number | null>(null);
  const [typeFilter, setTypeFilter] = useState<"all" | "high" | "low">("all");

  const highs = episodes.filter(e => e.type === "high");
  const lows = episodes.filter(e => e.type === "low");

  // Apply filters
  let filtered = episodes;
  if (selectedCluster !== null && clusters[selectedCluster]) {
    const clusterEps = clusters[selectedCluster].episodes;
    filtered = clusterEps;
  }
  if (typeFilter !== "all") {
    filtered = filtered.filter(e => e.type === typeFilter);
  }

  return (
    <div className="space-y-4">
      {/* Type filter pills */}
      <div className="flex items-center gap-1">
        {[
          { key: "all" as const, label: `All (${episodes.length})` },
          { key: "high" as const, label: `Highs (${highs.length})` },
          { key: "low" as const, label: `Lows (${lows.length})` },
        ].map((f) => (
          <button key={f.key} onClick={() => { setTypeFilter(f.key); setSelectedCluster(null); }}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              typeFilter === f.key && selectedCluster === null ? "bg-[var(--accent)] text-white" : "text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]"
            }`}>
            {f.label}
          </button>
        ))}
      </div>

      {clusters.length > 0 && (
        <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-4">
          <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider mb-3">Pattern Clusters — click to filter</div>
          <div className="space-y-3">
            {clusters.map((c, i) => {
              const isSelected = selectedCluster === i;
              return (
                <div key={i} onClick={() => { setSelectedCluster(isSelected ? null : i); setTypeFilter("all"); }}
                  className={`rounded-xl p-3 cursor-pointer transition-all ${
                    isSelected ? "ring-2 ring-[var(--accent)] " : ""
                  }${c.label.includes("Low") ? "bg-red-500/5 border border-red-500/10" : "bg-amber-500/5 border border-amber-500/10"}`}>
                  <div className="font-medium text-sm mb-1">{c.label}</div>
                  <div className="text-xs text-[var(--text-secondary)] mb-2">
                    {c.episodes.length} episodes · avg {c.avgDuration} min · avg peak {c.avgPeak} mg/dL
                    {c.commonDay && ` · mostly on ${c.commonDay}s`}
                  </div>
                  <div className="text-xs text-[var(--foreground)] opacity-80">
                    💡 {c.possibleCause}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Showing" value={filtered.length} detail="episodes" />
        <StatCard label="High Episodes" value={highs.length} detail=">250 for 30+ min" />
        <StatCard label="Low Episodes" value={lows.length} detail="<70 for 15+ min" />
        <StatCard label="Avg Duration" value={filtered.length > 0 ? Math.round(filtered.reduce((s, e) => s + e.durationMin, 0) / filtered.length) : "—"} unit="min" />
      </div>

      <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] overflow-hidden">
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--bg-surface)]">
              <tr className="text-[var(--text-secondary)] text-[11px] uppercase tracking-wider">
                <th className="text-left px-3 py-2 font-medium">Start</th>
                <th className="text-left px-3 py-2 font-medium">Type</th>
                <th className="text-right px-3 py-2 font-medium">Duration</th>
                <th className="text-right px-3 py-2 font-medium">Peak</th>
                <th className="text-right px-3 py-2 font-medium">Insulin 2h Before</th>
                <th className="text-right px-3 py-2 font-medium">Carbs 2h Before</th>
                <th className="text-right px-3 py-2 font-medium">Auto-Corr</th>
              </tr>
            </thead>
            <tbody>
              {filtered.sort((a, b) => b.startTime - a.startTime).slice(0, 30).map((e, i) => (
                <tr key={i} className="border-t border-[var(--border)] hover:bg-[var(--bg-elevated)]">
                  <td className="px-3 py-1.5 text-xs font-[family-name:var(--font-geist-mono)] text-[var(--text-secondary)]">
                    {e.dayOfWeek} {new Date(e.startTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${e.type === "high" ? "bg-amber-500/10 text-amber-400" : "bg-red-500/10 text-red-400"}`}>
                      {e.type === "high" ? "HIGH" : "LOW"}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{e.durationMin}m</td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-medium">{e.peakValue}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-[var(--insulin-blue)]">{e.insulinBefore2h}U</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-[var(--carb-amber)]">{e.carbsBefore2h}g</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{e.controlIQCorrections}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Overnight / Growth Hormone Panel (corrected mechanism) ──
// GH is taken at night. Missing it → NEXT DAY daytime lows despite eating.
// NOT overnight lows. GH raises insulin resistance, so without it the
// pump's normal settings become too aggressive during the day.

function OvernightPanel({ summaries }: { summaries: DaySummary[] }) {
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const suspectMissed = summaries.filter(s => s.classification === "suspect_missed_gh");
  const suspectResistance = summaries.filter(s => s.classification === "suspect_resistance");
  const normal = summaries.filter(s => s.classification === "normal");
  const mixed = summaries.filter(s => s.classification === "mixed");
  const filteredSummaries = classFilter ? summaries.filter(s => s.classification === classFilter) : summaries;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-4">
        <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider mb-1">Growth Hormone & Day Analysis</div>
        <div className="text-[11px] text-[var(--text-secondary)] mb-4 opacity-60">
          Overnight rises can be influenced by hormones such as growth hormone or dawn phenomenon.
          When a growth hormone dose is <strong className="text-[var(--foreground)]">missed</strong>, the <strong className="text-[var(--foreground)]">next day</strong> the
          patient may be more insulin-sensitive than their pump expects → <strong className="text-[var(--foreground)]">daytime lows despite eating</strong>.
          The key signal: lows within 3 hours of a meal.
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {[
            { key: "normal", label: "Normal Days", count: normal.length, detail: `of ${summaries.length}` },
            { key: "suspect_missed_gh", label: "Suspect Missed GH", count: suspectMissed.length, detail: "daytime lows + carbs" },
            { key: "suspect_resistance", label: "Insulin Resistance", count: suspectResistance.length, detail: "overnight highs" },
            { key: "mixed", label: "Mixed / Unclear", count: mixed.length, detail: "lows without meals" },
          ].map((item) => (
            <div key={item.key} onClick={() => setClassFilter(classFilter === item.key ? null : item.key)}
              className={`rounded-2xl border-2 p-4 cursor-pointer transition-all ${
                classFilter === item.key ? "border-[var(--accent)]/30 bg-[var(--accent)]/5" : "border-[var(--border)] bg-[var(--bg-surface)] hover:border-[var(--border-hover)]"
              }`}>
              <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider mb-1">{item.label}</div>
              <div className="text-2xl font-semibold tabular-nums">{item.count}</div>
              <div className="text-xs text-[var(--text-secondary)] mt-1">{item.detail}</div>
            </div>
          ))}
        </div>
      </div>

      {suspectMissed.length > 0 && (
        <div className="rounded-2xl bg-blue-500/5 border border-blue-500/15 p-4">
          <div className="font-medium text-sm mb-2">💉 Possible Missed Growth Hormone → Next-Day Lows</div>
          <div className="text-xs text-[var(--text-secondary)] mb-3">
            These days had <strong>daytime lows despite eating carbs</strong> — the hallmark of a missed GH dose the night before.
            Without GH, the patient may be more insulin-sensitive than their pump settings expect.
          </div>
          <div className="space-y-2">
            {suspectMissed.map((s) => (
              <div key={s.date} className="rounded-lg bg-[var(--bg-elevated)] p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium text-sm">{s.dayOfWeek} {s.date}</span>
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    s.ghMissConfidence === "high" ? "bg-blue-500/20 text-blue-300" :
                    s.ghMissConfidence === "medium" ? "bg-blue-500/10 text-blue-400" :
                    "bg-blue-500/5 text-blue-400/70"
                  }`}>
                    {s.ghMissConfidence} confidence
                  </span>
                </div>
                <div className="text-xs text-[var(--text-secondary)] mb-1">
                  Daytime: avg {s.daytimeAvg} · min {s.daytimeMin} · {s.daytimeLowPercent}% low · {s.daytimeCarbs}g carbs · {s.daytimeBoluses}U insulin
                </div>
                <div className="text-xs text-[var(--foreground)] opacity-80">
                  💡 {s.reasoning}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {suspectResistance.length > 0 && (
        <div className="rounded-2xl bg-amber-500/5 border border-amber-500/15 p-4">
          <div className="font-medium text-sm mb-2">⚡ Overnight Insulin Resistance</div>
          <div className="text-xs text-[var(--text-secondary)] mb-3">
            These days had overnight highs despite Control-IQ corrections.
            May indicate: aging infusion site, high-fat dinner, illness, or unusual metabolic state.
          </div>
          <div className="space-y-2">
            {suspectResistance.map((s) => (
              <div key={s.date} className="rounded-lg bg-[var(--bg-elevated)] p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium text-sm">{s.dayOfWeek} {s.date}</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-amber-500/10 text-amber-400">Resistance</span>
                </div>
                <div className="text-xs text-[var(--text-secondary)]">
                  Overnight: avg {s.overnightAvg} · {s.overnightHighPercent}% above 180 · {s.overnightCorrections} corrections ({s.overnightCorrectionInsulin}U)
                </div>
                <div className="text-xs text-[var(--foreground)] opacity-80 mt-1">
                  💡 {s.reasoning}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Full day-by-day table */}
      <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] overflow-hidden">
        <div className="p-3 border-b border-[var(--border)] text-xs text-[var(--text-secondary)] uppercase tracking-wider">
          Day-by-Day Summary {classFilter && `— ${classFilter.replace("_", " ")}`} ({filteredSummaries.length} days)
        </div>
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--bg-surface)]">
              <tr className="text-[var(--text-secondary)] text-[11px] uppercase tracking-wider">
                <th className="text-left px-3 py-2 font-medium">Day</th>
                <th className="text-right px-3 py-2 font-medium">Day Avg</th>
                <th className="text-right px-3 py-2 font-medium">Day Min</th>
                <th className="text-right px-3 py-2 font-medium">%Low</th>
                <th className="text-right px-3 py-2 font-medium">Carbs</th>
                <th className="text-right px-3 py-2 font-medium">Insulin</th>
                <th className="text-center px-3 py-2 font-medium">Lows+Carbs</th>
                <th className="text-right px-3 py-2 font-medium">Night Avg</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredSummaries.map((s) => (
                <tr key={s.date} className="border-t border-[var(--border)] hover:bg-[var(--bg-elevated)]">
                  <td className="px-3 py-1.5 text-xs font-[family-name:var(--font-geist-mono)] text-[var(--text-secondary)]">{s.dayOfWeek} {s.date.slice(5)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{s.daytimeAvg}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${s.daytimeMin < 70 ? "text-red-400" : ""}`}>{s.daytimeMin}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${s.daytimeLowPercent > 5 ? "text-red-400" : ""}`}>{s.daytimeLowPercent}%</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-[var(--carb-amber)]">{s.daytimeCarbs}g</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-[var(--insulin-blue)]">{s.daytimeBoluses}U</td>
                  <td className="px-3 py-1.5 text-center">
                    {s.lowsDespiteCarbs ? (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/10 text-red-400">Yes</span>
                    ) : (
                      <span className="text-xs text-[var(--text-secondary)] opacity-40">—</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{s.overnightAvg || "—"}</td>
                  <td className="px-3 py-1.5">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      s.classification === "normal" ? "bg-emerald-500/10 text-emerald-400" :
                      s.classification === "suspect_missed_gh" ? "bg-blue-500/10 text-blue-400" :
                      s.classification === "suspect_resistance" ? "bg-amber-500/10 text-amber-400" :
                      "bg-[var(--bg-elevated)] text-[var(--text-secondary)]"
                    }`}>
                      {s.classification === "normal" ? "✓" :
                       s.classification === "suspect_missed_gh" ? "GH?" :
                       s.classification === "suspect_resistance" ? "Resist." : "Mixed"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-2xl bg-amber-500/5 border border-amber-500/10 p-4 text-xs text-[var(--text-secondary)]">
        ⚕️ &ldquo;Suspect missed GH&rdquo; means: daytime lows despite eating, consistent with increased insulin sensitivity from a missed growth hormone dose.
        Track GH doses alongside this data for more accurate correlation. Discuss patterns with your endocrinologist.
      </div>
    </div>
  );
}

// ── Fasting Trajectory Chart ──

function FastingTrajectoryChart({
  trajectories,
  avgByBlock,
  blockColors,
  width,
  height,
}: {
  trajectories: FastingTrajectory[];
  avgByBlock: Map<string, { minutesIn: number; avgDelta: number }[]>;
  blockColors: Record<string, string>;
  width: number;
  height: number;
}) {
  const margin = { top: 16, right: 16, bottom: 40, left: 52 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const xScale = scaleLinear({ domain: [0, 240], range: [0, innerW] });

  // Y domain: find the range of deltas
  const allDeltas = trajectories.flatMap((t) => t.points.map((p) => p.delta));
  const minD = Math.min(-40, ...allDeltas);
  const maxD = Math.max(40, ...allDeltas);
  const yScale = scaleLinear({ domain: [minD, maxD], range: [innerH, 0], nice: true });

  return (
    <svg width={width} height={height}>
      <Group left={margin.left} top={margin.top}>
        <GridRows scale={yScale} width={innerW} stroke="var(--grid-line)" numTicks={5} />

        {/* Zero line (flat = correct basal) */}
        <line x1={0} x2={innerW} y1={yScale(0)} y2={yScale(0)}
          stroke="var(--glucose-in-range)" strokeWidth={1.5} strokeDasharray="6,3" opacity={0.5} />

        {/* Individual fasting trajectories (faint) */}
        {trajectories.map((traj, i) => (
          <LinePath key={i}
            data={traj.points}
            x={(d) => xScale(d.minutesIn)}
            y={(d) => yScale(Math.min(Math.max(d.delta, minD), maxD))}
            stroke={blockColors[traj.blockLabel] || "var(--text-secondary)"}
            strokeWidth={1} curve={curveMonotoneX} opacity={0.15}
          />
        ))}

        {/* Average trajectories per block (bold) */}
        {[...avgByBlock.entries()].map(([block, pts]) => (
          <LinePath key={block}
            data={pts}
            x={(d) => xScale(d.minutesIn)}
            y={(d) => yScale(Math.min(Math.max(d.avgDelta, minD), maxD))}
            stroke={blockColors[block] || "var(--accent)"}
            strokeWidth={3} curve={curveMonotoneX} opacity={0.9}
            strokeLinecap="round"
          />
        ))}

        {/* Y-axis label */}
        <text x={-innerH / 2} y={-40} transform="rotate(-90)" textAnchor="middle"
          fill="var(--text-secondary)" fontSize={10} fontFamily="var(--font-geist-mono)">
          Δ mg/dL from fasting start
        </text>

        <AxisLeft scale={yScale} numTicks={5} stroke="var(--border)" tickStroke="var(--border)"
          tickFormat={(v) => `${Number(v) > 0 ? "+" : ""}${v}`}
          tickLabelProps={() => ({ fill: "var(--text-secondary)", fontSize: 11, fontFamily: "var(--font-geist-mono)", textAnchor: "end" as const, dx: -4, dy: 3 })} />
        <AxisBottom scale={xScale} top={innerH} stroke="var(--border)" tickStroke="var(--border)"
          tickValues={[0, 30, 60, 90, 120, 180, 240]} tickFormat={(v) => `${v}m`}
          tickLabelProps={() => ({ fill: "var(--text-secondary)", fontSize: 11, fontFamily: "var(--font-geist-mono)", textAnchor: "middle" as const, dy: 4 })} />
      </Group>
    </svg>
  );
}

// ── Site Changes Panel ──

function SitePanel({ periods, currentAgeHours }: { periods: SitePeriod[]; currentAgeHours: number | null }) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-4">
        <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider mb-1">Infusion Site Analysis</div>
        <div className="text-[11px] text-[var(--text-secondary)] mb-4 opacity-60">
          Tracks glucose quality and insulin effectiveness per infusion site. Detects degradation over time —
          rising glucose and decreasing ISF effectiveness in older sites can indicate absorption issues.
        </div>

        {/* Current site age */}
        {currentAgeHours !== null && (
          <div className="flex items-center gap-3 mb-4 p-3 rounded-xl bg-[var(--bg-elevated)]">
            <div className="text-xs text-[var(--text-secondary)]">Current Site Age:</div>
            <div className={`text-xl font-semibold tabular-nums ${
              currentAgeHours > 72 ? "text-red-400" : currentAgeHours > 48 ? "text-amber-400" : "text-[var(--glucose-in-range)]"
            }`}>
              {currentAgeHours < 24 ? `${currentAgeHours}h` : `${(currentAgeHours / 24).toFixed(1)} days`}
            </div>
            {currentAgeHours > 72 && (
              <span className="text-xs px-2 py-0.5 rounded bg-red-500/10 text-red-400">Consider changing</span>
            )}
          </div>
        )}

        {periods.length === 0 ? (
          <div className="text-sm text-[var(--text-secondary)] opacity-50">No site change data found in this period.</div>
        ) : (
          <div className="space-y-3">
            {periods.map((p, i) => {
              const degraded = p.degradation > 20; // glucose avg rose >20 mg/dL over the site's life
              const isfDegraded = p.effectiveRate < 50 && p.correctionCount > 2;
              return (
                <div key={i} className={`rounded-xl p-4 ${
                  degraded || isfDegraded ? "bg-amber-500/5 border border-amber-500/10" : "bg-[var(--bg-elevated)]"
                }`}>
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <span className="font-medium text-sm">Site started {p.siteChangeDate}</span>
                      <span className="text-xs text-[var(--text-secondary)] ml-2">{p.notes}</span>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      p.ageDays > 3 ? "bg-red-500/10 text-red-400" :
                      p.ageDays > 2 ? "bg-amber-500/10 text-amber-400" :
                      "bg-emerald-500/10 text-emerald-400"
                    }`}>
                      {p.ageDays} days
                    </span>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                    <div>
                      <div className="text-[var(--text-secondary)]">Avg Glucose</div>
                      <div className="font-semibold tabular-nums">{p.avgGlucose} mg/dL</div>
                    </div>
                    <div>
                      <div className="text-[var(--text-secondary)]">TIR</div>
                      <div className={`font-semibold tabular-nums ${p.tir >= 70 ? "text-[var(--glucose-in-range)]" : "text-amber-400"}`}>
                        {p.tir}%
                      </div>
                    </div>
                    <div>
                      <div className="text-[var(--text-secondary)]">Avg ISF</div>
                      <div className={`font-semibold tabular-nums ${p.avgISF > 0 ? "" : "text-red-400"}`}>
                        {p.correctionCount > 0 ? `${p.avgISF} mg/dL/U` : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[var(--text-secondary)]">Corrections Effective</div>
                      <div className={`font-semibold tabular-nums ${
                        p.effectiveRate >= 70 ? "text-[var(--glucose-in-range)]" :
                        p.effectiveRate >= 40 ? "text-amber-400" : "text-red-400"
                      }`}>
                        {p.correctionCount > 0 ? `${p.effectiveRate}% (${p.correctionCount})` : "—"}
                      </div>
                    </div>
                  </div>

                  {/* Degradation indicator */}
                  {p.ageDays > 1 && (
                    <div className="mt-3 pt-2 border-t border-[var(--border)]">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-[var(--text-secondary)]">First 24h avg → Last 24h avg</span>
                        <span className={`tabular-nums font-medium ${
                          p.degradation > 20 ? "text-red-400" : p.degradation > 10 ? "text-amber-400" : "text-[var(--glucose-in-range)]"
                        }`}>
                          {p.first24hAvg} → {p.last24hAvg}
                          {p.degradation > 0 ? ` (+${p.degradation})` : ` (${p.degradation})`}
                        </span>
                      </div>
                      {degraded && (
                        <div className="text-xs text-amber-400 mt-1">
                          ⚠ Glucose averaged {p.degradation} mg/dL higher by end of site — possible absorption degradation
                        </div>
                      )}
                      {isfDegraded && (
                        <div className="text-xs text-amber-400 mt-1">
                          ⚠ Only {p.effectiveRate}% of corrections were effective — insulin may not be absorbing well
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="rounded-2xl bg-amber-500/5 border border-amber-500/10 p-4 text-xs text-[var(--text-secondary)]">
        ⚕️ Infusion sites typically last 2-3 days. Absorption degrades over time — if glucose control worsens
        and corrections become less effective, it may be time to change the site. Most endocrinologists recommend
        changing every 2-3 days.
      </div>
    </div>
  );
}

// ── Shared StatCard ──

function StatCard({ label, value, unit, detail }: {
  label: string; value: string | number; unit?: string; detail?: string;
}) {
  return (
    <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-4">
      <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider mb-1">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {unit && <span className="text-sm text-[var(--text-secondary)]">{unit}</span>}
      </div>
      {detail && <div className="text-xs text-[var(--text-secondary)] mt-1">{detail}</div>}
    </div>
  );
}
