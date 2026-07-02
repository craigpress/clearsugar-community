"use client";

import { useMemo, useState } from "react";
import type { GlucoseReading, Treatment } from "@/lib/types";
import { TREND_ARROWS } from "@/lib/types";
import { glucoseColorClass } from "@/lib/statistics";

type DataRow =
  | { type: "glucose"; time: number; reading: GlucoseReading }
  | { type: "bolus"; time: number; treatment: Treatment }
  | { type: "carb"; time: number; treatment: Treatment }
  | { type: "basal"; time: number; treatment: Treatment };

interface DataTableProps {
  readings: GlucoseReading[];
  boluses: Treatment[];
  carbs: Treatment[];
  basals: Treatment[];
}

function treatmentTime(t: Treatment): number {
  return t.mills || new Date(t.created_at).getTime();
}

export function DataTable({
  readings,
  boluses,
  carbs,
  basals,
}: DataTableProps) {
  const [filter, setFilter] = useState<
    "all" | "glucose" | "insulin" | "carbs"
  >("all");

  const rows = useMemo(() => {
    const all: DataRow[] = [];

    if (filter === "all" || filter === "glucose") {
      // Show every 3rd glucose reading to avoid overwhelming the table
      const step = filter === "glucose" ? 1 : 3;
      for (let i = 0; i < readings.length; i += step) {
        const r = readings[i];
        all.push({ type: "glucose", time: r.date, reading: r });
      }
    }

    if (filter === "all" || filter === "insulin") {
      for (const b of boluses) {
        all.push({ type: "bolus", time: treatmentTime(b), treatment: b });
      }
      // Show basal changes (not every 5-min temp basal)
      let lastRate = -1;
      for (const b of basals) {
        const rate = b.rate || b.absolute || 0;
        if (rate !== lastRate) {
          all.push({ type: "basal", time: treatmentTime(b), treatment: b });
          lastRate = rate;
        }
      }
    }

    if (filter === "all" || filter === "carbs") {
      for (const c of carbs) {
        all.push({ type: "carb", time: treatmentTime(c), treatment: c });
      }
    }

    return all.sort((a, b) => b.time - a.time); // newest first
  }, [readings, boluses, carbs, basals, filter]);

  const filters = [
    { key: "all" as const, label: "All" },
    { key: "glucose" as const, label: "Glucose" },
    { key: "insulin" as const, label: "Insulin" },
    { key: "carbs" as const, label: "Carbs" },
  ];

  return (
    <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] overflow-hidden">
      {/* Header with filters */}
      <div className="flex items-center justify-between p-3 border-b border-[var(--border)]">
        <span className="text-xs text-[var(--text-secondary)] uppercase tracking-wider">
          Data Log
        </span>
        <div className="flex gap-1">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
                filter === f.key
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable table */}
      <div className="max-h-80 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-[var(--bg-surface)]">
            <tr className="text-[var(--text-secondary)] text-[11px] uppercase tracking-wider">
              <th className="text-left px-3 py-2 font-medium">Time</th>
              <th className="text-left px-3 py-2 font-medium">Type</th>
              <th className="text-right px-3 py-2 font-medium">Value</th>
              <th className="text-right px-3 py-2 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={`${row.type}-${row.time}-${i}`}
                className="border-t border-[var(--border)] hover:bg-[var(--bg-elevated)] transition-colors"
              >
                <td className="px-3 py-2 tabular-nums font-[family-name:var(--font-geist-mono)] text-xs text-[var(--text-secondary)]">
                  {new Date(row.time).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                  <span className="ml-1 opacity-50">
                    {new Date(row.time).toLocaleDateString([], {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                </td>
                <td className="px-3 py-2">
                  {row.type === "glucose" && (
                    <span className="inline-flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-[var(--glucose-in-range)]" />
                      <span className="text-xs">CGM</span>
                    </span>
                  )}
                  {row.type === "bolus" && (
                    <span className="inline-flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-[var(--insulin-blue)]" />
                      <span className="text-xs">Bolus</span>
                    </span>
                  )}
                  {row.type === "basal" && (
                    <span className="inline-flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-[var(--insulin-blue)] opacity-40" />
                      <span className="text-xs">Basal</span>
                    </span>
                  )}
                  {row.type === "carb" && (
                    <span className="inline-flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-[var(--carb-amber)]" />
                      <span className="text-xs">Carbs</span>
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-medium">
                  {row.type === "glucose" && (
                    <span className={glucoseColorClass(row.reading.sgv)}>
                      {row.reading.sgv}
                      <span className="ml-1 text-xs opacity-70">
                        {TREND_ARROWS[row.reading.direction]}
                      </span>
                    </span>
                  )}
                  {row.type === "bolus" && (
                    <span className="text-[var(--insulin-blue)]">
                      {row.treatment.insulin}U
                    </span>
                  )}
                  {row.type === "basal" && (
                    <span className="text-[var(--insulin-blue)] opacity-60">
                      {(
                        row.treatment.rate ||
                        row.treatment.absolute ||
                        0
                      ).toFixed(2)}{" "}
                      U/hr
                    </span>
                  )}
                  {row.type === "carb" && (
                    <span className="text-[var(--carb-amber)]">
                      {row.treatment.carbs}g
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right text-xs text-[var(--text-secondary)]">
                  {row.type === "glucose" && "mg/dL"}
                  {row.type === "bolus" &&
                    (row.treatment.enteredBy?.includes("tconnectsync")
                      ? "Auto"
                      : "Manual")}
                  {row.type === "basal" &&
                    (row.treatment.reason === "Algorithm"
                      ? "Control-IQ"
                      : row.treatment.reason || "")}
                  {row.type === "carb" && "logged"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="p-8 text-center text-[var(--text-secondary)] text-sm">
            No data for this period
          </div>
        )}
      </div>

      {/* Footer count */}
      <div className="px-3 py-2 border-t border-[var(--border)] text-[11px] text-[var(--text-secondary)]">
        {rows.length} entries
      </div>
    </div>
  );
}
