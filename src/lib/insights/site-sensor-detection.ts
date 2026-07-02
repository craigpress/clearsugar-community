/**
 * ClearSugar — Infusion Site Failure & CGM Sensor Issue Detection
 *
 * Based on clinical literature, Tandem/Dexcom documentation, and T1D
 * community experience. Sources documented in docs/SITE_CGM_FAILURE_DETECTION.md
 *
 * IMPORTANT: Gate site failure alerts behind sensor quality checks —
 * don't flag "failing site" when the CGM itself is noisy.
 *
 * Nightscout data notes (confirmed 2026-04-07):
 * - All treatments: enteredBy "Pump (tconnectsync)"
 * - Bolus type identified by `notes` field:
 *   "Automatic Bolus" = Control-IQ auto-correction
 *   "Standard Bolus (Override)" = manual correction/override
 * - `treatment.glucose` = BG reading from pump screen at time of bolus
 * - `Sensor Start` eventType with reason "CGM Session Joined" = sensor insertion
 */

import type { GlucoseReading, Treatment } from "../types";
import { calculateIOBForAutosens } from "../prediction/physiological-model";
import { localHour } from "../time";

export interface DetectionAlert {
  id: string;
  title: string;
  severity: "positive" | "low" | "moderate" | "high";
  description: string;
  suggestion: string;
}

// ── CGM Sensor Quality ──

interface SensorQuality {
  noiseLevel: "clean" | "light" | "medium" | "heavy";
  noiseScore: number;
  gapCount: number;
  longestGapMin: number;
  stuckReadings: boolean;
  compressionLows: number;
  sensorAgeHours: number | null;
}

function assessSensorQuality(readings: GlucoseReading[], treatments: Treatment[]): SensorQuality {
  const sorted = [...readings].sort((a, b) => a.date - b.date);

  // Noise: mean absolute difference between consecutive readings
  let totalDiff = 0;
  let diffCount = 0;
  for (let i = 1; i < sorted.length; i++) {
    const timeDiff = (sorted[i].date - sorted[i - 1].date) / 60_000;
    if (timeDiff > 0 && timeDiff < 10) { // only consecutive 5-min readings
      const d = Math.abs(sorted[i].sgv - sorted[i - 1].sgv);
      totalDiff += d;
      diffCount++;
    }
  }
  const noiseScore = diffCount > 0 ? totalDiff / diffCount : 0;
  const noiseLevel: SensorQuality["noiseLevel"] =
    noiseScore < 4 ? "clean" : noiseScore < 10 ? "light" : noiseScore < 20 ? "medium" : "heavy";

  // Gaps: consecutive readings more than 10 min apart
  let gapCount = 0;
  let longestGapMin = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i].date - sorted[i - 1].date) / 60_000;
    if (gap > 10) {
      gapCount++;
      longestGapMin = Math.max(longestGapMin, gap);
    }
  }

  // Stuck readings: same value ±1 for 6+ consecutive readings outside 80-120
  let stuckReadings = false;
  let stuckCount = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].sgv - sorted[i - 1].sgv) <= 1) {
      stuckCount++;
      if (stuckCount >= 6 && (sorted[i].sgv < 80 || sorted[i].sgv > 120)) {
        stuckReadings = true;
        break;
      }
    } else {
      stuckCount = 1;
    }
  }

  // Compression lows: rapid drop >40 in 15 min during sleep hours, was stable before
  let compressionLows = 0;
  for (let i = 3; i < sorted.length; i++) {
    const h = localHour(sorted[i].date);
    if (h < 6 || h >= 22) { // sleep hours
      const drop = sorted[i - 3].sgv - sorted[i].sgv;
      const timeDiff = (sorted[i].date - sorted[i - 3].date) / 60_000;
      if (drop > 40 && timeDiff <= 15 && timeDiff > 0) {
        const priorWindow = sorted.slice(Math.max(0, i - 9), i - 3);
        if (priorWindow.length >= 3) {
          const priorValues = priorWindow.map((r) => r.sgv);
          const priorMean = priorValues.reduce((s, v) => s + v, 0) / priorValues.length;
          const priorCV = Math.sqrt(priorValues.reduce((s, v) => s + (v - priorMean) ** 2, 0) / priorValues.length) / priorMean * 100;
          if (priorCV < 10) {
            compressionLows++;
          }
        }
      }
    }
  }

  // Sensor age: find most recent Sensor Start treatment
  const sensorStarts = treatments
    .filter((t) => t.eventType === "Sensor Start")
    .map((t) => new Date(t.created_at || t.mills || 0).getTime())
    .filter((ts) => ts > 0)
    .sort((a, b) => b - a);

  const now = sorted.length > 0 ? sorted[sorted.length - 1].date : Date.now();
  const sensorAgeHours = sensorStarts.length > 0
    ? (now - sensorStarts[0]) / 3_600_000
    : null;

  return { noiseLevel, noiseScore, gapCount, longestGapMin, stuckReadings, compressionLows, sensorAgeHours };
}

// ── Site Failure Detection ──

function detectSiteFailures(
  readings: GlucoseReading[],
  treatments: Treatment[],
  sensorQuality: SensorQuality,
): DetectionAlert[] {
  const alerts: DetectionAlert[] = [];
  const sorted = [...readings].sort((a, b) => a.date - b.date);

  // Don't trigger site alerts if CGM is very noisy
  if (sensorQuality.noiseLevel === "heavy") return alerts;

  // Rule 3: Sustained highs — >250 for 5+ hours or >300 for 1.5+ hours
  let highStart: number | null = null;
  let veryHighStart: number | null = null;
  let maxSustainedHigh = 0;
  let maxSustainedVeryHigh = 0;

  for (const r of sorted) {
    if (r.sgv > 250) {
      if (!highStart) highStart = r.date;
      const duration = (r.date - highStart) / 3_600_000;
      maxSustainedHigh = Math.max(maxSustainedHigh, duration);
    } else {
      highStart = null;
    }
    if (r.sgv > 300) {
      if (!veryHighStart) veryHighStart = r.date;
      const duration = (r.date - veryHighStart) / 3_600_000;
      maxSustainedVeryHigh = Math.max(maxSustainedVeryHigh, duration);
    } else {
      veryHighStart = null;
    }
  }

  if (maxSustainedVeryHigh >= 1.5) {
    alerts.push({
      id: "ketone_risk",
      title: `URGENT: ${Math.round(maxSustainedVeryHigh * 60)} min above 300 mg/dL`,
      severity: "high",
      description: `Glucose was above 300 mg/dL for ${Math.round(maxSustainedVeryHigh * 60)} minutes continuously. This increases ketone risk.`,
      suggestion: "Check ketones immediately when this happens. Give injection via syringe/pen and change infusion site.",
    });
  } else if (maxSustainedHigh >= 5) {
    alerts.push({
      id: "sustained_high_site",
      title: `Sustained High: ${Math.round(maxSustainedHigh)} hours above 250 despite insulin`,
      severity: "high",
      description: `Glucose remained above 250 mg/dL for ${Math.round(maxSustainedHigh)} hours. Insulin delivery may not be reaching the body.`,
      suggestion: "This pattern often indicates site failure. Change site and give correction via syringe/pen.",
    });
  }

  // Rule 2: Failed correction boluses — manual overrides that didn't lower BG
  // tconnectsync: notes "Standard Bolus (Override)" = manual correction/override
  const manualCorrections = treatments.filter(
    (t) => t.eventType === "Combo Bolus" &&
      t.notes?.includes("Override") &&
      !t.carbs &&
      (t.glucose ?? 0) > 180 // only count corrections from elevated BG
  );

  let failedCorrectionCount = 0;
  const windowStart8h = (sorted.length > 0 ? sorted[sorted.length - 1].date : Date.now()) - 8 * 3_600_000;

  for (const corr of manualCorrections) {
    const corrTime = new Date(corr.created_at || corr.mills || 0).getTime();
    if (corrTime < windowStart8h) continue;

    // Look for BG 90-120 min after correction
    const targetTime = corrTime + 100 * 60_000;
    const bgAfter = sorted.find((r) => Math.abs(r.date - targetTime) < 20 * 60_000);
    if (!bgAfter) continue;

    const bgBefore = corr.glucose ?? 0;
    const drop = bgBefore - bgAfter.sgv;

    // Failed if BG still >250 AND dropped <30 mg/dL
    if (bgAfter.sgv > 250 && drop < 30) {
      failedCorrectionCount++;
    }
  }

  if (failedCorrectionCount >= 2) {
    alerts.push({
      id: "failed_corrections",
      title: `${failedCorrectionCount} Correction Boluses Failed to Lower Glucose`,
      severity: "high",
      description: `${failedCorrectionCount} manual correction boluses in the past 8 hours did not meaningfully lower glucose (BG remained above 250 mg/dL). Insulin may not be absorbing from the current site.`,
      suggestion: "Give correction via syringe or pen and change the infusion site. Do not stack more pump corrections.",
    });
  }

  // Rule 4: Control-IQ auto-bolus stacking — 3+ auto-corrections in 3h with BG still >180
  // tconnectsync: notes "Automatic Bolus" = Control-IQ auto-correction
  const autoBoluses = treatments
    .filter((t) => t.eventType === "Combo Bolus" && t.notes === "Automatic Bolus")
    .map((t) => ({ time: new Date(t.created_at || t.mills || 0).getTime() }))
    .filter((t) => t.time > 0)
    .sort((a, b) => a.time - b.time);

  const windowMs3h = 3 * 3_600_000;
  let maxAutoBoluseInWindow = 0;
  let autoBolusBGHigh = false;
  let autoBolusCritical = false;

  for (let i = 0; i < autoBoluses.length; i++) {
    const windowEnd = autoBoluses[i].time;
    const windowStart = windowEnd - windowMs3h;
    const inWindow = autoBoluses.filter((b) => b.time >= windowStart && b.time <= windowEnd);
    if (inWindow.length >= 3) {
      maxAutoBoluseInWindow = Math.max(maxAutoBoluseInWindow, inWindow.length);
      // Check BG readings in this window
      const windowReadings = sorted.filter((r) => r.date >= windowStart && r.date <= windowEnd);
      if (windowReadings.length > 0) {
        const avgBG = windowReadings.reduce((s, r) => s + r.sgv, 0) / windowReadings.length;
        if (avgBG > 180) autoBolusBGHigh = true;
        if (windowReadings.some((r) => r.sgv > 300)) autoBolusCritical = true;
      }
    }
  }

  if (maxAutoBoluseInWindow >= 3 && autoBolusBGHigh) {
    alerts.push({
      id: "autobolus_stacking",
      title: `Control-IQ Gave ${maxAutoBoluseInWindow} Auto-Corrections Without Effect`,
      severity: autoBolusCritical ? "high" : "moderate",
      description: `Control-IQ delivered ${maxAutoBoluseInWindow} automatic correction boluses in a 3-hour window, but glucose remained above 180 mg/dL throughout. The pump is working but insulin may not be absorbing.`,
      suggestion: autoBolusCritical
        ? "URGENT: Give correction via syringe/pen and change site immediately. Check ketones."
        : "Consider a site change. Give next correction via injection rather than relying on the pump.",
    });
  }

  // Rule 5: Rising glucose despite significant IOB
  // Uses simplified Maksimovic IOB curve (DIA = 300 min)
  const DIA_MINUTES = 300;
  let risingWithIOBCount = 0;

  for (let i = 4; i < sorted.length; i++) {
    const windowReadings = sorted.slice(i - 4, i + 1); // 20 min window (5 readings)
    const rises = windowReadings.every((r, idx) =>
      idx === 0 || r.sgv - windowReadings[idx - 1].sgv > 3 // rising each step
    );
    if (!rises) continue;

    const totalRise = windowReadings[windowReadings.length - 1].sgv - windowReadings[0].sgv;
    if (totalRise < 20) continue; // need at least 20 mg/dL rise over 20 min

    const atTime = sorted[i].date;

    // Check for recent carbs (past 3h) — if carbs present, rising is expected
    const recentCarbs = treatments.some((t) => {
      if (!t.carbs) return false;
      const carbTime = new Date(t.created_at || t.mills || 0).getTime();
      return atTime - carbTime < 3 * 3_600_000 && carbTime <= atTime;
    });
    if (recentCarbs) continue;

    // Check for significant IOB
    const iob = calculateIOBForAutosens(treatments, DIA_MINUTES, atTime);
    if (iob >= 2) {
      risingWithIOBCount++;
    }
  }

  if (risingWithIOBCount >= 2) {
    alerts.push({
      id: "rising_with_iob",
      title: "Glucose Rising Despite Active Insulin on Board",
      severity: "moderate",
      description: `Glucose rose rapidly (>20 mg/dL in 20 min) on ${risingWithIOBCount} occasions when 2+ units of insulin were still active and no recent carbs were eaten. This can indicate site absorption failure.`,
      suggestion: "Check site for wetness or odor. If pattern repeats, change site and give correction by injection.",
    });
  }

  // Rule 6: Site age warning
  const siteChanges = treatments.filter((t) => t.eventType === "Site Change");
  if (siteChanges.length > 0) {
    const lastChange = siteChanges.reduce((latest, sc) => {
      const t = new Date(sc.created_at || sc.mills || 0).getTime();
      return t > latest ? t : latest;
    }, 0);
    const now = sorted.length > 0 ? sorted[sorted.length - 1].date : Date.now();
    const siteAgeHours = (now - lastChange) / 3_600_000;

    if (siteAgeHours > 72) {
      const recentHighs = sorted.filter((r) => r.date > now - 6 * 3_600_000 && r.sgv > 200);
      const recentTotal = sorted.filter((r) => r.date > now - 6 * 3_600_000);
      if (recentHighs.length > recentTotal.length * 0.3) {
        alerts.push({
          id: "old_site_highs",
          title: `Site is ${Math.round(siteAgeHours)}h old with rising highs`,
          severity: "moderate",
          description: `Infusion site is ${Math.round(siteAgeHours)} hours old (over 3 days) and ${Math.round(recentHighs.length / Math.max(recentTotal.length, 1) * 100)}% of recent readings are above 200. Absorption typically degrades after day 3.`,
          suggestion: "Change the infusion site. Consider proactively changing every 2.5-3 days if this pattern repeats.",
        });
      } else {
        alerts.push({
          id: "old_site",
          title: `Site Age: ${Math.round(siteAgeHours)} hours`,
          severity: "low",
          description: `Current infusion site is ${Math.round(siteAgeHours)} hours old. While glucose is currently stable, absorption can degrade unpredictably after 72h.`,
          suggestion: "Plan a site change soon.",
        });
      }
    }
  }

  return alerts;
}

// ── CGM Sensor Alerts ──

function detectSensorIssues(
  readings: GlucoseReading[],
  sensorQuality: SensorQuality,
): DetectionAlert[] {
  const alerts: DetectionAlert[] = [];
  const { sensorAgeHours } = sensorQuality;

  // CGM Rule 6: First-day warmup — suppress other alerts during this window
  const inWarmup = sensorAgeHours !== null && sensorAgeHours < 6;
  if (inWarmup) {
    alerts.push({
      id: "sensor_warmup",
      title: "New Sensor Warming Up",
      severity: "positive",
      description: `Sensor inserted ${Math.round((sensorAgeHours ?? 0) * 60)} minutes ago. G7 readings are often jumpy during the first 6 hours as the sensor equilibrates.`,
      suggestion: "Verify BG with fingerstick before treating lows or giving corrections. Readings typically stabilize within 2-6 hours.",
    });
    return alerts; // suppress other sensor alerts during warmup
  }

  // CGM Rule 5: End-of-sensor-life degradation
  if (sensorAgeHours !== null) {
    if (sensorAgeHours > 240) { // >10 days (past rated 10-day life)
      alerts.push({
        id: "sensor_aging",
        title: `Sensor Past 10-Day Life (${Math.round(sensorAgeHours / 24 * 10) / 10} days old)`,
        severity: "moderate",
        description: `The G7 sensor is past its 10-day rated life. Accuracy typically degrades and signal gaps increase beyond this point.`,
        suggestion: "Replace sensor now. Have a backup ready.",
      });
    } else if (sensorAgeHours > 216 && (sensorQuality.noiseScore > 8 || sensorQuality.gapCount > 3)) {
      // >9 days AND showing signs of degradation
      alerts.push({
        id: "sensor_aging",
        title: `Sensor Nearing End of Life (${Math.round(sensorAgeHours / 24 * 10) / 10} days)`,
        severity: "low",
        description: `Sensor is ${Math.round(sensorAgeHours / 24 * 10) / 10} days old and showing signs of wear (noise score: ${Math.round(sensorQuality.noiseScore)}, gaps: ${sensorQuality.gapCount}). G7 accuracy can decline in the last day or two.`,
        suggestion: "Have a replacement sensor ready. Change proactively if readings seem off.",
      });
    }
  }

  // Noise level
  if (sensorQuality.noiseLevel === "heavy") {
    alerts.push({
      id: "cgm_heavy_noise",
      title: `CGM Very Noisy (noise score: ${Math.round(sensorQuality.noiseScore)})`,
      severity: "high",
      description: `CGM readings are jumping ${Math.round(sensorQuality.noiseScore)} mg/dL between consecutive readings on average. Data is unreliable for treatment decisions.`,
      suggestion: "Verify with fingerstick before bolusing or treating lows. Sensor may need replacement.",
    });
  } else if (sensorQuality.noiseLevel === "medium") {
    alerts.push({
      id: "cgm_medium_noise",
      title: `CGM Moderately Noisy (noise score: ${Math.round(sensorQuality.noiseScore)})`,
      severity: "moderate",
      description: `CGM readings are averaging ${Math.round(sensorQuality.noiseScore)} mg/dL variation between readings. Some readings may be inaccurate.`,
      suggestion: "Confirm with fingerstick before making large corrections. Monitor if noise increases.",
    });
  }

  // Signal gaps
  if (sensorQuality.longestGapMin >= 60) {
    alerts.push({
      id: "cgm_long_gap",
      title: `CGM Signal Lost for ${Math.round(sensorQuality.longestGapMin)} min`,
      severity: "high",
      description: `Longest signal gap was ${Math.round(sensorQuality.longestGapMin)} minutes. ${sensorQuality.gapCount} total gaps detected.`,
      suggestion: "Check sensor placement and phone/receiver proximity. Frequent long gaps may indicate sensor failure.",
    });
  } else if (sensorQuality.gapCount >= 5) {
    alerts.push({
      id: "cgm_frequent_gaps",
      title: `${sensorQuality.gapCount} CGM Signal Gaps`,
      severity: "moderate",
      description: `${sensorQuality.gapCount} gaps in CGM data (longest: ${Math.round(sensorQuality.longestGapMin)} min). Frequent gaps reduce Control-IQ effectiveness.`,
      suggestion: "Keep phone/receiver within 20 feet. If gaps persist, sensor may be failing.",
    });
  }

  // Stuck readings
  if (sensorQuality.stuckReadings) {
    alerts.push({
      id: "cgm_stuck",
      title: "CGM Appears Stuck",
      severity: "moderate",
      description: "Sensor returned the same value for 30+ minutes outside the normal range. This is not physiologically normal.",
      suggestion: "Verify with fingerstick. Sensor may need replacement.",
    });
  }

  // Compression lows (suppressed during warmup — already returned above)
  if (sensorQuality.compressionLows >= 2) {
    alerts.push({
      id: "cgm_compression",
      title: `${sensorQuality.compressionLows} Compression Lows Detected`,
      severity: "moderate",
      description: `${sensorQuality.compressionLows} overnight episodes where glucose dropped rapidly from stable levels — classic compression low pattern (sleeping on sensor).`,
      suggestion: "These are false lows caused by pressure on the sensor. Try wearing the sensor on the arm instead of abdomen, or avoid sleeping directly on the sensor side.",
    });
  } else if (sensorQuality.compressionLows === 1) {
    alerts.push({
      id: "cgm_compression",
      title: "Possible Compression Low Detected",
      severity: "low",
      description: "One overnight episode where glucose dropped rapidly from stable levels — may be a compression low (sleeping on sensor).",
      suggestion: "If this recurs, consider sensor placement on the arm or non-dominant sleeping side.",
    });
  }

  // All clear
  if (alerts.length === 0 && sensorQuality.noiseLevel === "clean" && sensorQuality.gapCount <= 1) {
    alerts.push({
      id: "cgm_quality_good",
      title: "CGM Signal Quality: Good",
      severity: "positive",
      description: `Low noise (${Math.round(sensorQuality.noiseScore)} mg/dL avg variation), minimal gaps. Data is reliable.`,
      suggestion: "Sensor is performing well.",
    });
  }

  return alerts;
}

// ── Public API ──

export function detectSiteAndSensorIssues(
  readings: GlucoseReading[],
  treatments: Treatment[],
): DetectionAlert[] {
  const sensorQuality = assessSensorQuality(readings, treatments);

  // Sensor alerts first (since they gate site alerts)
  const sensorAlerts = detectSensorIssues(readings, sensorQuality);
  const siteAlerts = detectSiteFailures(readings, treatments, sensorQuality);

  return [...siteAlerts, ...sensorAlerts];
}

// ── Data-quality counts (informational only — does NOT mutate readings) ──

export interface SensorDataQualityCounts {
  /** Readings that fall within a CGM warmup window (<6h after a Sensor Start). */
  warmupReadings: number;
  /** Number of detected overnight compression-low episodes. */
  compressionLows: number;
}

/**
 * Count readings likely affected by sensor warmup or compression-low artifacts.
 * Purely informational — it never removes or alters readings, so clinical stats
 * (TIR, lows) are untouched. Intended to annotate the data-quality note.
 */
export function countSensorDataQualityIssues(
  readings: GlucoseReading[],
  treatments: Treatment[],
): SensorDataQualityCounts {
  const sorted = [...readings].sort((a, b) => a.date - b.date);

  // Warmup windows: 6h after each Sensor Start
  const sensorStarts = treatments
    .filter((t) => t.eventType === "Sensor Start")
    .map((t) => new Date(t.created_at || t.mills || 0).getTime())
    .filter((ts) => ts > 0);

  let warmupReadings = 0;
  if (sensorStarts.length > 0) {
    const warmupMs = 6 * 3_600_000;
    for (const r of sorted) {
      if (sensorStarts.some((s) => r.date >= s && r.date < s + warmupMs)) {
        warmupReadings++;
      }
    }
  }

  // Compression lows: reuse the same detection as assessSensorQuality
  const { compressionLows } = assessSensorQuality(readings, treatments);

  return { warmupReadings, compressionLows };
}
