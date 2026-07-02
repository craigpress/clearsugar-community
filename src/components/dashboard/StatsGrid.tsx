"use client";

import type { GlucoseStats } from "@/lib/types";

interface StatsGridProps {
  stats: GlucoseStats | null;
  hours: number;
}

function StatCard({
  label,
  value,
  unit,
  detail,
}: {
  label: string;
  value: string | number;
  unit?: string;
  detail?: string;
}) {
  return (
    <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-4 hover:border-[var(--border-hover)] transition-colors">
      <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {unit && (
          <span className="text-sm text-[var(--text-secondary)]">{unit}</span>
        )}
      </div>
      {detail && (
        <div className="text-xs text-[var(--text-secondary)] mt-1">
          {detail}
        </div>
      )}
    </div>
  );
}

function TIRBar({ stats }: { stats: GlucoseStats }) {
  const { timeInRange: tir } = stats;
  const segments = [
    { pct: tir.veryLow, color: "var(--glucose-urgent-low)", label: "<54" },
    { pct: tir.low, color: "var(--glucose-low)", label: "54-70" },
    { pct: tir.inRange, color: "var(--glucose-in-range)", label: "70-180" },
    { pct: tir.high, color: "var(--glucose-high)", label: "180-250" },
    { pct: tir.veryHigh, color: "var(--glucose-urgent-high)", label: ">250" },
  ];

  return (
    <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-4 hover:border-[var(--border-hover)] transition-colors">
      <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider mb-3">
        Time in Range
      </div>

      {/* Large percentage */}
      <div className="flex items-baseline gap-1 mb-3">
        <span className="text-3xl font-semibold tabular-nums text-[var(--glucose-in-range)]">
          {tir.inRange}%
        </span>
        <span className="text-sm text-[var(--text-secondary)]">in range</span>
      </div>

      {/* Stacked bar */}
      <div className="h-3 rounded-full overflow-hidden flex bg-[var(--bg-elevated)]">
        {segments.map(
          (seg) =>
            seg.pct > 0 && (
              <div
                key={seg.label}
                style={{
                  width: `${seg.pct}%`,
                  backgroundColor: seg.color,
                }}
                title={`${seg.label}: ${seg.pct}%`}
              />
            )
        )}
      </div>

      {/* Legend */}
      <div className="flex justify-between mt-2 text-[10px] text-[var(--text-secondary)] font-[family-name:var(--font-geist-mono)]">
        {segments.map((seg) => (
          <span key={seg.label}>
            {seg.label}: {seg.pct}%
          </span>
        ))}
      </div>
    </div>
  );
}

export function StatsGrid({ stats, hours }: StatsGridProps) {
  if (!stats || stats.count === 0) {
    return (
      <div className="text-[var(--text-secondary)] text-sm p-4">
        Calculating statistics...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <TIRBar stats={stats} />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Average"
          value={stats.mean}
          unit="mg/dL"
          detail={`${hours}h average`}
        />
        <StatCard
          label="GMI"
          value={stats.gmi.toFixed(1)}
          unit="%"
          detail="Est. A1c"
        />
        <StatCard
          label="CV"
          value={stats.cv}
          unit="%"
          detail={stats.cv <= 36 ? "✓ Stable" : "Variable"}
        />
        <StatCard
          label="Readings"
          value={stats.count}
          detail={`${hours}h period`}
        />
      </div>
    </div>
  );
}
