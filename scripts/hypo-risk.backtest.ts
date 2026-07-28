/**
 * Backtest: does the IOB-only hypo-risk floor warn about real lows earlier or
 * more often than the existing blended prediction?
 *
 * Run:  npx vitest run --config scripts/backtest.vitest.config.ts
 * Data: tmp/bt/{entries,treatments,profile}.json  (gitignored)
 *
 * ⚠️ Pulling the data — `count` alone is NOT enough. Nightscout's /api/v1
 * applies a DEFAULT DATE WINDOW when no `find[date]` filter is given, so
 * `?count=6100` silently returns only the last few days no matter how large
 * count is. That mistake produced a 4-day sample and a badly overstated
 * lead-time result on 2026-07-28. Always pass an explicit lower bound:
 *
 *   GTE=$(python3 -c "import time; print(int((time.time()-365*86400)*1000))")
 *   curl "http://YOUR_NIGHTSCOUT_HOST:1337/api/v1/entries.json?find\[date\]\[\$gte\]=$GTE&count=500000" \
 *     -o tmp/bt/entries.json
 *   ISO=$(python3 -c "import time,datetime;print(datetime.datetime.fromtimestamp(time.time()-365*86400,datetime.UTC).isoformat())")
 *   curl "http://YOUR_NIGHTSCOUT_HOST:1337/api/v1/treatments.json?find\[created_at\]\[\$gte\]=$ISO&count=500000" \
 *     -o tmp/bt/treatments.json
 *   curl "http://YOUR_NIGHTSCOUT_HOST:1337/api/v1/profile.json" -o tmp/bt/profile.json
 *
 * As of 2026-07-28 that yields ~284 days / 78,590 readings / 501 low episodes.
 *
 * This is an evaluation harness, not a unit test — it asserts only that the
 * data loaded, and prints the comparison.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { predictHypoRisk } from "../src/lib/prediction/hypo-risk";
import { predictPhysiological } from "../src/lib/prediction/physiological-model";
import type { GlucoseReading, Treatment, PumpProfile } from "../src/lib/types";

const DIR = "tmp/bt";
const HORIZON_MIN = 60; // how far ahead we ask each model to look
const LOW = 70;
const MIN_HISTORY = 6; // readings needed before we evaluate a point

interface Outcome {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  leadTimes: number[];
}
const empty = (): Outcome => ({ tp: 0, fp: 0, fn: 0, tn: 0, leadTimes: [] });

function score(o: Outcome) {
  const sens = o.tp + o.fn ? o.tp / (o.tp + o.fn) : 0;
  const prec = o.tp + o.fp ? o.tp / (o.tp + o.fp) : 0;
  const lead = o.leadTimes.length
    ? o.leadTimes.reduce((a, b) => a + b, 0) / o.leadTimes.length
    : 0;
  return { sens, prec, lead };
}

function pct(x: number) {
  return `${(x * 100).toFixed(1)}%`;
}

describe("hypo-risk backtest", () => {
  it("compares the IOB-only floor against the blended prediction", () => {
    if (!existsSync(`${DIR}/entries.json`)) {
      console.log(`\n  SKIPPED — no data at ${DIR}/. Pull from Nightscout first.\n`);
      return;
    }

    const rawEntries = JSON.parse(readFileSync(`${DIR}/entries.json`, "utf8"));
    const rawTreatments = JSON.parse(readFileSync(`${DIR}/treatments.json`, "utf8"));
    const rawProfile = JSON.parse(readFileSync(`${DIR}/profile.json`, "utf8"));

    const readings: GlucoseReading[] = rawEntries
      .filter((e: { type?: string; sgv?: number }) => e.type === "sgv" && typeof e.sgv === "number")
      .map((e: Record<string, unknown>) => e as unknown as GlucoseReading)
      .sort((a: GlucoseReading, b: GlucoseReading) => a.date - b.date);

    const treatments: Treatment[] = rawTreatments.map((t: Record<string, unknown>) => ({
      ...t,
      mills: t.mills ?? new Date(t.created_at as string).getTime(),
    })) as Treatment[];

    const profile: PumpProfile = Array.isArray(rawProfile) ? rawProfile[0] : rawProfile;

    // Sort once. Filtering every treatment for every reading is O(n^2) and
    // intractable at 79k treatments x 78k readings; insulin older than
    // DIA + margin contributes exactly zero IOB, so a moving window is both
    // faster and equivalent.
    treatments.sort((a, b) => a.mills - b.mills);
    const IOB_WINDOW_MS = 8 * 60 * 60_000;
    let tLo = 0;
    let tHi = 0;

    expect(readings.length).toBeGreaterThan(100);
    expect(profile.store).toBeTruthy();

    const hypo = empty();
    const blended = empty();
    let evaluated = 0;
    // Per-point warning sequences, for episode counting below.
    const hypoWarnSeq: boolean[] = [];
    const blendedWarnSeq: boolean[] = [];
    const actualSeq: boolean[] = [];

    for (let i = MIN_HISTORY; i < readings.length; i++) {
      const now = readings[i].date;
      const history = readings.slice(Math.max(0, i - 36), i + 1); // ~3h of context
      while (tHi < treatments.length && treatments[tHi].mills <= now) tHi++;
      while (tLo < tHi && treatments[tLo].mills < now - IOB_WINDOW_MS) tLo++;
      const past = treatments.slice(tLo, tHi);

      // Ground truth: did glucose actually go below LOW within the horizon?
      const windowEnd = now + HORIZON_MIN * 60_000;
      let fEnd = i + 1;
      while (fEnd < readings.length && readings[fEnd].date <= windowEnd) fEnd++;
      if (fEnd === i + 1) continue;
      let actualLow: GlucoseReading | undefined;
      for (let k = i + 1; k < fEnd; k++) {
        if (readings[k].sgv < LOW) { actualLow = readings[k]; break; }
      }
      const actuallyWentLow = Boolean(actualLow);

      // Skip points that are ALREADY low — the question is early warning, and a
      // reading under 70 has already tripped the plain threshold alert.
      if (readings[i].sgv < LOW) continue;
      evaluated++;

      // --- model A: IOB-only floor ---
      const h = predictHypoRisk(history, past, profile, {
        horizonMinutes: HORIZON_MIN,
        lowThreshold: LOW,
      });
      const hypoWarns = h.minutesToLow !== null;

      // --- model B: existing blended prediction ---
      const b = predictPhysiological(history, past, profile, HORIZON_MIN as never);
      const blendedWarns = b.points.some((p) => p.sgv < LOW);

      hypoWarnSeq.push(hypoWarns);
      blendedWarnSeq.push(blendedWarns);
      actualSeq.push(actuallyWentLow);

      for (const [warns, o] of [
        [hypoWarns, hypo],
        [blendedWarns, blended],
      ] as const) {
        if (warns && actuallyWentLow) {
          o.tp++;
          o.leadTimes.push((actualLow!.date - now) / 60_000);
        } else if (warns && !actuallyWentLow) o.fp++;
        else if (!warns && actuallyWentLow) o.fn++;
        else o.tn++;
      }
    }

    const H = score(hypo);
    const B = score(blended);
    const days = (readings[readings.length - 1].date - readings[0].date) / 86_400_000;

    // Point-level FP counts are misleading: every 5-min reading inside one
    // sustained warning counts again. What actually buzzes a phone is an
    // EPISODE — a run of consecutive warnings, collapsed by a cooldown. Count
    // those instead, which is the number a parent would experience per day.
    const episodes = (marks: boolean[]) => {
      let n = 0;
      for (let i = 0; i < marks.length; i++) if (marks[i] && !marks[i - 1]) n++;
      return n;
    };
    const hypoEpisodes = episodes(hypoWarnSeq);
    const blendedEpisodes = episodes(blendedWarnSeq);
    const trueLowEpisodes = episodes(actualSeq);

    console.log(`
  ── hypo-risk backtest ──────────────────────────────────────────
  ${readings.length} readings over ${days.toFixed(1)} days; ${evaluated} points evaluated
  Question: at each non-low reading, will BG go <${LOW} within ${HORIZON_MIN} min?

                        IOB-only floor      blended prediction
  caught (TP)           ${String(hypo.tp).padEnd(19)} ${blended.tp}
  missed (FN)           ${String(hypo.fn).padEnd(19)} ${blended.fn}
  false alarms (FP)     ${String(hypo.fp).padEnd(19)} ${blended.fp}
  quiet + correct (TN)  ${String(hypo.tn).padEnd(19)} ${blended.tn}

  sensitivity           ${pct(H.sens).padEnd(19)} ${pct(B.sens)}
  precision             ${pct(H.prec).padEnd(19)} ${pct(B.prec)}
  mean lead time        ${(H.lead.toFixed(1) + " min").padEnd(19)} ${B.lead.toFixed(1)} min

  EPISODES (what actually buzzes a phone — consecutive warnings collapsed)
  real low episodes     ${trueLowEpisodes}
  warning episodes      ${String(hypoEpisodes).padEnd(19)} ${blendedEpisodes}
  per day               ${String((hypoEpisodes / days).toFixed(1)).padEnd(19)} ${(blendedEpisodes / days).toFixed(1)}
  ─────────────────────────────────────────────────────────────────
`);
  });
});
