"use client";

import { useEffect, useState } from "react";
import type { AdvisoryAction } from "@/lib/prediction/advisor-types";

interface AdvisorStatus {
  lastFired: {
    firedAt: number;
    ciqMode: string | null;
    advisory: AdvisoryAction;
  } | null;
  advisorMode: string | null;
  advisorLastRunAt: number | null;
  deliveryFailures: number | null;
}

const SEVERITY_DOT: Record<string, string> = {
  urgent: "bg-red-400",
  high: "bg-red-400",
  moderate: "bg-amber-400",
  low: "bg-[var(--text-secondary)]",
  info: "bg-[var(--text-secondary)]",
};

function relTime(ts: number): string {
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Read-only strip showing the EXACT last fired AdvisoryAction (from
 * /api/advisor/status → advisor/feedback.json). Never recomputes a prediction —
 * this displays what actually buzzed the phones, so a parent who just got an
 * alert sees the same words here.
 */
export function AdvisorStatusStrip() {
  const [status, setStatus] = useState<AdvisorStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/advisor/status")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled && d) setStatus(d);
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!status) return null;

  const fired = status.lastFired;
  const advisorStale =
    status.advisorLastRunAt != null &&
    Date.now() - status.advisorLastRunAt > 15 * 60_000;

  return (
    <div className="rounded-xl bg-[var(--bg-surface)] border border-[var(--border)] px-4 py-2.5 flex items-center gap-3 text-xs">
      <span className="font-medium text-[var(--text-secondary)] shrink-0">
        Advisor
      </span>
      {advisorStale ? (
        <span className="text-red-400 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
          Not running — last check {relTime(status.advisorLastRunAt!)}
        </span>
      ) : fired ? (
        // Past the 3h outcome-harvest horizon the event is history, not an
        // active concern — drop the severity color so a 12h-old urgent low
        // doesn't read as a live red alert on the dashboard.
        (() => {
          const isStale = Date.now() - fired.firedAt > 3 * 60 * 60_000;
          return (
            <span className="flex items-center gap-1.5 min-w-0">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  isStale
                    ? "bg-[var(--text-secondary)] opacity-50"
                    : SEVERITY_DOT[fired.advisory.severity] ??
                      "bg-[var(--text-secondary)]"
                }`}
              />
              {isStale && (
                <span className="text-[var(--text-secondary)] shrink-0">
                  Last:
                </span>
              )}
              <span
                className={`truncate ${
                  isStale
                    ? "text-[var(--text-secondary)]"
                    : "text-[var(--foreground)]"
                }`}
              >
                {fired.advisory.headline}
              </span>
              <span className="text-[var(--text-secondary)] shrink-0">
                {relTime(fired.firedAt)}
              </span>
            </span>
          );
        })()
      ) : (
        <span className="text-[var(--text-secondary)] flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          Watching — nothing fired
        </span>
      )}
      {status.advisorMode === "shadow" && (
        <span className="ml-auto shrink-0 rounded-full bg-amber-500/10 text-amber-400 px-2 py-0.5">
          shadow
        </span>
      )}
    </div>
  );
}
