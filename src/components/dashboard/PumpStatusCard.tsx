"use client";

import { useState, useEffect } from "react";

interface PumpData {
  currentBasalRate: number | null;
  lastBasalTime: string | null;
  boluses: {
    count: number;
    totalUnits: number;
    last: { insulin: number; created_at: string } | null;
  };
  carbs: {
    count: number;
    totalGrams: number;
    last: { carbs: number; created_at: string } | null;
  };
  lastPumpUpdate: string | null;
  pumpStaleMinutes: number | null;
  pumpIsStale: boolean;
}

export function PumpStatusCard() {
  const [data, setData] = useState<PumpData | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  useEffect(() => {
    const fetchPump = async () => {
      try {
        const res = await fetch("/api/pump/status");
        if (res.ok) setData(await res.json());
      } catch {
        // silently fail — pump card is supplementary
      }
    };
    fetchPump();
    const interval = setInterval(fetchPump, 180_000); // refresh every 3 min
    return () => clearInterval(interval);
  }, []);

  const triggerSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.ok) {
        setSyncResult("Sync triggered");
      } else {
        setSyncResult(data.error || "Sync failed");
      }
    } catch {
      setSyncResult("Cannot reach webhook");
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncResult(null), 5000);
    }
  };

  if (!data) {
    return (
      <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-4">
        <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider mb-2">
          Pump Status
        </div>
        <div className="text-sm text-[var(--text-secondary)]">Loading...</div>
      </div>
    );
  }

  const formatTime = (iso: string) =>
    new Date(iso).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });

  return (
    <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-4 hover:border-[var(--border-hover)] transition-colors">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider">
          Pump Status
        </div>
        <div className="flex items-center gap-2">
          {data.pumpIsStale && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
              Stale
            </span>
          )}
          <button
            onClick={triggerSync}
            disabled={syncing}
            className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
              syncing
                ? "bg-blue-500/20 text-blue-300 border-blue-500/20 cursor-wait"
                : syncResult
                  ? syncResult === "Sync triggered"
                    ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/20"
                    : "bg-red-500/20 text-red-400 border-red-500/20"
                  : "text-[var(--text-secondary)] border-[var(--border)] hover:text-[var(--foreground)] hover:border-[var(--border-hover)]"
            }`}
            title="Trigger manual tconnectsync pull from Tandem"
          >
            {syncing ? "Syncing..." : syncResult || "Sync"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Current Basal */}
        <div>
          <div className="text-xs text-[var(--text-secondary)] mb-0.5">
            Basal Rate
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-lg font-semibold tabular-nums text-[var(--insulin-blue)]">
              {data.currentBasalRate !== null
                ? data.currentBasalRate.toFixed(1)
                : "—"}
            </span>
            <span className="text-xs text-[var(--text-secondary)]">U/hr</span>
          </div>
        </div>

        {/* Total Bolus (6h) */}
        <div>
          <div className="text-xs text-[var(--text-secondary)] mb-0.5">
            Bolus (6h)
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-lg font-semibold tabular-nums text-[var(--insulin-blue)]">
              {data.boluses.totalUnits.toFixed(1)}
            </span>
            <span className="text-xs text-[var(--text-secondary)]">
              U ({data.boluses.count})
            </span>
          </div>
        </div>

        {/* Total Carbs (6h) */}
        <div>
          <div className="text-xs text-[var(--text-secondary)] mb-0.5">
            Carbs (6h)
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-lg font-semibold tabular-nums text-[var(--carb-amber)]">
              {data.carbs.totalGrams}
            </span>
            <span className="text-xs text-[var(--text-secondary)]">
              g ({data.carbs.count})
            </span>
          </div>
        </div>

        {/* Last Update */}
        <div>
          <div className="text-xs text-[var(--text-secondary)] mb-0.5">
            Last Sync
          </div>
          <div
            className={`text-sm tabular-nums ${data.pumpIsStale ? "text-amber-400" : "text-[var(--text-secondary)]"}`}
          >
            {data.lastPumpUpdate
              ? `${data.pumpStaleMinutes}m ago`
              : "No data"}
          </div>
        </div>
      </div>

      {/* Last bolus detail */}
      {data.boluses.last && (
        <div className="mt-3 pt-3 border-t border-[var(--border)] text-xs text-[var(--text-secondary)]">
          Last bolus: {data.boluses.last.insulin}U at{" "}
          {formatTime(data.boluses.last.created_at)}
        </div>
      )}
    </div>
  );
}
