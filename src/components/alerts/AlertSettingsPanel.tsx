"use client";

import { useState, useEffect } from "react";

interface AlertSettings {
  rules: Record<string, boolean>;
  push: {
    enabled: boolean;
    quietHoursEnabled: boolean;
    quietHourStart: number;
    quietHourEnd: number;
    minSeverityForPush: "moderate" | "high";
  };
}

const RULE_LABELS: Record<string, string> = {
  site_sustained_high:     "Sustained high / ketone risk",
  site_failed_corrections: "Failed correction boluses",
  site_autobolus_stacking: "Control-IQ auto-bolus stacking",
  site_rising_with_iob:    "Rising BG despite active IOB",
  cgm_noise:               "CGM noise alerts",
  cgm_gaps:                "CGM signal gaps",
  cgm_stuck:               "CGM stuck readings",
  cgm_compression:         "Compression lows",
};
// site_age / cgm_sensor_aging / cgm_warmup toggles removed 2026-07-02: Phase-0
// backtesting proved those rules never fire, so the toggles were dead UI.

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${
        on ? "bg-[var(--accent)]" : "bg-[var(--bg-elevated)]"
      }`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
          on ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

interface AlertTopology {
  advisor: {
    mode: string | null;
    lastRunAt: number | null;
    rules: Array<{ id: string; label: string; delivery: string }>;
  };
  iosGlucose: {
    cadence: string;
    devices: Array<{
      device: string;
      tokenSuffix: string;
      thresholds: { urgentLow: number; low: number; high: number; urgentHigh: number };
    }>;
  };
}

function StateDot({ enabled }: { enabled: boolean | null }) {
  const color =
    enabled === null
      ? "bg-[var(--text-secondary)] opacity-40"
      : enabled
        ? "bg-emerald-400"
        : "bg-red-400";
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${color}`} />;
}

/** Read-only view of every alert path that can actually reach a phone. */
function LiveAlertTopology() {
  const [topo, setTopo] = useState<AlertTopology | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch("/api/alerts/topology")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setTopo)
      .catch(() => setFailed(true));
  }, []);

  if (failed) return null;
  if (!topo) {
    return (
      <div className="text-xs text-[var(--text-secondary)] py-2">
        Loading live alert status…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Advisor (smart alerts) */}
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
            Smart alerts — this app → iPhones
          </span>
          {topo.advisor.mode && (
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded ${
                topo.advisor.mode === "live"
                  ? "bg-emerald-500/10 text-emerald-400"
                  : "bg-amber-500/10 text-amber-400"
              }`}
            >
              {topo.advisor.mode}
            </span>
          )}
        </div>
        <div className="space-y-1">
          {topo.advisor.rules.map((r) => (
            <div key={r.id} className="flex gap-2 items-start">
              <StateDot enabled={topo.advisor.mode === "live"} />
              <div className="text-xs">
                <span className="text-[var(--foreground)]">{r.label}</span>
                <span className="text-[var(--text-secondary)]"> — {r.delivery}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* iOS threshold alerts */}
      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-1.5">
          Glucose threshold alerts — per device ({topo.iosGlucose.cadence})
        </div>
        <div className="space-y-1">
          {topo.iosGlucose.devices.map((d) => (
            <div key={d.tokenSuffix} className="flex gap-2 items-start">
              <StateDot enabled={true} />
              <div className="text-xs text-[var(--text-secondary)]">
                <span className="text-[var(--foreground)]">
                  {d.device} (…{d.tokenSuffix})
                </span>{" "}
                — urgent low &lt;{d.thresholds.urgentLow}, low &lt;{d.thresholds.low},
                high ≥{d.thresholds.high}, urgent ≥{d.thresholds.urgentHigh}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function AlertSettingsPanel() {
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string>("Auto-saved");

  useEffect(() => {
    fetch("/api/alerts/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setSettings(d); })
      .catch(() => {});
  }, []);

  const save = async (updated: AlertSettings) => {
    setSaving(true);
    try {
      const res = await fetch("/api/alerts/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      });
      if (res.ok) {
        setSettings(await res.json());
        setSaveStatus("Saved");
      } else {
        const body = await res.json().catch(() => ({}));
        setSaveStatus(`Error ${res.status}: ${(body as {error?: string}).error ?? "unknown"}`);
      }
    } catch {
      setSaveStatus("Network error");
    } finally {
      setSaving(false);
    }
  };

  const toggleRule = (key: string) => {
    if (!settings) return;
    const updated = { ...settings, rules: { ...settings.rules, [key]: !settings.rules[key] } };
    setSettings(updated);
    save(updated);
  };

  if (!settings) {
    return (
      <div className="text-sm text-[var(--text-secondary)] py-8 text-center">
        Loading settings…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* What actually fires and where — the source of truth */}
      <LiveAlertTopology />

      <div className="border-t border-[var(--border)] pt-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
            In-app detection log
          </div>
          <div className="text-xs text-[var(--text-secondary)]">
            {saving ? "Saving…" : saveStatus}
          </div>
        </div>
        <div className="text-[11px] text-[var(--text-secondary)]">
          These toggles filter the website&apos;s site/CGM detection log only —
          they do NOT affect the phone alerts shown above.
        </div>

        <div className="space-y-2">
          {Object.entries(RULE_LABELS).map(([key, label]) => (
            <label
              key={key}
              className="flex items-center justify-between gap-3 cursor-pointer group"
            >
              <span className="text-sm text-[var(--text-secondary)] group-hover:text-[var(--foreground)] transition-colors">
                {label}
              </span>
              <Toggle on={!!settings.rules[key]} onToggle={() => toggleRule(key)} />
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
