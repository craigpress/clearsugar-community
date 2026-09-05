/**
 * Head-to-head: every proposed change to the low advisory, on one footing.
 *
 * Two independent analyses on 2026-07-28 disagreed about whether the IOB hypo
 * floor is a useful gate. They were measuring different things — one excluded
 * already-low anchors, the other evaluated the floor at its loose shipped
 * setting where it barely vetoes anything. This script settles it by scoring
 * every lever on the same anchors with the same delivery model.
 *
 * Run:  npx vitest run --config scripts/backtest.vitest.config.ts \
 *         scripts/advisor-levers.backtest.ts
 * Data: tmp/bt/{entries,treatments,profile}.json  (see hypo-risk.backtest.ts)
 * Env:  LIMIT=<n>  smoke run on the first n readings
 *
 * ── Delivery model matches production, because that is what a person feels ───
 *
 * `src/app/api/advisor/check/route.ts`:
 *   • 2h per-id cooldown, BYPASSED when severity worsens (route.ts:88-95).
 *   • Overnight (pump Sleep 22:00-05:00, ciq-modes.ts:30-31) every tier below
 *     T4_critical is downgraded to `passive` (route.ts:162-163).
 * So "wakes the house" means exactly: a T4_critical push inside 22:00-05:00.
 * That is the number this project is trying to bring down, and it is reported
 * separately from ordinary daytime pushes throughout.
 *
 * ── Credit is only given for EARLY warning ───────────────────────────────────
 *
 * A low episode counts as caught only if a fire from BG >= 70 preceded its
 * onset by <= 45 min. A fire once BG is already under 70 is not an early
 * warning — it is a fourth threshold alarm behind the Dexcom, the server
 * `low`/`urgentLow` push, and the iOS backstop.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { evaluateLowTrigger, ciqOptimisticRollout } from "../src/lib/prediction/loop-gap-trigger";
import { estimateRateOfChange } from "../src/lib/prediction/physiological-model";
import { predictHypoRisk } from "../src/lib/prediction/hypo-risk";
import { isPumpSleep } from "../src/lib/prediction/ciq-modes";
import type { GlucoseReading, Treatment, PumpProfile } from "../src/lib/types";

const DIR = "tmp/bt";
const LOW = 70;
const SEVERE = 55;
const GT_WINDOW_MIN = 60;
/** How long before onset a fire still counts as having warned about it. */
const CATCH_WINDOW_MIN = 45;
const HORIZON_MIN = 30;
const FLOOR_STEPS = 12; // 60 min of floor curve, cached per anchor
const MIN_HISTORY = 6;
const GAP_BREAK_MIN = 20;
const COOLDOWN_MS = 2 * 60 * 60_000; // production advisor cooldown
const IOB_WINDOW_MS = 8 * 60 * 60_000;
const MIN_MS = 60_000;
const SEV_RANK = ["info", "low", "moderate", "high", "urgent"];

interface Row {
  pushesPerDay: number;
  falsePerDay: number;
  wakesPerNight: number;
  falseWakesPerNight: number;
  lowCatch: number;
  severeCatch: number;
  medianLead: number;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

describe("advisor levers", () => {
  it("scores every proposed change on identical anchors", () => {
    if (!existsSync(`${DIR}/entries.json`)) {
      console.log(`\n  SKIPPED — no data at ${DIR}/.\n`);
      return;
    }

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
    const n = readings.length;
    const days = (readings[n - 1].date - readings[0].date) / 86_400_000;
    const nights = days; // one sleep window per day

    // ── ground truth ──────────────────────────────────────────────────────────
    const brokeBefore = (i: number) =>
      i === 0 || readings[i].date - readings[i - 1].date > GAP_BREAK_MIN * MIN_MS;
    const isLow = (i: number) => readings[i].sgv < LOW;
    const epStart: number[] = [];
    for (let i = 0; i < n; i++) if (isLow(i) && (brokeBefore(i) || !isLow(i - 1))) epStart.push(i);
    const epNadir = epStart.map((s) => {
      let m = readings[s].sgv;
      for (let k = s; k < n && isLow(k) && !(k > s && brokeBefore(k)); k++)
        if (readings[k].sgv < m) m = readings[k].sgv;
      return m;
    });
    const severeTotal = epNadir.filter((v) => v < SEVERE).length;

    // ── pass 1: everything each lever needs, computed once per anchor ─────────
    // Anchors here include ALREADY-LOW readings, unlike hypo-risk.sweep — the
    // whole point of lever A1 is that 54% of fires happen there, which a
    // harness that skips them cannot see.
    const fires = new Uint8Array(n);
    const severeLbl = new Uint8Array(n);
    const evaluated = new Uint8Array(n);
    const rocMinArr = new Float32Array(n);
    const ciqMinArr = new Float32Array(n);
    const floor = new Int16Array(n * FLOOR_STEPS);
    const gtLowAt = new Float64Array(n);

    let tLo = 0;
    let tHi = 0;
    const t0 = Date.now();

    for (let i = MIN_HISTORY; i < n; i++) {
      const now = readings[i].date;
      const windowEnd = now + GT_WINDOW_MIN * MIN_MS;
      let fEnd = i + 1;
      while (fEnd < n && readings[fEnd].date <= windowEnd) fEnd++;
      if (fEnd === i + 1) continue;
      let lowAt = 0;
      for (let k = i + 1; k < fEnd; k++)
        if (readings[k].sgv < LOW) {
          lowAt = readings[k].date;
          break;
        }
      // Sensor offline inside the window and no low seen: we cannot know, so
      // this anchor is dropped rather than scored as a quiet true-negative.
      if (!lowAt && readings[fEnd - 1].date < windowEnd - 15 * MIN_MS) continue;

      while (tHi < treatments.length && treatments[tHi].mills <= now) tHi++;
      while (tLo < tHi && treatments[tLo].mills < now - IOB_WINDOW_MS) tLo++;
      const past = treatments.slice(tLo, tHi);
      const history = readings.slice(Math.max(0, i - 36), i + 1);

      const a = evaluateLowTrigger({ readings: history, treatments: past, profile, now });
      fires[i] = a ? 1 : 0;
      severeLbl[i] = a && a.severity === "urgent" ? 1 : 0;

      // The two projections the trigger ANDs to fire and MINs to tier. Needed
      // separately to test lever A4 (tier on their max instead of their min).
      const roc5 = estimateRateOfChange(history);
      const rocMin = Math.min(readings[i].sgv, readings[i].sgv + roc5 * (HORIZON_MIN / 5));
      const ciq = ciqOptimisticRollout(history, past, profile, HORIZON_MIN);
      rocMinArr[i] = rocMin;
      ciqMinArr[i] = ciq === null ? rocMin : ciq;

      const h = predictHypoRisk(history, past, profile, { horizonMinutes: 60, lowThreshold: LOW });
      for (let s = 0; s < FLOOR_STEPS; s++) floor[i * FLOOR_STEPS + s] = h.points[s]?.sgv ?? 0;

      evaluated[i] = 1;
      gtLowAt[i] = lowAt;
    }
    console.log(
      `\n  ${evaluated.reduce((s: number, v) => s + v, 0)} anchors over ${days.toFixed(
        1
      )} days in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${epStart.length} low episodes (${severeTotal} severe)\n`
    );

    const floorBelow = (i: number, level: number, mins: number) => {
      for (let s = 0; s < mins / 5; s++) if (floor[i * FLOOR_STEPS + s] < level) return true;
      return false;
    };

    // ── delivery simulation ───────────────────────────────────────────────────
    function score(
      pass: (i: number) => boolean,
      tierSevere: (i: number) => boolean,
      persist = 0
    ): Row {
      let lastPush = -Infinity;
      let lastRank = -1;
      let run = 0;
      let lastEval = -Infinity;
      const pushes: { i: number; severe: boolean }[] = [];

      for (let i = 0; i < n; i++) {
        if (!evaluated[i]) continue;
        const t = readings[i].date;
        if (t - lastEval > GAP_BREAK_MIN * MIN_MS) run = 0;
        lastEval = t;

        const raw = fires[i] === 1 && pass(i);
        run = raw ? run + 1 : 0;
        const severe = tierSevere(i);
        // Persistence with the severe instantaneous bypass the Python
        // prototype specifies — without the bypass it guts severe catch.
        if (!raw) continue;
        if (persist > 0 && run < persist && !severe) continue;

        const rank = SEV_RANK.indexOf(severe ? "urgent" : "moderate");
        const cooled = t - lastPush > COOLDOWN_MS;
        const worsened = rank > lastRank;
        if (!cooled && !worsened) continue;
        lastPush = t;
        lastRank = rank;
        pushes.push({ i, severe });
      }

      let truePos = 0;
      let wakes = 0;
      let falseWakes = 0;
      const leads: number[] = [];
      for (const { i, severe } of pushes) {
        const t = readings[i].date;
        const real = gtLowAt[i] > 0;
        if (real) {
          truePos++;
          leads.push((gtLowAt[i] - t) / MIN_MS);
        }
        // Only T4_critical survives the overnight downgrade.
        if (severe && isPumpSleep(t, undefined)) {
          wakes++;
          if (!real) falseWakes++;
        }
      }

      // Early-warning credit only: the fire must come from BG >= 70.
      const early = pushes.filter(({ i }) => readings[i].sgv >= LOW).map(({ i }) => readings[i].date);
      let caught = 0;
      let caughtSevere = 0;
      let a = 0;
      for (let e = 0; e < epStart.length; e++) {
        const start = readings[epStart[e]].date;
        const from = start - CATCH_WINDOW_MIN * MIN_MS;
        while (a < early.length && early[a] < from) a++;
        if (a < early.length && early[a] < start) {
          caught++;
          if (epNadir[e] < SEVERE) caughtSevere++;
        }
      }

      return {
        pushesPerDay: pushes.length / days,
        falsePerDay: (pushes.length - truePos) / days,
        wakesPerNight: wakes / nights,
        falseWakesPerNight: falseWakes / nights,
        lowCatch: caught / epStart.length,
        severeCatch: severeTotal ? caughtSevere / severeTotal : 0,
        medianLead: median(leads),
      };
    }

    // ── the levers ────────────────────────────────────────────────────────────
    const notAlreadyLow = (i: number) => readings[i].sgv >= LOW;
    const severeAsShipped = (i: number) => severeLbl[i] === 1;
    // A4: require BOTH projections to agree it is severe, not the more
    // alarmist of the two.
    const severeBothAgree = (i: number) => Math.max(rocMinArr[i], ciqMinArr[i]) < SEVERE;
    const floor55 = (i: number) => floorBelow(i, SEVERE, 30);
    const bg90 = (i: number) => readings[i].sgv <= 90;

    const levers: [string, Row][] = [
      ["as shipped today", score(() => true, severeAsShipped)],
      ["A1  not-already-low", score(notAlreadyLow, severeAsShipped)],
      ["A1+A2  +BG<=90", score((i) => notAlreadyLow(i) && bg90(i), severeAsShipped)],
      ["A1+floor<55/30m", score((i) => notAlreadyLow(i) && floor55(i), severeAsShipped)],
      [
        "A1+A2+floor",
        score((i) => notAlreadyLow(i) && bg90(i) && floor55(i), severeAsShipped),
      ],
      ["A1+A3  +persist2", score(notAlreadyLow, severeAsShipped, 2)],
      ["A1+A2+A3", score((i) => notAlreadyLow(i) && bg90(i), severeAsShipped, 2)],
      ["A1+A2+A3+A4(tier)", score((i) => notAlreadyLow(i) && bg90(i), severeBothAgree, 2)],
      [
        "A1+A2+A3+A4+floor",
        score((i) => notAlreadyLow(i) && bg90(i) && floor55(i), severeBothAgree, 2),
      ],
      ["A1+A4(tier only)", score(notAlreadyLow, severeBothAgree)],
      ["A1+A2+A4", score((i) => notAlreadyLow(i) && bg90(i), severeBothAgree)],
      [
        "A1+A2+A4+floor",
        score((i) => notAlreadyLow(i) && bg90(i) && floor55(i), severeBothAgree),
      ],
      ["A1+A4+floor", score((i) => notAlreadyLow(i) && floor55(i), severeBothAgree)],
      ["A1+A2(BG<=100)", score((i) => notAlreadyLow(i) && readings[i].sgv <= 100, severeAsShipped)],
      [
        "A1+A2(BG<=100)+A4",
        score((i) => notAlreadyLow(i) && readings[i].sgv <= 100, severeBothAgree),
      ],
    ];

    const f = (x: number, d = 2) => x.toFixed(d);
    const p = (x: number) => `${(x * 100).toFixed(1)}%`;
    console.log(
      `  ${"lever".padEnd(22)} ${"push/d".padStart(7)} ${"false/d".padStart(8)} ${"WAKE/nt".padStart(8)} ` +
        `${"fWAKE/nt".padStart(9)} ${"lowCatch".padStart(9)} ${"sevCatch".padStart(9)} ${"lead".padStart(6)}`
    );
    for (const [name, r] of levers)
      console.log(
        `  ${name.padEnd(22)} ${f(r.pushesPerDay).padStart(7)} ${f(r.falsePerDay).padStart(8)} ` +
          `${f(r.wakesPerNight, 3).padStart(8)} ${f(r.falseWakesPerNight, 3).padStart(9)} ` +
          `${p(r.lowCatch).padStart(9)} ${p(r.severeCatch).padStart(9)} ${f(r.medianLead, 0).padStart(6)}`
      );

    const base = levers[0][1];
    console.log(`\n  vs shipped — night wakes is the number that matters:`);
    for (const [name, r] of levers.slice(1))
      console.log(
        `    ${name.padEnd(22)} pushes ${p(r.pushesPerDay / base.pushesPerDay - 1).padStart(7)}  ` +
          `false wakes ${p(r.falseWakesPerNight / base.falseWakesPerNight - 1).padStart(7)}  ` +
          `severe catch ${p(base.severeCatch ? r.severeCatch / base.severeCatch - 1 : 0).padStart(7)}`
      );
    console.log("");
  }, 3_600_000);
});
