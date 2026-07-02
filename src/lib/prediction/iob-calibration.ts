// ClearSugar — pump-IOB calibration (Option 2, SAFE / additive)
//
// The whole low-side advisor rests on ClearSugar's *computed* IOB (the
// Maksimovic curve in physiological-model.ts, whose temp-basal term uses a
// single average-age approximation). The Tandem BFF now exposes the pump's OWN
// IOB at each bolus/BG event (published to NS devicestatus by the CT-110
// clearsugar-pumpstate job). This module shadow-compares the two at the pump's
// timestamp to surface systematic drift. It changes NO threshold and feeds NO
// advisory — pure observability. If the bias is small the model is trustworthy;
// if it drifts, that is the signal to revisit the temp-basal IOB term.

import { calculateIOB } from "./physiological-model";
import { loadJSON, saveJSON } from "../local-store";
import type { PumpState, Treatment, PumpProfile } from "../types";

const CAL_KEY = "pump/iob-cal.json";

/**
 * Only compare when the pump-IOB sample is recent enough that the trailing
 * treatment window the caller fetched (≈8h) fully covers the sample's DIA
 * lookback (≈6h). A 2.5h cap keeps [sample−DIA, sample] inside an 8h fetch.
 */
export const MAX_SAMPLE_AGE_MS = 2.5 * 60 * 60 * 1000;

/** Keep a bounded rolling window of samples (one per distinct pump event). */
export const MAX_SAMPLES = 500;

export interface IobCalSample {
  /** Pump event time the IOB was read at (epoch ms) — the comparison anchor. */
  atMills: number;
  pumpIob: number; // units, pump ground truth
  computedIob: number; // units, ClearSugar Maksimovic at atMills
  biasU: number; // computed − pump (positive ⇒ ClearSugar over-estimates IOB)
  biasPct: number | null; // biasU / pumpIob × 100, null when pumpIob ≈ 0
  eventCode?: number;
  recordedAt: number; // when this sample was taken
}

export interface IobCalSummary {
  samples: number;
  meanBiasU: number;
  medianBiasU: number;
  meanBiasPct: number | null;
  /** Signed mean over the most recent 30 samples — drift detector. */
  recentMeanBiasU: number;
  lastSample: IobCalSample | null;
}

/**
 * Compute one calibration sample from the current pump-state doc, or null when
 * there is no usable pump IOB (missing doc, no iob, too old, or ≈0 with no
 * computed insulin either — nothing to learn).
 */
export function compareIob(
  pumpState: PumpState | null,
  treatments: Treatment[],
  profile: PumpProfile,
  now: number
): IobCalSample | null {
  const iob = pumpState?.pump?.iob;
  if (!iob || typeof iob.iob !== "number" || !Number.isFinite(iob.mills)) {
    return null;
  }
  if (now - iob.mills > MAX_SAMPLE_AGE_MS || iob.mills > now + 60_000) {
    return null; // too old to trust the treatment coverage, or future-dated
  }
  const pumpIob = iob.iob;
  const computedIob = calculateIOB(treatments, profile, iob.mills);
  const biasU = round3(computedIob - pumpIob);
  const biasPct = pumpIob > 0.05 ? round1((biasU / pumpIob) * 100) : null;
  return {
    atMills: iob.mills,
    pumpIob: round3(pumpIob),
    computedIob: round3(computedIob),
    biasU,
    biasPct,
    eventCode: iob.eventCode,
    recordedAt: now,
  };
}

// ── persistence (dedupe by atMills — the publisher re-writes the same event
//    IOB every 5 min until a new pump event, so only one sample per event) ──

export async function loadCalSamples(): Promise<IobCalSample[]> {
  return loadJSON<IobCalSample[]>(CAL_KEY, []);
}

/**
 * Record a sample if it is for a pump event we haven't logged yet. Returns true
 * when a NEW sample was appended, false when it was a duplicate (or null input).
 */
export async function recordCalSample(sample: IobCalSample | null): Promise<boolean> {
  if (!sample) return false;
  const samples = await loadCalSamples();
  if (samples.some((s) => s.atMills === sample.atMills)) return false;
  samples.push(sample);
  samples.sort((a, b) => a.atMills - b.atMills);
  const trimmed = samples.slice(-MAX_SAMPLES);
  await saveJSON(CAL_KEY, trimmed);
  return true;
}

export function summarize(samples: IobCalSample[]): IobCalSummary {
  if (samples.length === 0) {
    return {
      samples: 0,
      meanBiasU: 0,
      medianBiasU: 0,
      meanBiasPct: null,
      recentMeanBiasU: 0,
      lastSample: null,
    };
  }
  const biases = samples.map((s) => s.biasU);
  const pcts = samples.map((s) => s.biasPct).filter((p): p is number => p !== null);
  const recent = samples.slice(-30).map((s) => s.biasU);
  return {
    samples: samples.length,
    meanBiasU: round3(mean(biases)),
    medianBiasU: round3(median(biases)),
    meanBiasPct: pcts.length ? round1(mean(pcts)) : null,
    recentMeanBiasU: round3(mean(recent)),
    lastSample: samples[samples.length - 1],
  };
}

// ── small numeric helpers ──
function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
