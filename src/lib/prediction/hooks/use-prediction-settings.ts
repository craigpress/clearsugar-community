"use client";

import { useState, useCallback } from "react";
import type { PredictionSettings, PredictionModel, PredictionHorizon } from "../types";
import { DEFAULT_PREDICTION_SETTINGS } from "../types";

const STORAGE_KEY = "clearsugar-prediction-settings";

function loadSettings(): PredictionSettings {
  if (typeof window === "undefined") return DEFAULT_PREDICTION_SETTINGS;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return DEFAULT_PREDICTION_SETTINGS;
    return { ...DEFAULT_PREDICTION_SETTINGS, ...JSON.parse(saved) };
  } catch {
    return DEFAULT_PREDICTION_SETTINGS;
  }
}

function saveSettings(settings: PredictionSettings) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function usePredictionSettings() {
  const [settings, setSettingsState] = useState<PredictionSettings>(loadSettings);

  const updateSettings = useCallback((patch: Partial<PredictionSettings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const setModel = useCallback(
    (model: PredictionModel) => updateSettings({ activeModel: model }),
    [updateSettings]
  );

  const setHorizon = useCallback(
    (horizon: PredictionHorizon) => updateSettings({ horizon }),
    [updateSettings]
  );

  const toggleChart = useCallback(
    () => updateSettings({ showOnChart: !settings.showOnChart }),
    [updateSettings, settings.showOnChart]
  );

  const toggleHero = useCallback(
    () => updateSettings({ showOnHero: !settings.showOnHero }),
    [updateSettings, settings.showOnHero]
  );

  return {
    settings,
    updateSettings,
    setModel,
    setHorizon,
    toggleChart,
    toggleHero,
  };
}
