import { NextResponse } from "next/server";
import { getEntries, getTreatments, getProfile } from "@/lib/nightscout";
import { calculateStats } from "@/lib/statistics";
import { requireApiAuth } from "@/lib/api-auth";
import { DEFAULT_INSIGHTS_MODEL } from "@/lib/insights/models";
import { computeDayOfWeekPatterns } from "@/lib/trends";
import type { GlucoseReading, Treatment } from "@/lib/types";
import {
  computeTimeBlocks,
  computeNotableDays,
  computeCorrectionEffectiveness,
  computeAGPByHour,
} from "@/lib/insights/data-enrichment";
import {
  analyzeMealEvents,
  analyzeCarbRatios,
  analyzeISF,
  analyzeBasalAdequacy,
  analyzeSitePeriods,
  analyzeOutOfRangeEpisodes,
} from "@/lib/insulin-analysis";
import type {
  MealEvent,
  CarbRatioResult,
  ISFByPeriod,
  BasalPeriodAnalysis,
  SitePeriod,
  EpisodeCluster,
} from "@/lib/insulin-analysis";
import { buildInsightsSystemPrompt, buildInsightsUserMessage } from "@/lib/insights/prompt";
import { getPatientProfile, describePatient } from "@/lib/patient-profile";
import {
  detectProfileChanges,
  mergeChangeEvents,
} from "@/lib/insights/profile-changes";
import { loadSettingsChanges } from "@/lib/prediction/settings-tracker";
import { SAFETY_CORE } from "@/lib/insights/safety-core";
import { detectSiteAndSensorIssues, countSensorDataQualityIssues } from "@/lib/insights/site-sensor-detection";
import { generateInsights } from "@/lib/insights/llm-client";
import { saveReport, loadLatestReport } from "@/lib/insights/report-store";
import type { StoredReport } from "@/lib/insights/report-store";
import { computeCoverage } from "@/lib/data-quality";
import { localHour } from "@/lib/time";

const PROMPT_VERSION = "2026-07-02a";

export const dynamic = "force-dynamic";

// In-memory cache for fast repeated loads
let cachedReport: StoredReport | null = null;

// GET returns the latest report (from memory cache or disk)
export async function GET(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const days = parseInt(url.searchParams.get("days") || "0") || undefined;

  // Try memory cache first
  if (cachedReport && (!days || cachedReport.days === days)) {
    return NextResponse.json(cachedReport);
  }

  // Fall back to disk storage
  try {
    const stored = await loadLatestReport(days);
    if (stored) {
      cachedReport = stored;
      return NextResponse.json(stored);
    }
  } catch {
    // No stored reports yet — that's OK
  }

  return NextResponse.json(
    { error: "No report available. Select a date range and click Refresh Insights." },
    { status: 404 }
  );
}

export async function POST(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  try {
    // Parse params
    const url = new URL(req.url);
    const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get("days") || "7")));
    const model = url.searchParams.get("model") || DEFAULT_INSIGHTS_MODEL;
    const maxAge = days * 24 * 60 * 60_000;

    // Scale fetch counts by days
    const entryCount = Math.min(30000, days * 288);
    const treatmentCount = Math.min(10000, days * 300);

    const [readings, treatments] = await Promise.all([
      getEntries(entryCount, maxAge),
      getTreatments(treatmentCount, maxAge),
    ]);

    if (readings.length < 100) {
      return NextResponse.json({ error: "Not enough data for insights" }, { status: 400 });
    }

    // ── Fetch pump profile ──
    let pumpProfile: {
      dia: number;
      basalRates: Array<{ time: string; rate: number }>;
      carbRatios: Array<{ time: string; ratio: number }>;
      isfSchedule: Array<{ time: string; isf: number }>;
      targetRange: { low: number; high: number };
    } | undefined;
    let profileChanges: Array<{ date: string; changes: string[] }> = [];
    const periodStartMs = Date.now() - maxAge;
    try {
      // count=20 pulls change history — Nightscout keeps one doc per change.
      const profiles = await getProfile(20);
      if (profiles.length > 0) {
        const p = profiles[0];
        const defaultName = p.defaultProfile || "Default";
        const store = p.store[defaultName];
        if (store) {
          pumpProfile = {
            dia: typeof store.dia === "string" ? parseFloat(store.dia) : store.dia,
            basalRates: store.basal.map((b) => ({ time: b.time, rate: b.value })),
            carbRatios: store.carbratio.map((c) => ({ time: c.time, ratio: c.value })),
            isfSchedule: store.sens.map((s) => ({ time: s.time, isf: s.value })),
            targetRange: {
              low: store.target_low?.[0]?.value ?? 70,
              high: store.target_high?.[0]?.value ?? 180,
            },
          };
        }
        // Dated schedule changes (basal/ISF/CR/target) within the period,
        // merged with CIQ settings changes (weight/TDD/limits) tracked by
        // the advisor cron.
        const scheduleEvents = detectProfileChanges(profiles, periodStartMs);
        const settingsEvents = await loadSettingsChanges(periodStartMs).catch(
          () => []
        );
        profileChanges = mergeChangeEvents(scheduleEvents, settingsEvents).map(
          (ev) => ({ date: ev.date, changes: ev.changes })
        );
      }
    } catch {
      // Profile fetch failed — continue without it
    }

    // ── Compute all stats ──
    const stats = calculateStats(readings);

    // Recent 14-day window for trajectory comparison — only meaningful when
    // the period is materially longer than the window itself.
    const RECENT_WINDOW_DAYS = 14;
    let recentWindow:
      | { days: number; stats: ReturnType<typeof calculateStats> }
      | undefined;
    if (days >= RECENT_WINDOW_DAYS * 2) {
      const cutoff = Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60_000;
      const recentReadings = readings.filter((r) => r.date >= cutoff);
      if (recentReadings.length >= 100) {
        recentWindow = {
          days: RECENT_WINDOW_DAYS,
          stats: calculateStats(recentReadings),
        };
      }
    }
    const dayOfWeek = computeDayOfWeekPatterns(readings);
    const timeBlocks = computeTimeBlocks(readings);
    const notableDays = computeNotableDays(readings);
    const corrections = computeCorrectionEffectiveness(readings, treatments);
    const agpByHour = computeAGPByHour(readings);

    // ── Rich analysis from insulin-analysis.ts (same as Analysis tab) ──
    const boluses = treatments.filter((t: Treatment) => t.insulin && t.insulin > 0);
    const carbs = treatments.filter((t: Treatment) => t.carbs && t.carbs > 0);
    const basals = treatments.filter((t: Treatment) => t.eventType === "Temp Basal");

    let richMealEvents: ReturnType<typeof analyzeMealEvents> = [];
    let carbRatioResults: ReturnType<typeof analyzeCarbRatios> = [];
    let mealTypeSummary: ReturnType<typeof buildMealTypeSummary> = [];
    let isfByPeriod: ISFByPeriod[] = [];
    let basalAdequacyResults: BasalPeriodAnalysis[] = [];
    let sitePeriodResults: SitePeriod[] = [];
    let episodeClusters: EpisodeCluster[] = [];

    try {
      richMealEvents = analyzeMealEvents(readings, boluses, carbs);
      carbRatioResults = analyzeCarbRatios(readings, boluses, carbs);
      const isfAnalysis = analyzeISF(readings, boluses, carbs, treatments);
      isfByPeriod = isfAnalysis.byPeriod;
      basalAdequacyResults = analyzeBasalAdequacy(readings, boluses, carbs, basals);
      sitePeriodResults = analyzeSitePeriods(readings, treatments, boluses, carbs);
      const episodeAnalysis = analyzeOutOfRangeEpisodes(readings, boluses, carbs, basals);
      episodeClusters = episodeAnalysis.clusters;
      mealTypeSummary = buildMealTypeSummary(richMealEvents, carbRatioResults);
    } catch (analysisErr) {
      console.error("Rich analysis failed, continuing with basic data:", analysisErr);
    }

    // ── Meal events for LLM (capped at 25 for token budget) ──
    const mealEventLimit = 25;
    const mealEvents = richMealEvents.slice(-mealEventLimit).map((m) => ({
      time: new Date(m.startTime).toLocaleString("en-US", { timeZone: "America/New_York" }),
      carbs: m.totalCarbs,
      bolus: Math.round(m.totalInsulin * 10) / 10,
      bgAtMeal: m.preMeal,
      bgAfter1h: m.glucoseAt60 ?? undefined,
      bgAfter2h: m.glucoseAt120 ?? undefined,
      carbRatioUsed: m.totalCarbs > 0 && m.totalInsulin > 0
        ? Math.round(m.totalCarbs / m.totalInsulin)
        : 0,
      mealType: m.timeOfDay,
      peak: m.peakGlucose,
      peakTimeMin: m.peakTimeMin,
    }));

    // Hourly averages
    const hourly: Record<number, { sum: number; count: number; inRange: number }> = {};
    for (const r of readings) {
      const h = localHour(r.date);
      if (!hourly[h]) hourly[h] = { sum: 0, count: 0, inRange: 0 };
      hourly[h].sum += r.sgv;
      hourly[h].count++;
      if (r.sgv >= 70 && r.sgv <= 180) hourly[h].inRange++;
    }
    const hourlyStats = Object.entries(hourly).map(([h, v]) => ({
      hour: parseInt(h),
      avg: Math.round(v.sum / v.count),
      tir: Math.round((v.inRange / v.count) * 100),
      count: v.count,
    }));
    hourlyStats.sort((a, b) => a.hour - b.hour);

    // Overnight stats
    const overnightReadings = readings.filter((r) => {
      const h = localHour(r.date);
      return h >= 22 || h < 6;
    });
    const overnightStats = calculateStats(overnightReadings);

    // Treatment summary (boluses/carbs already defined above for analysis)
    const siteChanges = treatments.filter((t: Treatment) => t.eventType === "Site Change");
    const siteChangeDates = siteChanges.map((t) =>
      new Date(t.created_at || t.mills || 0).toLocaleDateString()
    );

    // ── Build rule-based patterns (for the Patterns tab) ──
    const patterns = buildPatterns(stats, hourly, dayOfWeek, overnightStats, readings, treatments, corrections, days);

    // Add site failure + CGM sensor quality alerts
    const siteAndSensorAlerts = detectSiteAndSensorIssues(readings, treatments);
    patterns.push(...siteAndSensorAlerts);

    // ── Build LLM data payload ──
    const windowStartMs = Date.now() - maxAge;
    const windowEndMs = Date.now();
    const period = `${new Date(windowStartMs).toLocaleDateString("en-US", { timeZone: "America/New_York" })} – ${new Date(windowEndMs).toLocaleDateString("en-US", { timeZone: "America/New_York" })}`;

    // CGM coverage over the analysis window
    const coverage = computeCoverage(readings, windowStartMs, windowEndMs);

    // Actual data span (min/max reading), formatted in ET
    const fmtET = (ms: number) =>
      new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York" });
    const readingDates = readings.map((r) => r.date);
    const dataSpan = {
      first: fmtET(Math.min(...readingDates)),
      last: fmtET(Math.max(...readingDates)),
    };

    // Informational sensor data-quality counts (do NOT alter clinical stats)
    const dataQualityNotes = countSensorDataQualityIssues(readings, treatments);

    const insightsInput = {
      days,
      period,
      dataSpan,
      coverage,
      dataQualityNotes,
      stats: {
        count: stats.count,
        mean: stats.mean,
        median: stats.median,
        min: stats.min,
        max: stats.max,
        stdDev: stats.stddev,
        cv: stats.cv,
        gmi: stats.gmi,
        timeInRange: stats.timeInRange,
      },
      hourlyStats,
      dayOfWeek: dayOfWeek.map((d) => ({
        day: d.day,
        mean: d.mean,
        timeInRange: d.timeInRange,
        count: d.count,
      })),
      overnightStats: {
        mean: overnightStats.mean,
        timeInRange: overnightStats.timeInRange,
      },
      treatments: {
        bolusCount: boluses.length,
        avgBolusesPerDay: Math.round((boluses.length / days) * 10) / 10,
        carbEntries: carbs.length,
        siteChanges: siteChanges.length,
        siteChangeDates,
      },
      timeBlocks,
      notableDays,
      corrections,
      agpByHour,
      pumpProfile,
      mealEvents,
      // New: rich analysis data from insulin-analysis.ts
      mealTypeSummary: mealTypeSummary.length > 0 ? mealTypeSummary : undefined,
      isfByPeriod: isfByPeriod.length > 0 ? isfByPeriod : undefined,
      basalAdequacy: basalAdequacyResults.length > 0 ? basalAdequacyResults : undefined,
      sitePeriodSummary: sitePeriodResults.length > 0 ? sitePeriodResults.map((sp) => ({
        date: sp.siteChangeDate,
        ageDays: sp.ageDays,
        tir: sp.tir,
        avgGlucose: sp.avgGlucose,
        degradation: sp.degradation,
        avgISF: sp.avgISF,
        effectiveRate: sp.effectiveRate,
      })) : undefined,
      episodeClusters: episodeClusters.length > 0
        ? episodeClusters.slice(0, 8).map((c) => ({
            label: c.label,
            count: c.episodes.length,
            avgDuration: c.avgDuration,
            avgPeak: c.avgPeak,
            commonDay: c.commonDay,
            possibleCause: c.possibleCause,
          }))
        : undefined,
      recentWindow: recentWindow
        ? {
            days: recentWindow.days,
            stats: {
              count: recentWindow.stats.count,
              mean: recentWindow.stats.mean,
              cv: recentWindow.stats.cv,
              gmi: recentWindow.stats.gmi,
              timeInRange: recentWindow.stats.timeInRange,
            },
          }
        : undefined,
      profileChanges: profileChanges.length > 0 ? profileChanges : undefined,
    };

    const userMessage = buildInsightsUserMessage(insightsInput);
    const insightsSystemPrompt = await buildInsightsSystemPrompt();
    const patientProfile = await getPatientProfile();

    // ── Call LLM ──
    const promptChars = insightsSystemPrompt.length + userMessage.length;
    const estTokens = Math.ceil(promptChars / 3.5);
    console.log(`[insights] ${days}d: ${readings.length} readings, ${treatments.length} treatments, prompt ~${promptChars} chars (~${estTokens} tokens), ${mealTypeSummary.length} meal types, ${mealEvents.length} meals`);

    let llmReport: string;
    let llmModel = model;
    let llmProvider = "unknown";
    let llmDuration = 0;

    // Helper: detect garbage LLM output (repeated emoji, too short, no real words)
    function isGarbageOutput(text: string): boolean {
      if (text.length < 200) return true;
      // Check for repeated non-ASCII characters (garbage emoji pattern)
      const nonAscii = text.replace(/[\x00-\x7F]/g, "");
      if (nonAscii.length > text.length * 0.3) return true;
      // Must contain at least some English words
      const words = text.match(/[a-zA-Z]{3,}/g);
      if (!words || words.length < 20) return true;
      return false;
    }

    // Build a minimal prompt for retry (drops rich analysis data)
    function buildMinimalMessage(): string {
      return buildInsightsUserMessage({
        days, period,
        stats: { count: stats.count, mean: stats.mean, median: stats.median, min: stats.min, max: stats.max, stdDev: stats.stddev, cv: stats.cv, gmi: stats.gmi, timeInRange: stats.timeInRange },
        hourlyStats: [],
        dayOfWeek: [],
        overnightStats: { mean: overnightStats.mean, timeInRange: overnightStats.timeInRange },
        treatments: { bolusCount: boluses.length, avgBolusesPerDay: Math.round((boluses.length / days) * 10) / 10, carbEntries: carbs.length, siteChanges: siteChanges.length, siteChangeDates: [] },
        timeBlocks,
        pumpProfile,
        mealEvents: [],
        // Keep the most important new data — tiny footprint
        mealTypeSummary: mealTypeSummary.length > 0 ? mealTypeSummary : undefined,
        basalAdequacy: basalAdequacyResults.length > 0 ? basalAdequacyResults : undefined,
        profileChanges: profileChanges.length > 0 ? profileChanges : undefined,
      });
    }

    const compactSystem = `You are ClearSugar, a diabetes data analyst for ${describePatient(patientProfile)}.

Analyze the data and write a markdown report with: Overall Assessment, Key Patterns (4-6 numbered, each with data/mechanism/action), Pump Setting Recommendations (markdown table with Setting | Time Block | Current | Suggested | Rationale columns), Discussion Points for Endo, and What's Going Well.

CRITICAL: Use the Meal Response Summary (% In Range at 2h) to assess meal effectiveness — NOT time block TIR. Time blocks inflate TIR by including non-meal readings. If a meal type shows <60% in range at 2h, flag it as needing intervention.

Use the Basal Adequacy drift rates to assess basal rates. Use mg/dL. Be specific with numbers. Use plain markdown, no LaTeX.

The Tandem t:slim X2 does NOT allow adjusting DIA — it is fixed at 5 hours. NEVER recommend changing DIA.

${patientProfile.clinicalNotes ? `Consider the patient's clinical notes: "${patientProfile.clinicalNotes}"` : ""}

${SAFETY_CORE}`;

    // ── Stream the response with periodic keepalive bytes ──
    // sonnet generates the full ~4k-token report before returning (60-90s) — longer
    // than default proxy read timeouts (NPM 60s, Cloudflare ~100s). Flush a space
    // every 10s while the LLM works, then the final JSON. JSON.parse / res.json()
    // ignore leading whitespace, so the client contract is unchanged; NPM
    // proxy_buffering is off so the bytes flush and reset every hop's read timeout.
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const keepalive = setInterval(() => {
          try {
            controller.enqueue(enc.encode(" "));
          } catch {
            // stream already closed
          }
        }, 10_000);

        try {
          try {
            // Primary attempt uses the full system prompt (gemma4-12b has ample context).
            const llmResponse = await generateInsights(model, insightsSystemPrompt, userMessage);
            llmReport = llmResponse.content;
            llmModel = llmResponse.model;
            llmProvider = llmResponse.provider;
            llmDuration = llmResponse.durationMs;

            // Detect garbage output and retry with the compact system prompt + minimal data
            if (isGarbageOutput(llmReport)) {
              console.log(`[insights] Garbage output detected (${llmReport.length} chars), retrying with compact prompt`);
              const minimalMsg = buildMinimalMessage();
              const retryTokens = Math.ceil((compactSystem.length + minimalMsg.length) / 3.5);
              console.log(`[insights] Compact retry: ~${retryTokens} tokens`);
              const retryResponse = await generateInsights(model, compactSystem, minimalMsg);
              if (!isGarbageOutput(retryResponse.content)) {
                llmReport = retryResponse.content;
                llmModel = retryResponse.model;
                llmProvider = retryResponse.provider;
                llmDuration = llmDuration + retryResponse.durationMs;
              }
            }
          } catch (llmErr) {
            // If LLM fails, fall back to a basic stats-only report
            const periodLabel = days <= 7 ? "Weekly" : days <= 14 ? "2-Week" : `${days}-Day`;
            llmReport = `## ${periodLabel} Summary — ${period}\n\n` +
              `**Overall: ${stats.timeInRange.inRange}% Time in Range** with a mean of ${stats.mean} mg/dL (GMI ~${stats.gmi}%). ${stats.count} readings analyzed.\n\n` +
              `*AI analysis unavailable: ${llmErr instanceof Error ? llmErr.message : "Unknown error"}. Showing basic stats only.*`;
            llmModel = "fallback";
            llmProvider = "none";
          }

          // ── Numeric sanity guard (item 15) ──
          // Heuristically extract the first TIR % and mean mg/dL the model cites in its
          // markdown and compare to the computed source values. Attach a warning if they
          // diverge beyond tolerance — never block or alter the report.
          let dataConsistencyWarning: string | undefined;
          {
            // Collect EVERY cited TIR % and mean mg/dL. The report legitimately cites
            // per-meal/per-period TIRs too, so only warn when NONE of the cited values
            // matches the source within tolerance (i.e. the headline figure is absent
            // or wrong) — this avoids false positives from meal-level mentions.
            const citedTirs = [...llmReport.matchAll(/(\d{1,3})\s*%\s*(?:TIR|time in range)/gi)].map((m) => parseInt(m[1], 10));
            const citedMeans = [...llmReport.matchAll(/mean[^\d]{0,15}(\d{2,3})\s*mg\/dL/gi)].map((m) => parseInt(m[1], 10));
            const tirOff = citedTirs.length > 0 && !citedTirs.some((v) => Math.abs(v - stats.timeInRange.inRange) <= 5);
            const meanOff = citedMeans.length > 0 && !citedMeans.some((v) => Math.abs(v - stats.mean) <= 15);
            if (tirOff || meanOff) {
              dataConsistencyWarning = `⚠ AI-stated figures may not match source data (source TIR ${stats.timeInRange.inRange}%, mean ${stats.mean} mg/dL). Trust the dashboard numbers.`;
            }
          }

          // ── Build result ──
          const result: StoredReport = {
            generatedAt: new Date().toISOString(),
            days,
            period,
            model: llmModel,
            provider: llmProvider,
            durationMs: llmDuration,
            summary: {
              readings: stats.count,
              mean: stats.mean,
              tir: stats.timeInRange.inRange,
              gmi: stats.gmi,
              low: stats.timeInRange.low + stats.timeInRange.veryLow,
              veryLow: stats.timeInRange.veryLow,
              high: stats.timeInRange.high,
              veryHigh: stats.timeInRange.veryHigh,
            },
            report: llmReport,
            patterns,
            inputData: insightsInput,
            promptVersion: PROMPT_VERSION,
            dataConsistencyWarning,
            profileChanges: profileChanges.length > 0 ? profileChanges : undefined,
          };

          // ── Persist ──
          cachedReport = result;
          // Save to disk in the background (non-blocking)
          saveReport(result).catch(() => {
            // Save failed — memory cache still works
          });

          controller.enqueue(enc.encode(JSON.stringify(result)));
        } catch (streamErr) {
          const message = streamErr instanceof Error ? streamErr.message : "Unknown error";
          controller.enqueue(enc.encode(JSON.stringify({ error: message })));
        } finally {
          clearInterval(keepalive);
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        // Defense in depth: also tell any nginx hop not to buffer this response.
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

// ── Per-meal-type summary builder ──

function buildMealTypeSummary(
  mealEvents: MealEvent[],
  _carbRatios: CarbRatioResult[],
) {
  const types = ["Breakfast", "Lunch", "Snack", "Dinner"];

  return types.map((type) => {
    const allOfType = mealEvents.filter((m) => m.timeOfDay === type);
    // Only aggregate meals with REAL carbs (matches the Analysis tab UI).
    // Carb-less "bolus_inferred" events are excluded from ratio/TIR math.
    const meals = allOfType.filter((m) => m.source === "carb_entry" || m.totalCarbs > 0);
    // Count carb-less inferred large-bolus events separately (informational).
    const possibleUnloggedMeals = allOfType.filter(
      (m) => m.totalCarbs <= 0 && m.source === "bolus_inferred"
    ).length;

    if (meals.length === 0) {
      return { type, count: 0, avgCarbs: 0, avgInsulin: 0, avgRatioUsed: 0, avgPreMeal: 0, avgPeak: 0, avgPeakTimeMin: 0, avgGlucoseAt2h: 0, pctInRangeAt2h: 0, pctHigh: 0, pctVeryHigh: 0, possibleUnloggedMeals };
    }

    const mealsWithCarbs = meals.filter((m) => m.totalCarbs > 0);
    const mealsWith2h = meals.filter((m) => m.glucoseAt120 !== null);
    const inRangeAt2h = mealsWith2h.filter((m) => m.glucoseAt120! >= 70 && m.glucoseAt120! <= 180);

    // Use mealEvents data only (same source as Analysis tab)
    const pctInRange = mealsWith2h.length > 0
      ? Math.round((inRangeAt2h.length / mealsWith2h.length) * 100)
      : 0;

    const pctHigh = mealsWith2h.length > 0
      ? Math.round((mealsWith2h.filter((m) => m.glucoseAt120! > 180 && m.glucoseAt120! <= 250).length / mealsWith2h.length) * 100)
      : 0;

    const pctVeryHigh = mealsWith2h.length > 0
      ? Math.round((mealsWith2h.filter((m) => m.glucoseAt120! > 250).length / mealsWith2h.length) * 100)
      : 0;

    return {
      type,
      count: meals.length,
      avgCarbs: Math.round(mealsWithCarbs.reduce((s, m) => s + m.totalCarbs, 0) / Math.max(mealsWithCarbs.length, 1)),
      avgInsulin: Math.round(meals.reduce((s, m) => s + m.totalInsulin, 0) / meals.length * 10) / 10,
      avgRatioUsed: mealsWithCarbs.length > 0
        ? Math.round(mealsWithCarbs.reduce((s, m) => s + m.totalCarbs / Math.max(m.totalInsulin, 0.1), 0) / mealsWithCarbs.length * 10) / 10
        : 0,
      avgPreMeal: Math.round(meals.reduce((s, m) => s + m.preMeal, 0) / meals.length),
      avgPeak: Math.round(meals.reduce((s, m) => s + m.peakGlucose, 0) / meals.length),
      avgPeakTimeMin: Math.round(meals.reduce((s, m) => s + m.peakTimeMin, 0) / meals.length),
      avgGlucoseAt2h: mealsWith2h.length > 0
        ? Math.round(mealsWith2h.reduce((s, m) => s + m.glucoseAt120!, 0) / mealsWith2h.length)
        : 0,
      pctInRangeAt2h: pctInRange,
      pctHigh,
      pctVeryHigh,
      possibleUnloggedMeals,
    };
  }).filter((s) => s.count > 0 || (s.possibleUnloggedMeals ?? 0) > 0);
}

// ── Rule-based patterns (kept for the Patterns tab) ──

function buildPatterns(
  stats: ReturnType<typeof calculateStats>,
  hourly: Record<number, { sum: number; count: number; inRange: number }>,
  dayOfWeek: Array<{ day: string; mean: number; timeInRange: number; count: number }>,
  overnightStats: ReturnType<typeof calculateStats>,
  readings: GlucoseReading[],
  treatments: Treatment[],
  corrections: Array<{ time: string; units: number; bgBefore: number; bgAfter60min: number; effectiveISF: number }>,
  days: number,
) {
  const patterns: StoredReport["patterns"] = [];
  const hourlyStats = Object.entries(hourly).map(([h, v]) => ({
    hour: parseInt(h),
    avg: Math.round(v.sum / v.count),
    tir: Math.round((v.inRange / v.count) * 100),
    count: v.count,
  }));
  hourlyStats.sort((a, b) => a.tir - b.tir);
  const worstHour = hourlyStats[0];
  const bestHour = hourlyStats[hourlyStats.length - 1];

  const sortedDays = [...dayOfWeek].sort((a, b) => a.timeInRange - b.timeInRange);
  const worstDay = sortedDays[0];
  const bestDay = sortedDays[sortedDays.length - 1];

  const fmtHour = (h: number) => h === 0 ? "12 AM" : h === 12 ? "12 PM" : h > 12 ? `${h - 12} PM` : `${h} AM`;

  // ── Worst hour of the day ──
  if (worstHour && worstHour.tir < 80) {
    const severity = worstHour.tir < 50 ? "high" : worstHour.tir < 65 ? "moderate" : "low";
    patterns.push({
      id: "worst_hour",
      title: `Worst Hour: ${fmtHour(worstHour.hour)} (${worstHour.tir}% TIR, avg ${worstHour.avg})`,
      severity,
      description: `${fmtHour(worstHour.hour)} averages ${worstHour.avg} mg/dL with only ${worstHour.tir}% TIR — the worst hour of the day.`,
      suggestion: "Check what's happening at this time — meals, activity changes, or basal rate gaps.",
    });
  }

  // ── Morning spike (8-10 AM) ──
  const morningHours = [8, 9, 10].map((h) => hourly[h]).filter(Boolean);
  if (morningHours.length > 0) {
    const morningAvg = Math.round(morningHours.reduce((s, h) => s + h.sum / h.count, 0) / morningHours.length);
    const morningTir = Math.round(morningHours.reduce((s, h) => s + h.inRange / h.count, 0) / morningHours.length * 100);
    if (morningAvg > 150) {
      patterns.push({
        id: "morning_spike",
        title: `Morning Spike (8–10 AM avg: ${morningAvg} mg/dL, ${morningTir}% TIR)`,
        severity: morningAvg > 180 ? "high" : "moderate",
        description: `Post-breakfast glucose averages ${morningAvg} mg/dL with ${morningTir}% TIR.`,
        suggestion: "Consider pre-bolusing 10-15 min before breakfast, or review morning carb ratio.",
      });
    }
  }

  // ── Best hour of the day ──
  if (bestHour && bestHour.tir >= 80) {
    patterns.push({
      id: "best_period",
      title: `Best Control: ${fmtHour(bestHour.hour)} (${bestHour.tir}% TIR, avg ${bestHour.avg})`,
      severity: "positive",
      description: `${fmtHour(bestHour.hour)} averages ${bestHour.avg} mg/dL with ${bestHour.tir}% TIR. Whatever the routine is at this time, it's working.`,
      suggestion: "Keep doing what you're doing during this period.",
    });
  }

  // ── Day of week patterns ──
  if (worstDay && bestDay && worstDay.day !== bestDay.day) {
    const spread = bestDay.timeInRange - worstDay.timeInRange;
    if (spread >= 15) {
      patterns.push({
        id: "day_spread",
        title: `${worstDay.day} vs ${bestDay.day}: ${spread}% TIR gap`,
        severity: worstDay.timeInRange < 60 ? "moderate" : "low",
        description: `${worstDay.day} is the worst day (${worstDay.timeInRange}% TIR, avg ${worstDay.mean}) while ${bestDay.day} is the best (${bestDay.timeInRange}% TIR, avg ${bestDay.mean}).`,
        suggestion: `What's different about ${worstDay.day}s — meals, sleep, activity, schedule?`,
      });
    }
  }

  // ── Overnight patterns ──
  if (overnightStats.timeInRange.inRange < 70) {
    const lowPct = overnightStats.timeInRange.low + overnightStats.timeInRange.veryLow;
    const highPct = overnightStats.timeInRange.high + overnightStats.timeInRange.veryHigh;
    patterns.push({
      id: "overnight_issues",
      title: `Overnight Needs Attention (${overnightStats.timeInRange.inRange}% TIR)`,
      severity: overnightStats.timeInRange.inRange < 50 ? "high" : "moderate",
      description: `Overnight (10 PM–6 AM) is ${overnightStats.timeInRange.inRange}% TIR with avg ${overnightStats.mean} mg/dL. ${highPct}% high, ${lowPct}% low.`,
      suggestion: lowPct > 10
        ? "Overnight lows suggest basal may be too high, or late corrections are stacking."
        : "Review overnight basal rates and dinner bolusing with endo.",
    });
  } else if (overnightStats.timeInRange.inRange >= 75) {
    patterns.push({
      id: "overnight_good",
      title: `Good Overnight Control (${overnightStats.timeInRange.inRange}% TIR)`,
      severity: "positive",
      description: `Overnight averaging ${overnightStats.mean} mg/dL with ${overnightStats.timeInRange.inRange}% TIR.`,
      suggestion: "Overnight settings are dialed in.",
    });
  }

  // ── Glucose variability ──
  if (stats.cv <= 33) {
    patterns.push({
      id: "low_cv",
      title: `Low Variability (CV: ${stats.cv}%)`,
      severity: "positive",
      description: `CV of ${stats.cv}% is below the 36% target — glucose is stable and consistent.`,
      suggestion: "Pump settings are well-matched to routine.",
    });
  } else if (stats.cv > 36) {
    patterns.push({
      id: "high_cv",
      title: `${stats.cv > 40 ? "High" : "Elevated"} Variability (CV: ${stats.cv}%)`,
      severity: stats.cv > 40 ? "moderate" : "low",
      description: `CV of ${stats.cv}% is above the 36% target — glucose is swinging more than ideal.`,
      suggestion: "Focus on consistent meal timing and carb estimation. Consider post-meal walks.",
    });
  }

  // ── Lows ──
  const totalLow = stats.timeInRange.low + stats.timeInRange.veryLow;
  if (stats.timeInRange.veryLow >= 1) {
    patterns.push({
      id: "dangerous_lows",
      title: `Dangerous Lows: ${stats.timeInRange.veryLow}% below 54 mg/dL`,
      severity: "high",
      description: `${stats.timeInRange.veryLow}% of readings are below 54 mg/dL (very low). Target is <1%.`,
      suggestion: "Urgent: review basal rates, correction factors, and carb ratios to reduce severe lows.",
    });
  } else if (totalLow > 4) {
    patterns.push({
      id: "too_many_lows",
      title: `Too Many Lows (${totalLow}% below 70)`,
      severity: "moderate",
      description: `${totalLow}% of time below 70 mg/dL exceeds the 4% target.`,
      suggestion: "Review basal rates and correction factors — reducing lows takes priority over reducing highs.",
    });
  } else if (totalLow <= 2) {
    patterns.push({
      id: "minimal_lows",
      title: `Minimal Lows (${totalLow}% below 70)`,
      severity: "positive",
      description: `Only ${totalLow}% of readings below 70 mg/dL — well within the <4% target.`,
      suggestion: "Great low prevention. Safe foundation to tighten other settings if needed.",
    });
  }

  // ── Overall TIR assessment ──
  if (stats.timeInRange.inRange >= 80) {
    patterns.push({
      id: "excellent_tir",
      title: `Excellent Time in Range (${stats.timeInRange.inRange}%)`,
      severity: "positive",
      description: `${stats.timeInRange.inRange}% TIR well exceeds the 70% target. Outstanding management.`,
      suggestion: "Keep it up — this level of control significantly reduces long-term complications.",
    });
  } else if (stats.timeInRange.inRange < 60) {
    patterns.push({
      id: "low_tir",
      title: `Time in Range Below Target (${stats.timeInRange.inRange}%)`,
      severity: "high",
      description: `${stats.timeInRange.inRange}% TIR is below the 70% target. ${stats.timeInRange.high + stats.timeInRange.veryHigh}% high, ${totalLow}% low.`,
      suggestion: "Schedule an endo review to discuss basal rates, carb ratios, and correction factors.",
    });
  }

  // ── Site Change Degradation ──
  const siteChangeTreatments = treatments.filter((t) => t.eventType === "Site Change");
  if (siteChangeTreatments.length >= 2) {
    // Check TIR in the 12h before each site change vs 12h after
    let preTir = 0, postTir = 0, count = 0;
    for (const sc of siteChangeTreatments) {
      const scTime = new Date(sc.created_at || sc.mills || 0).getTime();
      if (!scTime) continue;
      const pre = readings.filter((r) => r.date >= scTime - 12 * 3600000 && r.date < scTime);
      const post = readings.filter((r) => r.date >= scTime && r.date < scTime + 12 * 3600000);
      if (pre.length >= 20 && post.length >= 20) {
        const preInRange = pre.filter((r) => r.sgv >= 70 && r.sgv <= 180).length / pre.length * 100;
        const postInRange = post.filter((r) => r.sgv >= 70 && r.sgv <= 180).length / post.length * 100;
        preTir += preInRange;
        postTir += postInRange;
        count++;
      }
    }
    if (count > 0) {
      const avgPre = Math.round(preTir / count);
      const avgPost = Math.round(postTir / count);
      const degradation = avgPost - avgPre;
      if (degradation > 15) {
        patterns.push({
          id: "site_degradation",
          title: `Site Degradation: TIR drops ${degradation}% before changes`,
          severity: "moderate",
          description: `TIR averages ${avgPre}% in the 12h before site changes vs ${avgPost}% in the 12h after. Old sites are absorbing poorly by day 3.`,
          suggestion: "Consider changing sites a day earlier, or watch for rising glucose as a signal to change sooner.",
        });
      } else if (degradation < -5) {
        patterns.push({
          id: "site_consistent",
          title: `Consistent Site Absorption`,
          severity: "positive",
          description: `TIR is ${avgPre}% before site changes and ${avgPost}% after — absorption stays consistent throughout site life.`,
          suggestion: "Current site change schedule is working well.",
        });
      }
    }
  }

  // ── Correction Stacking / Effectiveness ──
  if (corrections.length >= 3) {
    const negativeISF = corrections.filter((c) => c.effectiveISF < 0);
    const weakISF = corrections.filter((c) => c.effectiveISF >= 0 && c.effectiveISF < 20);
    const effectiveISF = corrections.filter((c) => c.effectiveISF >= 20);

    if (negativeISF.length >= 2) {
      patterns.push({
        id: "correction_failures",
        title: `${negativeISF.length} Correction Failures (negative ISF)`,
        severity: "high",
        description: `${negativeISF.length} of ${corrections.length} corrections resulted in glucose RISING despite insulin. This typically indicates site absorption failure or extreme insulin resistance.`,
        suggestion: "When a correction doesn't work within 60 min, consider changing the infusion site immediately.",
      });
    } else if (weakISF.length > corrections.length * 0.4) {
      patterns.push({
        id: "weak_corrections",
        title: `Corrections Often Weak (${weakISF.length}/${corrections.length} under-effective)`,
        severity: "moderate",
        description: `${Math.round(weakISF.length / corrections.length * 100)}% of corrections had an effective ISF under 20 mg/dL per unit — significantly weaker than expected.`,
        suggestion: "The programmed correction factor may be too conservative, or corrections are being given when site absorption is degraded.",
      });
    } else if (effectiveISF.length > corrections.length * 0.7) {
      patterns.push({
        id: "corrections_effective",
        title: `Corrections Working Well (${Math.round(effectiveISF.length / corrections.length * 100)}% effective)`,
        severity: "positive",
        description: `${effectiveISF.length} of ${corrections.length} corrections brought glucose down effectively. The correction factor is well-calibrated.`,
        suggestion: "Current ISF settings are appropriate.",
      });
    }
  }

  // ── Weekend vs Weekday ──
  const weekdays = dayOfWeek.filter((d) => !["Saturday", "Sunday"].includes(d.day));
  const weekends = dayOfWeek.filter((d) => ["Saturday", "Sunday"].includes(d.day));
  if (weekdays.length > 0 && weekends.length > 0) {
    const wdTir = Math.round(weekdays.reduce((s, d) => s + d.timeInRange, 0) / weekdays.length);
    const weTir = Math.round(weekends.reduce((s, d) => s + d.timeInRange, 0) / weekends.length);
    const wdMean = Math.round(weekdays.reduce((s, d) => s + d.mean, 0) / weekdays.length);
    const weMean = Math.round(weekends.reduce((s, d) => s + d.mean, 0) / weekends.length);
    const diff = Math.abs(wdTir - weTir);
    if (diff >= 10) {
      const better = wdTir > weTir ? "weekdays" : "weekends";
      const worse = wdTir > weTir ? "weekends" : "weekdays";
      patterns.push({
        id: "weekend_weekday",
        title: `${diff}% TIR gap: ${better} vs ${worse}`,
        severity: diff >= 20 ? "moderate" : "low",
        description: `Weekdays average ${wdTir}% TIR (mean ${wdMean}) vs weekends ${weTir}% TIR (mean ${weMean}). ${better === "weekdays" ? "School routine may help with consistency." : "Relaxed weekend schedule seems to help."}`,
        suggestion: `Identify what's different about ${worse} — meal timing, sleep schedule, activity levels?`,
      });
    }
  }

  // ── Meal Bolus Frequency ──
  const boluses = treatments.filter((t) => t.insulin && t.insulin > 0);
  const carbEntries = treatments.filter((t) => t.carbs && t.carbs > 0);
  const avgBolusesPerDay = boluses.length / Math.max(days, 1);
  if (avgBolusesPerDay < 3) {
    patterns.push({
      id: "low_bolus_freq",
      title: `Low Bolus Frequency (${avgBolusesPerDay.toFixed(1)}/day)`,
      severity: avgBolusesPerDay < 2 ? "high" : "moderate",
      description: `Averaging only ${avgBolusesPerDay.toFixed(1)} boluses per day — most T1D patients need 4-6. Missed meal boluses lead to sustained highs that Control-IQ can't fully correct.`,
      suggestion: "Check if meals are being bolused consistently, especially lunch at school.",
    });
  } else if (carbEntries.length > 0 && boluses.length > carbEntries.length * 1.5) {
    patterns.push({
      id: "many_corrections",
      title: `Many Correction Boluses (${boluses.length} boluses, ${carbEntries.length} carb entries)`,
      severity: "low",
      description: `${boluses.length - carbEntries.length} boluses appear to be corrections rather than meal boluses. Frequent corrections suggest meal dosing may be insufficient.`,
      suggestion: "If corrections are routine after meals, the carb ratio may need tightening.",
    });
  }

  // ── High Glucose Duration ──
  const highEpisodes: number[] = [];
  let currentHighStart: number | null = null;
  const sortedReadings = [...readings].sort((a, b) => a.date - b.date);
  for (const r of sortedReadings) {
    if (r.sgv > 250) {
      if (currentHighStart === null) currentHighStart = r.date;
    } else {
      if (currentHighStart !== null) {
        highEpisodes.push((r.date - currentHighStart) / 60000); // minutes
        currentHighStart = null;
      }
    }
  }
  if (highEpisodes.length >= 3) {
    const avgDuration = Math.round(highEpisodes.reduce((s, d) => s + d, 0) / highEpisodes.length);
    const longEpisodes = highEpisodes.filter((d) => d > 120);
    if (avgDuration > 90 || longEpisodes.length >= 2) {
      patterns.push({
        id: "sustained_highs",
        title: `Sustained Highs: ${highEpisodes.length} episodes above 250, avg ${avgDuration} min`,
        severity: avgDuration > 120 ? "high" : "moderate",
        description: `${highEpisodes.length} episodes above 250 mg/dL averaging ${avgDuration} minutes each. ${longEpisodes.length} lasted over 2 hours.`,
        suggestion: "Sustained highs (vs quick spikes) suggest missed boluses, insufficient carb ratios, or site issues. Quick spikes that recover are less concerning.",
      });
    } else {
      patterns.push({
        id: "brief_highs",
        title: `Brief High Spikes (avg ${avgDuration} min above 250)`,
        severity: "low",
        description: `${highEpisodes.length} spikes above 250 mg/dL but they average only ${avgDuration} minutes — recovering relatively quickly.`,
        suggestion: "Spikes that resolve quickly indicate insulin is working but may need earlier timing (pre-bolus).",
      });
    }
  }

  // ── Dawn Phenomenon ──
  const dawnHours = [4, 5, 6, 7].map((h) => hourly[h]).filter(Boolean);
  if (dawnHours.length >= 3) {
    const h4 = hourly[4]; const h7 = hourly[7];
    if (h4 && h7) {
      const avg4 = Math.round(h4.sum / h4.count);
      const avg7 = Math.round(h7.sum / h7.count);
      const rise = avg7 - avg4;
      if (rise > 25) {
        patterns.push({
          id: "dawn_phenomenon",
          title: `Dawn Phenomenon: +${rise} mg/dL rise (4→7 AM)`,
          severity: rise > 40 ? "moderate" : "low",
          description: `Glucose rises from ${avg4} at 4 AM to ${avg7} at 7 AM (+${rise} mg/dL) before eating. This pre-breakfast rise is classic dawn phenomenon.`,
          suggestion: "Discuss increasing the 4-7 AM basal rate with endo. Some pumps can auto-adjust but Control-IQ may not catch it early enough.",
        });
      } else if (rise < 10 && avg4 < 150) {
        patterns.push({
          id: "no_dawn",
          title: `Minimal Dawn Rise (+${rise} mg/dL, 4→7 AM)`,
          severity: "positive",
          description: `Only +${rise} mg/dL rise from 4 AM (${avg4}) to 7 AM (${avg7}). Morning basal rates are well-calibrated.`,
          suggestion: "Pre-breakfast basal is holding steady — no dawn phenomenon concerns.",
        });
      }
    }
  }

  return patterns;
}
