"use client";

import { motion, AnimatePresence } from "framer-motion";
import type {
  PredictionModel,
  PredictionHorizon,
  PredictionSettings as PredictionSettingsType,
  ModelMetadata,
} from "@/lib/prediction/types";

interface PredictionSettingsProps {
  open: boolean;
  onClose: () => void;
  settings: PredictionSettingsType;
  onSetModel: (model: PredictionModel) => void;
  onSetHorizon: (horizon: PredictionHorizon) => void;
  onToggleChart: () => void;
  onToggleHero: () => void;
  modelMeta?: ModelMetadata | null;
}

export function PredictionSettings({
  open,
  onClose,
  settings,
  onSetModel,
  onSetHorizon,
  onToggleChart,
  onToggleHero,
  modelMeta,
}: PredictionSettingsProps) {
  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 bg-black/40 z-40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          {/* Panel */}
          <motion.div
            className="fixed right-0 top-0 h-full w-80 bg-[var(--bg-surface)] border-l border-[var(--border)] z-50 overflow-y-auto"
            initial={{ x: 320 }}
            animate={{ x: 0 }}
            exit={{ x: 320 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
          >
            <div className="p-4 space-y-6">
              {/* Header */}
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-[var(--foreground)]">
                  Prediction Settings
                </h2>
                <button
                  onClick={onClose}
                  className="text-[var(--text-secondary)] hover:text-[var(--foreground)] text-lg"
                >
                  ×
                </button>
              </div>

              {/* Model selector */}
              <Section title="Model">
                <div className="flex gap-1">
                  {(
                    [
                      ["physiological", "Physics"],
                      ["ml", "ML"],
                      ["ensemble", "Ensemble"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      onClick={() => onSetModel(value)}
                      className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        settings.activeModel === value
                          ? "bg-[var(--accent)] text-white"
                          : "text-[var(--text-secondary)] bg-[var(--bg-elevated)] hover:text-[var(--foreground)]"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-[var(--text-tertiary)] mt-1">
                  {settings.activeModel === "physiological"
                    ? "IOB + COB + trend momentum"
                    : settings.activeModel === "ml"
                      ? "LightGBM trained on your data"
                      : "Weighted blend of both models"}
                </p>
              </Section>

              {/* Horizon selector */}
              <Section title="Prediction Horizon">
                <div className="flex gap-1">
                  {([15, 30, 60, 180] as const).map((h) => (
                    <button
                      key={h}
                      onClick={() => onSetHorizon(h)}
                      className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        settings.horizon === h
                          ? "bg-[var(--accent)] text-white"
                          : "text-[var(--text-secondary)] bg-[var(--bg-elevated)] hover:text-[var(--foreground)]"
                      }`}
                    >
                      {h === 180 ? "3h" : `${h}m`}
                    </button>
                  ))}
                </div>
              </Section>

              {/* Display toggles */}
              <Section title="Display">
                <Toggle
                  label="Show on chart"
                  checked={settings.showOnChart}
                  onChange={onToggleChart}
                />
                <Toggle
                  label="Show on hero"
                  checked={settings.showOnHero}
                  onChange={onToggleHero}
                />
              </Section>

              {/* Notifications are handled server-side by the action-advisor
                  (push to phone), not by the browser — no client toggle here. */}

              {/* ML Model info */}
              {modelMeta && (
                <Section title="ML Model">
                  <div className="space-y-1 text-[10px] text-[var(--text-secondary)]">
                    <div>
                      Trained:{" "}
                      {new Date(modelMeta.trainedAt).toLocaleDateString()}
                    </div>
                    <div>Data: {modelMeta.trainingDays} days</div>
                    <div>
                      RMSE (30m):{" "}
                      {modelMeta.validationRMSE[30]?.toFixed(1) ?? "—"} mg/dL
                    </div>
                    {modelMeta.featureImportance && (
                      <div className="mt-2">
                        <div className="font-medium text-[var(--foreground)] mb-1">
                          Top features:
                        </div>
                        {Object.entries(modelMeta.featureImportance)
                          .sort(([, a], [, b]) => b - a)
                          .slice(0, 5)
                          .map(([name, importance]) => (
                            <div
                              key={name}
                              className="flex justify-between"
                            >
                              <span>{name}</span>
                              <span>
                                {(importance * 100).toFixed(0)}%
                              </span>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                </Section>
              )}

              {!modelMeta && settings.activeModel !== "physiological" && (
                <div className="text-[10px] text-amber-400/80 bg-amber-500/10 rounded-lg px-3 py-2">
                  ML model not yet trained. Run{" "}
                  <code className="font-[family-name:var(--font-geist-mono)]">
                    python scripts/train-model.py
                  </code>{" "}
                  to train on your data. Using physiological model as
                  fallback.
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] font-medium text-[var(--text-tertiary)] uppercase tracking-wider mb-2">
        {title}
      </div>
      {children}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex items-center justify-between py-1 cursor-pointer">
      <span className="text-xs text-[var(--text-secondary)]">{label}</span>
      <div
        onClick={onChange}
        className={`w-8 h-4.5 rounded-full relative transition-colors cursor-pointer ${
          checked ? "bg-[var(--accent)]" : "bg-[var(--bg-elevated)]"
        }`}
      >
        <div
          className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${
            checked ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </div>
    </label>
  );
}
