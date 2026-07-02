"use client";

import { useState, useEffect, useMemo } from "react";
import { AppHeader } from "@/components/layout/AppHeader";
import { AGPChart } from "@/components/charts/AGPChart";
import { DailyOverlayChart } from "@/components/charts/DailyOverlayChart";
import {
  computeAGP,
  computeDailyProfiles,
  computeDayOfWeekPatterns,
  computeTimeOfDayPatterns,
} from "@/lib/trends";
import type { GlucoseReading } from "@/lib/types";

const PERIOD_OPTIONS = [
  { label: "7 days", hours: 168 },
  { label: "14 days", hours: 336 },
  { label: "30 days", hours: 720 },
  { label: "90 days", hours: 2160 },
] as const;

export default function TrendsPage() {
  const [selectedPeriod, setSelectedPeriod] = useState(1); // default 14 days
  const [readings, setReadings] = useState<GlucoseReading[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const hours = PERIOD_OPTIONS[selectedPeriod].hours;

  useEffect(() => {
    setIsLoading(true);
    fetch(`/api/glucose/range?hours=${hours}`)
      .then((res) => res.json())
      .then((data) => {
        setReadings(data);
        setIsLoading(false);
      })
      .catch(() => setIsLoading(false));
  }, [hours]);

  const agpSlots = useMemo(() => computeAGP(readings), [readings]);
  const dailyProfiles = useMemo(
    () => computeDailyProfiles(readings),
    [readings]
  );
  const dayOfWeekPatterns = useMemo(
    () => computeDayOfWeekPatterns(readings),
    [readings]
  );
  const timeOfDayPatterns = useMemo(
    () => computeTimeOfDayPatterns(readings),
    [readings]
  );

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <AppHeader />

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Period selector */}
        <div className="flex items-center gap-1">
          {PERIOD_OPTIONS.map((opt, idx) => (
            <button
              key={opt.label}
              onClick={() => setSelectedPeriod(idx)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                idx === selectedPeriod
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--text-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--bg-elevated)]"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center h-64 text-[var(--text-secondary)]">
            Loading {PERIOD_OPTIONS[selectedPeriod].label} of data...
          </div>
        ) : (
          <>
            {/* AGP — Ambulatory Glucose Profile */}
            <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] overflow-hidden">
              <div className="p-3 pb-0">
                <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider">
                  Ambulatory Glucose Profile (AGP)
                </div>
                <div className="text-[11px] text-[var(--text-secondary)] mt-0.5 opacity-60">
                  24-hour glucose pattern with percentile bands — {readings.length} readings over{" "}
                  {PERIOD_OPTIONS[selectedPeriod].label}
                </div>
              </div>
              <div className="px-2">
                <AGPChart slots={agpSlots} height={300} />
              </div>
            </div>

            {/* Daily Overlay */}
            <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] overflow-hidden">
              <div className="p-3 pb-0">
                <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider">
                  Daily Overlay
                </div>
                <div className="text-[11px] text-[var(--text-secondary)] mt-0.5 opacity-60">
                  Each day plotted on a 24-hour axis — {dailyProfiles.length}{" "}
                  days
                </div>
              </div>
              <div className="px-2">
                <DailyOverlayChart
                  profiles={dailyProfiles}
                  height={300}
                />
              </div>
            </div>

            {/* Time of Day Patterns */}
            <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-4">
              <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider mb-3">
                Time of Day Patterns
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {timeOfDayPatterns.map((p) => (
                  <div
                    key={p.period}
                    className="rounded-xl bg-[var(--bg-elevated)] p-3"
                  >
                    <div className="text-[11px] text-[var(--text-secondary)] mb-2">
                      {p.label}
                    </div>
                    <div className="flex items-baseline gap-1">
                      <span className="text-xl font-semibold tabular-nums">
                        {p.mean}
                      </span>
                      <span className="text-xs text-[var(--text-secondary)]">
                        avg
                      </span>
                    </div>
                    <div className="mt-1">
                      <div className="flex items-center justify-between text-[10px] text-[var(--text-secondary)]">
                        <span>TIR</span>
                        <span className="tabular-nums">{p.timeInRange}%</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-[var(--bg-surface)] mt-0.5 overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${p.timeInRange}%`,
                            backgroundColor:
                              p.timeInRange >= 70
                                ? "var(--glucose-in-range)"
                                : p.timeInRange >= 50
                                  ? "var(--glucose-high)"
                                  : "var(--glucose-urgent-high)",
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Day of Week Patterns */}
            <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-4">
              <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider mb-3">
                Day of Week Patterns
              </div>
              <div className="grid grid-cols-7 gap-2">
                {dayOfWeekPatterns.map((p) => (
                  <div
                    key={p.day}
                    className="rounded-xl bg-[var(--bg-elevated)] p-2 text-center"
                  >
                    <div className="text-[11px] text-[var(--text-secondary)] font-medium mb-1">
                      {p.day}
                    </div>
                    <div className="text-lg font-semibold tabular-nums">
                      {p.count > 0 ? p.mean : "—"}
                    </div>
                    <div className="text-[10px] text-[var(--text-secondary)]">
                      avg
                    </div>
                    {p.count > 0 && (
                      <>
                        <div className="h-1 rounded-full bg-[var(--bg-surface)] mt-1.5 overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${p.timeInRange}%`,
                              backgroundColor:
                                p.timeInRange >= 70
                                  ? "var(--glucose-in-range)"
                                  : p.timeInRange >= 50
                                    ? "var(--glucose-high)"
                                    : "var(--glucose-urgent-high)",
                            }}
                          />
                        </div>
                        <div className="text-[9px] text-[var(--text-secondary)] mt-0.5 tabular-nums">
                          {p.timeInRange}% TIR
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Daily Summary Table */}
            <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] overflow-hidden">
              <div className="p-3 border-b border-[var(--border)]">
                <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider">
                  Daily Summary
                </div>
              </div>
              <div className="max-h-96 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-[var(--bg-surface)]">
                    <tr className="text-[var(--text-secondary)] text-[11px] uppercase tracking-wider">
                      <th className="text-left px-3 py-2 font-medium">Date</th>
                      <th className="text-left px-3 py-2 font-medium">Day</th>
                      <th className="text-right px-3 py-2 font-medium">Avg</th>
                      <th className="text-right px-3 py-2 font-medium">TIR</th>
                      <th className="text-right px-3 py-2 font-medium">
                        Readings
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {dailyProfiles.map((p) => (
                      <tr
                        key={p.date}
                        className="border-t border-[var(--border)] hover:bg-[var(--bg-elevated)] transition-colors"
                      >
                        <td className="px-3 py-2 tabular-nums font-[family-name:var(--font-geist-mono)] text-xs">
                          {p.date}
                        </td>
                        <td className="px-3 py-2 text-xs text-[var(--text-secondary)]">
                          {p.dayOfWeek}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">
                          {p.mean}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span
                            className="tabular-nums font-medium"
                            style={{
                              color:
                                p.timeInRange >= 70
                                  ? "var(--glucose-in-range)"
                                  : p.timeInRange >= 50
                                    ? "var(--glucose-high)"
                                    : "var(--glucose-urgent-high)",
                            }}
                          >
                            {p.timeInRange}%
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-xs text-[var(--text-secondary)] tabular-nums">
                          {p.readings.length}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
