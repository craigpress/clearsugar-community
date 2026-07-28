/**
 * Sweep: where should the IOB-only hypo floor's trigger sit?
 *
 * `hypo-risk.backtest.ts` answered "is the floor better than the blended
 * prediction" (yes) at ONE operating point that is far too noisy to alert on:
 * 5.2 warning episodes/day against ~1.8 real lows/day. This script picks the
 * operating point.
 *
 * Run:  npx vitest run --config scripts/backtest.vitest.config.ts \
 *         scripts/hypo-risk.sweep.backtest.ts
 * Data: tmp/bt/{entries,treatments,profile}.json  (gitignored — see the pull
 *       commands at the top of hypo-risk.backtest.ts; `count` alone is NOT
 *       enough, you must pass find[date]).
 * Env:  LIMIT=<n>   evaluate only the first n readings (fast smoke run)
 *       BASELINE=0  skip the current-advisory baseline (it is the slow part)
 *
 * ── What this measures, and why it is not the earlier script's metric ────────
 *
 * The earlier backtest scored POINTS: every 5-min reading inside one sustained
 * warning counted again, so a single 90-minute warning run scored as 18 false
 * positives. That number describes nothing a human experiences.
 *
 * This scores ALERTS and EPISODES:
 *   • An ALERT is what buzzes a phone — warnings collapsed by a cooldown.
 *   • An EPISODE is a real low: a maximal run of readings under 70.
 *   • precision = alerts that preceded a real low / all alerts.
 *   • recall    = real low episodes that got an alert first / all low episodes.
 * Recall is EPISODE-level on purpose. Point-level recall rewards a model for
 * warning repeatedly about one low it already caught; a parent is warned once.
 *
 * ── The loss function is deliberately asymmetric ─────────────────────────────
 *
 * Missing a low here is cheap and false-alarming is expensive, which is the
 * opposite of the usual medical default. That is only true because this floor
 * is an EARLY-WARNING layer sitting on top of independent always-on safety
 * nets — the CGM's own alarms, the server threshold alerts, and the iOS
 * backstop. A low this misses still
 * alarms, just later and without lead time. A low this invents is pure noise,
 * and noise is what teaches a family to ignore the phone.
 *
 * So the headline column is FALSE ALERTS PER DAY, not sensitivity.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { predictHypoRisk } from "../src/lib/prediction/hypo-risk";
import { evaluateLowTrigger } from "../src/lib/prediction/loop-gap-trigger";
import type { GlucoseReading, Treatment, PumpProfile } from "../src/lib/types";

const DIR = "tmp/bt";
const OUT = "tmp/bt/sweep-results.json";

/** How far ahead the ground truth looks. Fixed across every config so the
 *  numbers stay comparable when the detector's own horizon is swept. */
const GT_WINDOW_MIN = 60;
const LOW = 70;
/** Model the floor once at the widest horizon; every narrower horizon is a
 *  prefix of the same curve, so one evaluation serves the whole sweep. */
const MAX_HORIZON_MIN = 60;
const STEPS = MAX_HORIZON_MIN / 5;
const MIN_HISTORY = 6;
/** Consecutive readings more than this far apart are not consecutive — sensor
 *  changes and dropouts must not be read as one continuous run. */
const GAP_BREAK_MIN = 20;
/** Warnings within this of the last alert do not buzz again. */
const COOLDOWN_MIN = 30;
/** Local hours counted as night. Overnight false wakes are the expensive ones. */
const NIGHT_START = 22;
const NIGHT_END = 7;

const IOB_WINDOW_MS = 8 * 60 * 60_000;
const MIN_MS = 60_000;

// ── config space ──────────────────────────────────────────────────────────────
const HORIZONS = [30, 45, 60];
const THRESHOLDS = [55, 60, 65, 70];
/** Require the floor to go this far BELOW the threshold before firing — kills
 *  the "dipped one mg/dL under and recovered" class of alert. */
const MARGINS = [0, 5, 10];
/** Require N consecutive qualifying readings. The floor's runs are already
 *  long, so this should cost little recall. */
const CONSECUTIVE = [1, 2, 3];
/** Only warn when current BG is at or below this. The floor is chained from the
 *  present reading, so at BG 260 with a meal bolus aboard it will happily
 *  project 50 — technically true of the insulin alone, but an hour of other
 *  things happens first. A ceiling asks "is the low actually within reach?" */
const BG_CEILINGS = [400, 180, 150, 120];

interface Config {
  horizon: number;
  threshold: number;
  margin: number;
  consecutive: number;
  bgCeiling: number;
}

interface Metrics {
  alerts: number;
  alertsPerDay: number;
  truePos: number;
  falsePos: number;
  falseAlertsPerDay: number;
  precision: number;
  episodesCaught: number;
  episodesTotal: number;
  recall: number;
  severeCaught: number;
  severeRecall: number;
  meanLead: number;
  medianLead: number;
  nightAlerts: number;
  nightFalsePerNight: number;
}

function isNight(ms: number): boolean {
  const h = new Date(ms).getHours();
  return h >= NIGHT_START || h < NIGHT_END;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

describe("hypo-risk trigger sweep", () => {
  it("finds the operating point that minimises false alerts", () => {
    if (!existsSync(`${DIR}/entries.json`)) {
      console.log(`\n  SKIPPED — no data at ${DIR}/. Pull from Nightscout first.\n`);
      return;
    }

    // ── load ──────────────────────────────────────────────────────────────────
    const rawEntries = JSON.parse(readFileSync(`${DIR}/entries.json`, "utf8"));
    const rawTreatments = JSON.parse(readFileSync(`${DIR}/treatments.json`, "utf8"));
    const rawProfile = JSON.parse(readFileSync(`${DIR}/profile.json`, "utf8"));

    let readings: GlucoseReading[] = rawEntries
      .filter((e: { type?: string; sgv?: number }) => e.type === "sgv" && typeof e.sgv === "number")
      .map((e: Record<string, unknown>) => e as unknown as GlucoseReading)
      .sort((a: GlucoseReading, b: GlucoseReading) => a.date - b.date);

    const limit = Number(process.env.LIMIT ?? 0);
    if (limit > 0) readings = readings.slice(0, limit);

    const treatments: Treatment[] = (
      rawTreatments.map((t: Record<string, unknown>) => ({
        ...t,
        mills: t.mills ?? new Date(t.created_at as string).getTime(),
      })) as Treatment[]
    ).sort((a, b) => a.mills - b.mills);

    const profile: PumpProfile = Array.isArray(rawProfile) ? rawProfile[0] : rawProfile;

    expect(readings.length).toBeGreaterThan(100);
    expect(profile.store).toBeTruthy();

    const n = readings.length;
    const days = (readings[n - 1].date - readings[0].date) / 86_400_000;
    const runBaseline = process.env.BASELINE !== "0";

    // ── ground truth: real low episodes ───────────────────────────────────────
    // A maximal run of readings under LOW, not spanning a data gap.
    const isLow = (i: number) => readings[i].sgv < LOW;
    const brokeBefore = (i: number) =>
      i === 0 || readings[i].date - readings[i - 1].date > GAP_BREAK_MIN * MIN_MS;
    const episodeStarts: number[] = [];
    for (let i = 0; i < n; i++) {
      if (isLow(i) && (brokeBefore(i) || !isLow(i - 1))) episodeStarts.push(i);
    }
    // How deep each episode went. A filter that only ever drops mild 65-69
    // dips is a very different proposition from one that drops severe lows,
    // and the aggregate recall number cannot tell them apart.
    const SEVERE = 55;
    const episodeNadir = episodeStarts.map((s) => {
      let m = readings[s].sgv;
      for (let k = s; k < n && isLow(k) && !(k > s && brokeBefore(k)); k++)
        if (readings[k].sgv < m) m = readings[k].sgv;
      return m;
    });
    const severeTotal = episodeNadir.filter((v) => v < SEVERE).length;

    // ── pass 1: run the models once per point, cache the curves ───────────────
    // Everything the sweep needs is derivable from the floor's 12-step curve,
    // so the expensive physiological work happens exactly once per reading.
    const curves = new Int16Array(n * STEPS); // 0 where not evaluated
    const evaluated = new Uint8Array(n);
    const gtLow = new Uint8Array(n); // did a real low follow within GT_WINDOW
    const gtLowAt = new Float64Array(n); // when, epoch ms
    const baselineFires = new Uint8Array(n);
    /** Did the advisory label it severe (→ T4_critical, the loudest tier)? */
    const baselineSevere = new Uint8Array(n);

    let tLo = 0;
    let tHi = 0;
    const t0 = Date.now();

    for (let i = MIN_HISTORY; i < n; i++) {
      const now = readings[i].date;

      // Already low: the plain threshold alert has fired. The question this
      // model answers is EARLY warning, so these points are not its job.
      if (readings[i].sgv < LOW) continue;

      // Ground truth, with an explicit "we cannot know" case. If the sensor
      // went offline inside the window and no low was seen, absence of a low is
      // not evidence of no low — scoring it as a false alarm would punish the
      // model for a dropout. Those points are dropped, not counted as quiet.
      const windowEnd = now + GT_WINDOW_MIN * MIN_MS;
      let fEnd = i + 1;
      while (fEnd < n && readings[fEnd].date <= windowEnd) fEnd++;
      if (fEnd === i + 1) continue;
      let lowAt = 0;
      for (let k = i + 1; k < fEnd; k++) {
        if (readings[k].sgv < LOW) {
          lowAt = readings[k].date;
          break;
        }
      }
      if (!lowAt && readings[fEnd - 1].date < windowEnd - 15 * MIN_MS) continue; // coverage gap

      while (tHi < treatments.length && treatments[tHi].mills <= now) tHi++;
      while (tLo < tHi && treatments[tLo].mills < now - IOB_WINDOW_MS) tLo++;
      const past = treatments.slice(tLo, tHi);
      const history = readings.slice(Math.max(0, i - 36), i + 1); // ~3h context

      const h = predictHypoRisk(history, past, profile, {
        horizonMinutes: MAX_HORIZON_MIN,
        lowThreshold: LOW,
      });
      for (let s = 0; s < STEPS; s++) curves[i * STEPS + s] = h.points[s]?.sgv ?? 0;

      if (runBaseline) {
        const a = evaluateLowTrigger({ readings: history, treatments: past, profile, now });
        baselineFires[i] = a ? 1 : 0;
        baselineSevere[i] = a && a.severity === "urgent" ? 1 : 0;
      }

      evaluated[i] = 1;
      gtLow[i] = lowAt ? 1 : 0;
      gtLowAt[i] = lowAt;
    }

    const evalCount = evaluated.reduce((s: number, v) => s + v, 0);
    console.log(
      `\n  modelled ${evalCount} points over ${days.toFixed(1)} days in ${(
        (Date.now() - t0) / 1000
      ).toFixed(0)}s — ${episodeStarts.length} real low episodes\n`
    );

    // ── scoring ───────────────────────────────────────────────────────────────
    // `warns[i]` is the raw per-reading verdict; everything below turns that
    // into the alerts a phone would actually deliver.
    function scoreWarnSequence(warns: Uint8Array, consecutive: number): Metrics {
      let run = 0;
      let lastAlertMs = -Infinity;
      let lastEvalMs = -Infinity;
      const alertIdx: number[] = [];

      for (let i = 0; i < n; i++) {
        if (!evaluated[i]) continue;
        const t = readings[i].date;
        // Two qualifying readings either side of a dropout — or either side of
        // a stretch that was already low — are not a streak.
        if (t - lastEvalMs > GAP_BREAK_MIN * MIN_MS) run = 0;
        lastEvalMs = t;
        run = warns[i] ? run + 1 : 0;
        if (run < consecutive) continue;
        if (t - lastAlertMs < COOLDOWN_MIN * MIN_MS) continue;
        lastAlertMs = t;
        alertIdx.push(i);
      }

      let truePos = 0;
      let nightAlerts = 0;
      let nightFalse = 0;
      const leads: number[] = [];
      for (const i of alertIdx) {
        const night = isNight(readings[i].date);
        if (night) nightAlerts++;
        if (gtLow[i]) {
          truePos++;
          leads.push((gtLowAt[i] - readings[i].date) / MIN_MS);
        } else if (night) nightFalse++;
      }

      // Episode recall: a real low counts as caught if any alert fired in the
      // GT_WINDOW before it started. Alerts during the low itself do not count
      // — by then the threshold alarm has already gone off. Both lists are
      // ascending, so this is a two-pointer scan, not a scan per episode
      // (432 configs x 501 episodes x every alert is not a tractable shape).
      let caught = 0;
      let caughtSevere = 0;
      let a = 0;
      for (let e = 0; e < episodeStarts.length; e++) {
        const start = readings[episodeStarts[e]].date;
        const from = start - GT_WINDOW_MIN * MIN_MS;
        while (a < alertIdx.length && readings[alertIdx[a]].date < from) a++;
        if (a < alertIdx.length && readings[alertIdx[a]].date < start) {
          caught++;
          if (episodeNadir[e] < SEVERE) caughtSevere++;
        }
      }

      const alerts = alertIdx.length;
      const falsePos = alerts - truePos;
      return {
        alerts,
        alertsPerDay: alerts / days,
        truePos,
        falsePos,
        falseAlertsPerDay: falsePos / days,
        precision: alerts ? truePos / alerts : 0,
        episodesCaught: caught,
        episodesTotal: episodeStarts.length,
        recall: episodeStarts.length ? caught / episodeStarts.length : 0,
        severeCaught: caughtSevere,
        severeRecall: severeTotal ? caughtSevere / severeTotal : 0,
        meanLead: leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : 0,
        medianLead: median(leads),
        nightAlerts,
        nightFalsePerNight: nightFalse / days,
      };
    }

    /** Does the cached floor curve cross `threshold - margin` within `horizon`? */
    function warnsFor(cfg: Config): Uint8Array {
      const steps = cfg.horizon / 5;
      const trip = cfg.threshold - cfg.margin;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (!evaluated[i]) continue;
        if (readings[i].sgv > cfg.bgCeiling) continue;
        for (let s = 0; s < steps; s++) {
          if (curves[i * STEPS + s] < trip) {
            out[i] = 1;
            break;
          }
        }
      }
      return out;
    }

    // ── run the sweep ─────────────────────────────────────────────────────────
    const rows: (Config & Metrics)[] = [];
    const combineAnd: (Config & Metrics)[] = [];
    const combineOr: (Config & Metrics)[] = [];

    for (const horizon of HORIZONS) {
      for (const threshold of THRESHOLDS) {
        for (const margin of MARGINS) {
          for (const bgCeiling of BG_CEILINGS) {
            const base = { horizon, threshold, margin, bgCeiling };
            const warns = warnsFor({ ...base, consecutive: 1 });
            // The floor as a CONFIRMATION filter: the current advisory still
            // decides when to speak, but must be seconded by the insulin-only
            // floor. This is the shape that can only ever REMOVE alerts.
            const andWarns = new Uint8Array(n);
            const orWarns = new Uint8Array(n);
            for (let i = 0; i < n; i++) {
              andWarns[i] = warns[i] && baselineFires[i] ? 1 : 0;
              orWarns[i] = warns[i] || baselineFires[i] ? 1 : 0;
            }
            for (const consecutive of CONSECUTIVE) {
              const cfg = { ...base, consecutive };
              rows.push({ ...cfg, ...scoreWarnSequence(warns, consecutive) });
              if (runBaseline) {
                combineAnd.push({ ...cfg, ...scoreWarnSequence(andWarns, consecutive) });
                combineOr.push({ ...cfg, ...scoreWarnSequence(orWarns, consecutive) });
              }
            }
          }
        }
      }
    }

    const baseline = runBaseline ? scoreWarnSequence(baselineFires, 1) : null;

    // ── report ────────────────────────────────────────────────────────────────
    const f = (x: number, d = 1) => x.toFixed(d);
    const p = (x: number) => `${(x * 100).toFixed(0)}%`;
    const line = (label: string, m: Metrics) =>
      `  ${label.padEnd(26)} ${f(m.alertsPerDay, 2).padStart(6)} ${f(m.falseAlertsPerDay, 2).padStart(7)} ` +
      `${p(m.precision).padStart(6)} ${p(m.recall).padStart(6)} ${String(m.episodesCaught + "/" + m.episodesTotal).padStart(8)} ` +
      `${p(m.severeRecall).padStart(7)} ${f(m.medianLead, 0).padStart(6)} ${f(m.nightFalsePerNight, 2).padStart(7)}`;

    const header =
      `  ${"config".padEnd(26)} ${"alt/d".padStart(6)} ${"false/d".padStart(7)} ` +
      `${"prec".padStart(6)} ${"recall".padStart(6)} ${"caught".padStart(8)} ${"sev-rec".padStart(7)} ${"lead".padStart(6)} ${"nite/d".padStart(7)}`;

    const name = (c: Config) =>
      `h${c.horizon} t${c.threshold} m${c.margin} n${c.consecutive} bg≤${c.bgCeiling}`;

    // Pareto frontier on the two axes that matter: fewer false alerts per day,
    // more real lows caught. A config is dominated when something else catches
    // at least as many lows with strictly fewer false alerts.
    const frontier = (set: (Config & Metrics)[]) =>
      set
        .filter(
          (r) =>
            !set.some(
              (o) =>
                o.recall >= r.recall &&
                o.falseAlertsPerDay <= r.falseAlertsPerDay &&
                (o.recall > r.recall || o.falseAlertsPerDay < r.falseAlertsPerDay)
            )
        )
        .sort((a, b) => a.falseAlertsPerDay - b.falseAlertsPerDay);

    // How alarmist is the raw floor? One number, so the structural claim is not
    // an inference from the sweep table.
    const belowAt = (level: number, mins: number) => {
      const steps = mins / 5;
      let hit = 0;
      let tot = 0;
      for (let i = 0; i < n; i++) {
        if (!evaluated[i]) continue;
        tot++;
        for (let s = 0; s < steps; s++)
          if (curves[i * STEPS + s] < level) {
            hit++;
            break;
          }
      }
      return tot ? hit / tot : 0;
    };

    console.log(`
  ── hypo-floor trigger sweep ─────────────────────────────────────────────────
  ${days.toFixed(0)} days · ${evalCount} points scored · ${episodeStarts.length} real low episodes
  Alerts collapsed by a ${COOLDOWN_MIN}-min cooldown. Ground truth: BG <${LOW} within ${GT_WINDOW_MIN} min.
  Recall is EPISODE-level: did a real low get an alert before it started?
  Base rate: ${(episodeStarts.length / days).toFixed(2)} real low episodes/day.

  HOW OFTEN THE RAW FLOOR PROJECTS A LOW (no gating at all)
    <70 within 30min ${p(belowAt(70, 30))}   <70 within 60min ${p(belowAt(70, 60))}
    <55 within 30min ${p(belowAt(55, 30))}   <55 within 60min ${p(belowAt(55, 60))}
    <45 within 30min ${p(belowAt(45, 30))}   <45 within 60min ${p(belowAt(45, 60))}

  A) FLOOR STANDALONE — Pareto frontier
${header}
${frontier(rows).map((r) => line(name(r), r)).join("\n")}
${baseline ? `\n  CURRENT ADVISORY (evaluateLowTrigger — what fires today)\n${line("baseline", baseline)}` : ""}
`);

    if (runBaseline && baseline) {
      console.log(`  B) FLOOR AS A CONFIRMATION FILTER (advisory AND floor) — can only REMOVE alerts
${header}
${frontier(combineAnd)
  .filter((r) => r.recall >= baseline.recall * 0.7)
  .map((r) => line(name(r), r))
  .join("\n")}

  C) FLOOR AS AN ADDITION (advisory OR floor) — buys recall, costs quiet
${header}
${frontier(combineOr).slice(0, 10).map((r) => line(name(r), r)).join("\n")}
`);

      // ── ABLATION ───────────────────────────────────────────────────────────
      // Every filter row carries TWO conditions: the IOB floor AND a current-BG
      // ceiling. Reporting only their combination would let the ceiling take
      // credit the floor earns, or vice versa. Separate them, because they cost
      // very different things to ship: the ceiling is one comparison in code
      // that already runs, the floor is a whole model wired into the alert path.
      const gate = (fn: (i: number) => boolean) => {
        const w = new Uint8Array(n);
        for (let i = 0; i < n; i++) w[i] = baselineFires[i] && fn(i) ? 1 : 0;
        return scoreWarnSequence(w, 1);
      };
      const floorBelow = (i: number, level: number, mins: number) => {
        for (let s = 0; s < mins / 5; s++) if (curves[i * STEPS + s] < level) return true;
        return false;
      };

      console.log("  ABLATION — which condition is doing the work?");
      console.log(header);
      console.log(line("advisory alone (today)", baseline));
      for (const c of [180, 150, 120, 100]) {
        console.log(line(`  + BG ≤ ${c} only`, gate((i) => readings[i].sgv <= c)));
      }
      console.log(line("  + floor<70/30m only", gate((i) => floorBelow(i, 70, 30))));
      console.log(line("  + floor<55/30m only", gate((i) => floorBelow(i, 55, 30))));
      console.log(
        line("  + floor<70/30m & BG≤120", gate((i) => readings[i].sgv <= 120 && floorBelow(i, 70, 30)))
      );
      console.log(
        line("  + floor<55/30m & BG≤120", gate((i) => readings[i].sgv <= 120 && floorBelow(i, 55, 30)))
      );
      console.log("");

      // ── TIER INFLATION ─────────────────────────────────────────────────────
      // A separate, cheaper lever than suppressing alerts: keep firing, but stop
      // handing out the loudest tier so freely. The advisory calls a low
      // "severe" (→ T4_critical) from a straight-line ROC extrapolation, which
      // over-reaches; the question is whether the IOB floor is a better arbiter
      // of which lows are genuinely going deep.
      const severeAlerts = (extra: ((i: number) => boolean) | null) => {
        let fired = 0;
        let realSevere = 0;
        let lastMs = -Infinity;
        for (let i = 0; i < n; i++) {
          if (!evaluated[i] || !baselineFires[i] || !baselineSevere[i]) continue;
          if (extra && !extra(i)) continue;
          const t = readings[i].date;
          if (t - lastMs < COOLDOWN_MIN * MIN_MS) continue;
          lastMs = t;
          fired++;
          // Did BG actually go below 55 within the ground-truth window?
          const end = t + GT_WINDOW_MIN * MIN_MS;
          for (let k = i + 1; k < n && readings[k].date <= end; k++)
            if (readings[k].sgv < SEVERE) {
              realSevere++;
              break;
            }
        }
        return { fired, realSevere, perDay: fired / days, prec: fired ? realSevere / fired : 0 };
      };

      console.log("  TIER INFLATION — how often is the LOUDEST tier (T4_critical) justified?");
      const shapes: [string, ((i: number) => boolean) | null][] = [
        ["severe as labelled today", null],
        ["  + floor<55 within 30m", (i) => floorBelow(i, 55, 30)],
        ["  + floor<55 within 60m", (i) => floorBelow(i, 55, 60)],
        ["  + floor<45 within 30m", (i) => floorBelow(i, 45, 30)],
      ];
      for (const [label, fn] of shapes) {
        const r = severeAlerts(fn);
        console.log(
          `    ${label.padEnd(28)} ${f(r.perDay, 2).padStart(5)}/day  ` +
            `${String(r.realSevere + "/" + r.fired).padStart(8)} preceded a real <55  (prec ${p(r.prec)})`
        );
      }
      console.log("");

      // The question that decides B: how much of the advisory's false alarm
      // load does the floor remove, and what does that cost in real lows?
      const best = combineAnd
        .filter((r) => r.recall >= baseline.recall - 0.05)
        .sort((a, b) => a.falseAlertsPerDay - b.falseAlertsPerDay)[0];
      if (best)
        console.log(
          `  Best filter holding recall within 5pts of today: ${name(best)}\n` +
            `    false alerts ${f(baseline.falseAlertsPerDay, 2)}/d → ${f(best.falseAlertsPerDay, 2)}/d ` +
            `(${p(1 - best.falseAlertsPerDay / baseline.falseAlertsPerDay)} fewer), ` +
            `recall ${p(baseline.recall)} → ${p(best.recall)}, ` +
            `night ${f(baseline.nightFalsePerNight, 2)} → ${f(best.nightFalsePerNight, 2)}/night\n`
        );
    }

    // Precision at fixed recall — the comparison the handoff asked for.
    console.log("  CHEAPEST STANDALONE CONFIG AT EACH RECALL TARGET");
    for (const target of [0.7, 0.6, 0.5, 0.4, 0.3]) {
      const best = rows
        .filter((r) => r.recall >= target)
        .sort((a, b) => a.falseAlertsPerDay - b.falseAlertsPerDay)[0];
      console.log(
        best
          ? `    ≥${p(target)} of lows:  ${name(best).padEnd(28)} ` +
              `${f(best.falseAlertsPerDay, 2)} false/day · prec ${p(best.precision)} · lead ${f(best.medianLead, 0)}min · night ${f(best.nightFalsePerNight, 2)}/d`
          : `    ≥${p(target)} of lows:  unreachable`
      );
    }

    mkdirSync(DIR, { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify(
        { days, evalCount, episodes: episodeStarts.length, baseline, rows, combineAnd, combineOr },
        null,
        2
      )
    );
    console.log(`\n  full grid → ${OUT}\n`);
  }, 3_600_000);
});
