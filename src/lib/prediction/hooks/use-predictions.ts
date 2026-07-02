"use client";

import { useState, useEffect, useRef } from "react";
import type { GlucoseReading, Treatment, PumpProfile } from "../../types";
import type { AGPSlot } from "../../trends";
import { computeAGP } from "../../trends";
import { extractSiteChanges } from "../../insulin-analysis";
import type { SiteChange } from "../../insulin-analysis";
import type { PredictionResult, PredictionSettings } from "../types";
import { generatePrediction } from "../prediction-engine";

interface UsePredictionsReturn {
  prediction: PredictionResult | null;
  isReady: boolean;
}

/**
 * Hook that runs the prediction engine on each data update.
 *
 * Fetches profile once on mount. AGP uses the readings already available
 * from the main hook (no separate 14-day fetch). Prediction runs on a
 * debounced schedule to avoid freezing the UI.
 */
export function usePredictions(
  readings: GlucoseReading[],
  treatments: Treatment[],
  settings: PredictionSettings
): UsePredictionsReturn {
  const [prediction, setPrediction] = useState<PredictionResult | null>(null);
  const [profile, setProfile] = useState<PumpProfile | null>(null);
  const [siteChanges, setSiteChanges] = useState<SiteChange[]>([]);
  const [isReady, setIsReady] = useState(false);

  // Use refs to avoid re-triggering effects on every render
  const readingsRef = useRef(readings);
  readingsRef.current = readings;
  const treatmentsRef = useRef(treatments);
  treatmentsRef.current = treatments;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Fetch profile once on mount
  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Site changes (fetch modest amount)
      try {
        const res = await fetch("/api/treatments?count=200&hours=168"); // 7 days
        if (res.ok) {
          const allTreatments: Treatment[] = await res.json();
          if (!cancelled) setSiteChanges(extractSiteChanges(allTreatments));
        }
      } catch {
        // Optional
      }

      // Profile from Nightscout
      try {
        const res = await fetch("/api/pump/profile");
        if (res.ok) {
          const data = await res.json();
          if (!cancelled && data.defaultProfile && data.store) {
            setProfile(data);
            setIsReady(true);
          }
        }
      } catch {
        // Can't predict without profile
      }
    }

    init();
    return () => { cancelled = true; };
  }, []);

  // Run prediction when readings update — skip if last prediction is recent
  const lastPredictionTime = useRef(0);
  const lastModelRef = useRef(settings.activeModel);
  const lastHorizonRef = useRef(settings.horizon);

  useEffect(() => {
    if (!isReady || !profile) return;

    // Reset cache when user changes model or horizon
    if (lastModelRef.current !== settings.activeModel || lastHorizonRef.current !== settings.horizon) {
      lastPredictionTime.current = 0;
      lastModelRef.current = settings.activeModel;
      lastHorizonRef.current = settings.horizon;
    }

    const timer = setTimeout(() => {
      // Skip if we predicted less than 3 minutes ago
      const elapsed = Date.now() - lastPredictionTime.current;
      if (elapsed < 180_000 && lastPredictionTime.current > 0) return;

      const currentReadings = readingsRef.current;
      const currentTreatments = treatmentsRef.current;
      const currentSettings = settingsRef.current;

      if (currentReadings.length < 3) return;

      // Compute AGP from whatever readings we already have (no extra fetch)
      const agpSlots = computeAGP(currentReadings);

      generatePrediction(
        currentReadings,
        currentTreatments,
        profile,
        agpSlots,
        siteChanges,
        null,
        currentSettings
      ).then((result) => {
        setPrediction(result);
        lastPredictionTime.current = Date.now();
      });
    }, 500); // 500ms debounce

    return () => clearTimeout(timer);
  }, [readings, isReady, profile, siteChanges, settings.activeModel, settings.horizon]);

  return { prediction, isReady };
}
