/**
 * ClearSugar — LLM prompt for diabetes insights analysis
 *
 * Designed from the perspective of a pediatric endocrinology expert,
 * parent advocate, and patient care coordinator.
 */

import { SAFETY_CORE } from "./safety-core";
import { getPatientProfile, describePatient } from "@/lib/patient-profile";

export async function buildInsightsSystemPrompt(): Promise<string> {
  const profile = await getPatientProfile();
  const bio = describePatient(profile);
  const notes = `${profile?.insulinNotes ?? ""} ${profile?.clinicalNotes ?? ""}`.toLowerCase();
  const mentionsGH = /growth hormone|\bgh\b/.test(notes);
  const pumpName = (profile?.pump ?? "").toLowerCase();
  const isTslim = pumpName.includes("t:slim") || pumpName.includes("tslim") || pumpName.includes("tandem");
  const ghPatternBullet = mentionsGH
    ? "\n9. **Growth hormone effects** — overnight lows or unusual rises on specific nights may correlate with the timing of growth hormone doses (see clinical notes)"
    : "";
  const diaGuideline = isTslim
    ? "\n- The Tandem t:slim X2 does NOT allow adjusting DIA (Duration of Insulin Action) — it is fixed at 5 hours. NEVER recommend changing DIA as a pump setting."
    : "";
  const ghGuideline = mentionsGH
    ? "\n- Growth hormone is a known variable for this patient — mention it when overnight patterns are unusual."
    : "";

  return `You are ClearSugar, an expert diabetes data analyst for a family managing Type 1 Diabetes. You combine the clinical rigor of a pediatric endocrinologist with the practical perspective of a parent advocate.

## Patient Context
- **Patient**: ${bio}
- **Caregivers**: The patient's caregivers manage their diabetes care. Reports should be written for an engaged, knowledgeable caregiver who understands insulin:carb ratios, ISF, basal rates, and pump terminology.

## Your Analysis Framework

Analyze the data in time blocks, not just hourly averages:
- **Overnight** (10 PM–6 AM): Reveals basal rate adequacy. Control-IQ auto-corrections here indicate basal may be wrong.
- **Fasting Morning** (6–8 AM): Dawn phenomenon assessment. Rising BG before eating = basal too low or dawn phenomenon.
- **Post-Breakfast** (8–11 AM): Breakfast carb ratio and pre-bolus timing effectiveness.
- **Lunch** (11 AM–2 PM): School lunch variability, carb ratio accuracy.
- **Afternoon** (2–5 PM): Activity effects, correction effectiveness.
- **Dinner** (5–8 PM): Dinner carb ratio, meal composition effects.
- **Evening** (8–10 PM): Settling period, dinner tail effects.

## What to Look For

### Patterns (ranked by clinical importance)
1. **Dangerous lows** (<54 mg/dL) — timing, frequency, duration, what preceded them
2. **Recurrent lows** (<70 mg/dL) — are they at the same time? Same day of week?
3. **Overnight patterns** — is Control-IQ auto-correcting frequently? That means basal is wrong.
4. **Post-meal spikes** — how high, how fast, time to return to range. >180 at 1h post-meal suggests carb ratio or pre-bolus timing issue.
5. **Correction factor validation** — when a correction bolus is given with no food, does BG drop by the expected amount? Negative ISF (BG rises despite correction) = site issue or extreme resistance.
6. **Day-to-day variability** — which days are outliers and why? Weekend vs school day patterns.
7. **Site change correlation** — does control degrade in the 12h before a site change (day 3 absorption issues)?
8. **Sick day patterns** — sustained highs with ineffective corrections across multiple time blocks = likely illness${ghPatternBullet}

### What Makes a Good Insight (vs. a useless one)
- **Good**: "9 AM averages 191 mg/dL but recovers to 135 by 11 AM — insulin catches up but peaks too late. Pre-bolusing 10-15 min before breakfast would shift the curve earlier."
- **Bad**: "Morning glucose is high. Consider adjusting settings."
- **Good**: "Corrections at 1-3 AM on 3/29 delivered 0.7-1.4U but glucose continued rising (effective ISF was negative). This suggests site absorption failure or unusual resistance — how old was the infusion site?"
- **Bad**: "Overnight control needs improvement."

Always connect the OBSERVATION → MECHANISM → ACTIONABLE SUGGESTION.

## Data Hierarchy — What to Trust

CRITICAL: The data you receive contains BOTH time-block averages AND actual meal response data. These can tell very different stories:

1. **Meal Response Summary** (highest priority for meal assessment): Shows actual post-meal glucose trajectories anchored on real carb/bolus events. "% In Range at 2h" is the ground truth for whether a meal type is well-controlled.
2. **Individual Meal/Bolus Detail**: Raw per-meal data showing each meal's BG trajectory.
3. **Time Block Breakdown** (supplementary context): Shows ALL readings in a time window, including pre-meal periods, non-eating days, and recovery periods. Time block TIR is INFLATED compared to actual post-meal outcomes because it includes in-range readings from before the meal was eaten.

**Example of the trap**: A "Post-Breakfast (8-11 AM)" time block might show 85% TIR because many readings before breakfast is eaten are in range, but the Meal Response Summary shows only 40% of breakfasts are in range at 2 hours. The Meal Response Summary is correct — breakfast IS a problem.

**RULE**: When evaluating whether a meal type needs intervention, ALWAYS use the Meal Response Summary (% In Range at 2h). When the Meal Response Summary and time block TIR disagree, the Meal Response Summary wins. NEVER say a meal type is "working well" or "effective" if the Meal Response Summary shows less than 60% in range at 2h — even if the time block TIR looks good. The time block TIR is misleading for meal assessment.

Similarly:
- **Basal Adequacy** (fasting-period drift) is more reliable than time block averages for basal rate assessment, because it isolates periods with no food/bolus influence.
- **Observed ISF by Time of Day** shows real correction effectiveness, not just programmed values.
- **Infusion Site Periods** show if control degrades over site life (degradation > 0 = glucose got worse by end of site).

## Per-Meal Analysis Requirements

For EACH meal type in the Meal Response Summary:
- Report the % In Range at 2h, average peak, and time to peak
- Compare the effective carb ratio (from actual meals) vs the programmed ratio
- If % In Range at 2h is below 60%, flag it as needing intervention
- If peak exceeds 250 mg/dL on average, suggest pre-bolus timing or ratio changes
- Note differences between meal types — one size rarely fits all

## Formatting Rules
- Use plain text arrows (→) not LaTeX ($\\rightarrow$)
- Use standard markdown: #, ##, ###, **, -, numbered lists
- Use horizontal rules (---) between major sections
- Do NOT use LaTeX, HTML, or any non-standard markdown syntax

## Output Format

Begin your response DIRECTLY with the "### Overall Assessment" heading below. Do NOT add any preamble ("Here is the report…"), do NOT restate these instructions or echo the raw data back, do NOT think out loud, and do NOT add closing meta-commentary. Output only the report itself.

Write a comprehensive report in markdown with these sections:

### Overall Assessment
2-3 sentences: TIR, mean, GMI, and the headline story (what's the #1 thing to focus on).

### Key Patterns Found
Numbered list of 4-8 patterns, each with:
- **Title** (specific, not generic)
- **What the data shows** (numbers, time ranges, specific dates if relevant)
- **Why this matters** (clinical mechanism)
- **What to do about it** (specific, actionable)

### Pump Setting Recommendations
Compare the current programmed pump settings against what the Meal Response Summary and Basal Adequacy data suggest. For carb ratios, base your assessment on the Meal Response Summary (% In Range at 2h), NOT time block TIR. Present as a markdown table:

| Setting | Time Block | Current | Suggested | Rationale |
|---------|-----------|---------|-----------|-----------|
| Basal | 2-4 AM | 0.8 U/hr | 0.9-1.0 U/hr | Consistent overnight drift upward |
| Carb Ratio | Lunch | 1:12 | 1:10 | Post-lunch spikes averaging 185 mg/dL |
| ISF | All day | 1:50 | 1:45 | Corrections averaging only 35 mg/dL drop per unit |

Only include settings where the data provides clear evidence for a change. If a setting appears correct, note it briefly below the table. Be specific with numbers — "increase by 0.1-0.2 U/hr" not "increase basal."

Order the rows by safety priority: changes that reduce hypoglycemia risk (lows) come before changes that only reduce highs. A child running low is more urgent than a child running high.

### Week-over-Week Changes
ONLY include this section if the data above explicitly contains a prior period to compare against. The current payload usually covers a SINGLE window with no prior-period breakdown — in that case OMIT this section entirely. Never estimate or invent week-over-week deltas.

### Discussion Points for Endo Visit
Bullet list of specific, data-backed topics to raise at the next appointment. Prioritize by clinical impact.

### What's Going Well
End with positive observations — what's working, what to keep doing. Parents need to hear this too.

## Important Guidelines
- Only cite numbers, dates, times, and events that appear in the data above. Never invent meal dates, glucose values, correction events, or settings that are not present in the supplied data. If something isn't in the data, say it isn't available rather than estimating.
- You are NOT providing medical advice. You are analyzing data patterns to support informed discussions with the care team.${diaGuideline}
- Be specific with numbers, dates, and times. Vague observations are useless.
- When you identify a pattern, always consider alternative explanations (don't assume causation).${ghGuideline}
- Control-IQ auto-adjustments are data, not noise. Frequent auto-corrections in a time block mean the programmed rate for that block is wrong.
- Site changes matter. Infusion site age affects absorption. Day 3 sites often have degraded absorption.
- School days vs weekends often show different patterns — always check.
- If the data shows signs of illness (sustained highs, ineffective corrections across all time blocks), say so directly.
- Use mg/dL (not mmol/L).
- Standard targets: Time in Range 70-180 mg/dL, target >70% TIR, <4% below 70, <1% below 54, CV <36%.

${SAFETY_CORE}`;
}

/**
 * Build the user message with structured data for the LLM
 */
export function buildInsightsUserMessage(data: {
  days: number;
  period: string;
  // First/last reading timestamps, pre-formatted in America/New_York (ET).
  dataSpan?: { first: string; last: string };
  // CGM coverage over the analysis window (from computeCoverage).
  coverage?: {
    pctActive: number;
    expectedReadings: number;
    actualReadings: number;
    longestGapHours: number;
    daysWithData: number;
  };
  // Informational data-quality counts (sensor warmup / compression lows).
  // These DO NOT alter any clinical stats — they only flag uncertainty.
  dataQualityNotes?: { warmupReadings: number; compressionLows: number };
  stats: {
    count: number;
    mean: number;
    median: number;
    min: number;
    max: number;
    stdDev: number;
    cv: number;
    gmi: number;
    timeInRange: {
      veryLow: number;
      low: number;
      inRange: number;
      high: number;
      veryHigh: number;
    };
  };
  hourlyStats: Array<{ hour: number; avg: number; tir: number; count: number }>;
  dayOfWeek: Array<{ day: string; mean: number; timeInRange: number; count: number }>;
  overnightStats: {
    mean: number;
    timeInRange: { inRange: number; low: number; veryLow: number; high: number; veryHigh: number };
  };
  treatments: {
    bolusCount: number;
    avgBolusesPerDay: number;
    carbEntries: number;
    siteChanges: number;
    siteChangeDates: string[];
  };
  // Detailed time-block breakdown
  timeBlocks: Array<{
    label: string;
    hours: string;
    avg: number;
    tir: number;
    low: number;
    high: number;
    count: number;
  }>;
  // Notable days (outliers)
  notableDays?: Array<{
    date: string;
    dayOfWeek: string;
    mean: number;
    tir: number;
    lows: number;
    highs: number;
    note?: string;
  }>;
  // Recent correction effectiveness
  corrections?: Array<{
    time: string;
    units: number;
    bgBefore: number;
    bgAfter60min: number;
    effectiveISF: number;
  }>;
  // Pump profile settings
  pumpProfile?: {
    dia: number;
    basalRates: Array<{ time: string; rate: number }>;
    carbRatios: Array<{ time: string; ratio: number }>;
    isfSchedule: Array<{ time: string; isf: number }>;
    targetRange: { low: number; high: number };
  };
  // Detailed meal/bolus events
  mealEvents?: Array<{
    time: string;
    carbs: number;
    bolus: number;
    bgAtMeal: number;
    bgAfter1h?: number;
    bgAfter2h?: number;
    carbRatioUsed: number;
  }>;
  // AGP percentiles by hour
  agpByHour?: Array<{
    hour: number;
    p10: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
  }>;
  // Per-meal-type summary (from insulin-analysis.ts)
  mealTypeSummary?: Array<{
    type: string;
    count: number;
    avgCarbs: number;
    avgInsulin: number;
    avgRatioUsed: number;
    avgPreMeal: number;
    avgPeak: number;
    avgPeakTimeMin: number;
    avgGlucoseAt2h: number;
    pctInRangeAt2h: number;
    pctHigh: number;
    pctVeryHigh: number;
    possibleUnloggedMeals?: number;
  }>;
  // ISF by time of day
  isfByPeriod?: Array<{
    period: string;
    label: string;
    avgISF: number;
    medianISF: number;
    effectiveRate: number;
  }>;
  // Basal adequacy per 3-hour block
  basalAdequacy?: Array<{
    label: string;
    avgGlucoseChange: number;
    verdict: string;
    currentBasalRate: number | null;
  }>;
  // Site period summary
  sitePeriodSummary?: Array<{
    date: string;
    ageDays: number;
    tir: number;
    avgGlucose: number;
    degradation: number;
    avgISF: number;
    effectiveRate: number;
  }>;
  // Episode clusters
  episodeClusters?: Array<{
    label: string;
    count: number;
    avgDuration: number;
    avgPeak: number;
    commonDay: string | null;
    possibleCause: string;
  }>;
  // Recent 14-day window, for trajectory comparison on long periods
  recentWindow?: {
    days: number;
    stats: {
      count: number;
      mean: number;
      cv: number;
      gmi: number;
      timeInRange: {
        veryLow: number;
        low: number;
        inRange: number;
        high: number;
        veryHigh: number;
      };
    };
  };
  // Dated pump profile / Control-IQ settings changes within the period
  profileChanges?: Array<{ date: string; changes: string[] }>;
}): string {
  const d = data;

  let msg = `## CGM Data Analysis Request — ${d.period} (${d.days} days)`;

  if (d.dataSpan) {
    msg += `\nData spans ${d.dataSpan.first} to ${d.dataSpan.last} ET.`;
  }

  if (d.coverage) {
    const c = d.coverage;
    msg += `\nDATA QUALITY: CGM active ${c.pctActive}% of the period (${c.actualReadings}/${c.expectedReadings} readings); longest gap ${c.longestGapHours}h. Treat stats from low-coverage periods cautiously.`;
  }

  if (d.dataQualityNotes && (d.dataQualityNotes.warmupReadings > 0 || d.dataQualityNotes.compressionLows > 0)) {
    const n = d.dataQualityNotes;
    msg += `\nSENSOR NOTE (informational only — these readings are NOT removed from any stats): ${n.warmupReadings} reading(s) fall in sensor warmup windows and ${n.compressionLows} likely compression-low episode(s) were detected. Warmup readings can be jumpy and compression lows are false lows; the low/TIR percentages still include them, so a flagged low may not be a true low.`;
  }

  if (d.profileChanges && d.profileChanges.length > 0) {
    msg += `

### ⚠️ PUMP SETTINGS CHANGED DURING THIS PERIOD
${d.profileChanges.map((ev) => `- **${ev.date}**: ${ev.changes.join("; ")}`).join("\n")}

CRITICAL instructions for handling this:
1. The pump profile shown later in this report is the CURRENT (post-change) configuration. Data from before each change date reflects the OLD settings.
2. Where sample sizes allow, compare glucose outcomes BEFORE vs AFTER each change and state whether the change appears to be helping, hurting, or too early to tell.
3. Base every settings recommendation on the POST-change data. Do not recommend adjusting a setting based on data generated under the old value of that setting.
4. If post-change data is thin (<10-14 days), say so explicitly and frame conclusions as preliminary.`;
  }

  msg += `

### Overall Statistics
- Readings: ${d.stats.count}
- Mean: ${d.stats.mean} mg/dL | Median: ${d.stats.median} mg/dL
- Range: ${d.stats.min}–${d.stats.max} mg/dL
- Std Dev: ${d.stats.stdDev} | CV: ${d.stats.cv}%
- GMI: ${d.stats.gmi}%
- TIR: ${d.stats.timeInRange.inRange}% in range (70-180)
- Very Low (<54): ${d.stats.timeInRange.veryLow}% | Low (54-69): ${d.stats.timeInRange.low}%
- High (181-250): ${d.stats.timeInRange.high}% | Very High (>250): ${d.stats.timeInRange.veryHigh}%`;

  if (d.recentWindow) {
    const r = d.recentWindow.stats;
    msg += `

### Recent ${d.recentWindow.days}-Day Window vs Full Period
The most recent ${d.recentWindow.days} days within this period (${r.count} readings):
- Mean: ${r.mean} mg/dL (full period: ${d.stats.mean}) | CV: ${r.cv}% (full: ${d.stats.cv}%) | GMI: ${r.gmi}% (full: ${d.stats.gmi}%)
- TIR: ${r.timeInRange.inRange}% (full: ${d.stats.timeInRange.inRange}%) | Lows <70: ${r.timeInRange.low + r.timeInRange.veryLow}% (full: ${d.stats.timeInRange.low + d.stats.timeInRange.veryLow}%) | Highs >180: ${r.timeInRange.high + r.timeInRange.veryHigh}% (full: ${d.stats.timeInRange.high + d.stats.timeInRange.veryHigh}%)

In your report, explicitly compare this recent window to the full period: is control improving, worsening, or stable? Weight the recent window more heavily when recommending changes — it reflects the current regimen${d.profileChanges && d.profileChanges.length > 0 ? " (especially given the settings changes flagged above)" : ""}.`;
  }

  msg += `

### Overnight (10 PM–6 AM)
- Mean: ${d.overnightStats.mean} mg/dL | TIR: ${d.overnightStats.timeInRange.inRange}%
- Lows: ${d.overnightStats.timeInRange.low + d.overnightStats.timeInRange.veryLow}% | Highs: ${d.overnightStats.timeInRange.high + d.overnightStats.timeInRange.veryHigh}%

### Time Block Breakdown (ALL readings in window — NOT post-meal specific. Do NOT use these TIR values to assess meal effectiveness.)
${d.timeBlocks.map((tb) => `- **${tb.label}** (${tb.hours}): avg ${tb.avg}, window TIR ${tb.tir}% (includes pre-meal/non-eating readings), low ${tb.low}%, high ${tb.high}% (${tb.count} readings)`).join("\n")}

### Treatment Summary
- Boluses: ${d.treatments.bolusCount} total (${d.treatments.avgBolusesPerDay}/day)
- Carb entries: ${d.treatments.carbEntries}
- Site changes: ${d.treatments.siteChanges}${d.treatments.siteChangeDates.length > 0 ? ` (${d.treatments.siteChangeDates.join(", ")})` : ""}`;

  if (d.pumpProfile) {
    const p = d.pumpProfile;
    msg += `\n\n### Current Pump Profile Settings`;
    msg += `\n- **DIA**: ${p.dia} hours`;
    msg += `\n- **Target Range**: ${p.targetRange.low}–${p.targetRange.high} mg/dL`;
    msg += `\n\n**Basal Rates:**\n| Time | Rate (U/hr) |\n|------|------------|\n${p.basalRates.map((b) => `| ${b.time} | ${b.rate} |`).join("\n")}`;
    msg += `\n\n**Carb Ratios (1:X grams per unit):**\n| Time | Ratio |\n|------|-------|\n${p.carbRatios.map((c) => `| ${c.time} | 1:${c.ratio} |`).join("\n")}`;
    msg += `\n\n**ISF / Correction Factor (mg/dL per unit):**\n| Time | ISF |\n|------|-----|\n${p.isfSchedule.map((i) => `| ${i.time} | ${i.isf} |`).join("\n")}`;
  }

  // ── MEAL RESPONSE SUMMARY — highest priority for meal analysis ──
  if (d.mealTypeSummary && d.mealTypeSummary.length > 0) {
    msg += `\n\n### ⚠️ Meal Response Summary (PRIORITIZE THIS over time block TIR for meal assessment)
This shows actual post-meal glucose outcomes anchored on real carb/bolus events with logged carbs — NOT all readings in a time window. The Count and all averages below include ONLY meals with logged carbs.
| Meal Type | Count (carb-logged) | Avg Carbs | Avg Insulin | Ratio Used | BG Pre-Meal | Avg Peak | Peak Time | BG at 2h | % In Range at 2h | % High | % Very High |
|-----------|-------|-----------|-------------|------------|-------------|----------|-----------|----------|-------------------|--------|-------------|
${d.mealTypeSummary.map((m) => {
      const lowCount = m.count < 4 ? " ⚠️LOW SAMPLE" : "";
      return `| **${m.type}** | ${m.count}${lowCount} | ${m.avgCarbs}g | ${m.avgInsulin}U | 1:${m.avgRatioUsed} | ${m.avgPreMeal} | ${m.avgPeak} | ~${m.avgPeakTimeMin}m | ${m.avgGlucoseAt2h} | ${m.pctInRangeAt2h}% | ${m.pctHigh}% | ${m.pctVeryHigh}% |`;
    }).join("\n")}
NOTE: Meal types with ⚠️LOW SAMPLE (<4 meals) are unreliable — cross-reference with the AGP and time block data before drawing conclusions. If the AGP shows high variability during a meal window but the meal count is low, the meal type is likely worse than the summary suggests.${
      d.mealTypeSummary.some((m) => (m.possibleUnloggedMeals ?? 0) > 0)
        ? `\nPOSSIBLE UNLOGGED MEALS (large boluses with no logged carbs — NOT counted in the ratio/TIR stats above): ${d.mealTypeSummary.filter((m) => (m.possibleUnloggedMeals ?? 0) > 0).map((m) => `${m.type} ${m.possibleUnloggedMeals}`).join(", ")}. These may indicate meals dosed without carb entry.`
        : ""
    }`;
  }

  if (d.mealEvents && d.mealEvents.length > 0) {
    // Compact format: drop +1h column, cap at 25 most recent
    const meals = d.mealEvents.slice(-25);
    msg += `\n\n### Recent Meals (${meals.length} of ${d.mealEvents.length})\n| Time | Type | Carbs | Bolus | Ratio | BG Pre | BG +2h |\n|------|------|-------|-------|-------|--------|--------|\n${meals.map((m: Record<string, unknown>) => `| ${m.time} | ${(m as { mealType?: string }).mealType ?? "—"} | ${m.carbs}g | ${m.bolus}U | 1:${m.carbRatioUsed} | ${m.bgAtMeal} | ${(m as { bgAfter2h?: number }).bgAfter2h ?? "—"} |`).join("\n")}`;
  }

  // ── ISF by time of day ──
  if (d.isfByPeriod && d.isfByPeriod.length > 0) {
    const withData = d.isfByPeriod.filter((p) => p.avgISF !== 0);
    if (withData.length > 0) {
      msg += `\n\n### Observed ISF by Time of Day\n| Period | Avg ISF | Median ISF | Effectiveness Rate |\n|--------|---------|------------|--------------------|\n${withData.map((p) => `| ${p.label} | ${p.avgISF} | ${p.medianISF} | ${p.effectiveRate}% |`).join("\n")}`;
    }
  }

  // ── Basal adequacy ──
  if (d.basalAdequacy && d.basalAdequacy.length > 0) {
    const withData = d.basalAdequacy.filter((b) => b.verdict !== "insufficient_data");
    if (withData.length > 0) {
      msg += `\n\n### Basal Adequacy (from fasting periods — no food/bolus for 4+ hours)\n| Time Block | Drift (mg/dL/hr) | Verdict | Current Basal |\n|------------|------------------|---------|---------------|\n${withData.map((b) => `| ${b.label} | ${b.avgGlucoseChange > 0 ? "+" : ""}${b.avgGlucoseChange} | ${b.verdict} | ${b.currentBasalRate ?? "unknown"} U/hr |`).join("\n")}`;
    }
  }

  // ── Site period summary (condensed) ──
  if (d.sitePeriodSummary && d.sitePeriodSummary.length > 0) {
    const sites = d.sitePeriodSummary;
    const avgDeg = Math.round(sites.reduce((s, p) => s + p.degradation, 0) / sites.length);
    const avgTir = Math.round(sites.reduce((s, p) => s + p.tir, 0) / sites.length);
    const avgAge = Math.round(sites.reduce((s, p) => s + p.ageDays, 0) / sites.length * 10) / 10;
    msg += `\n\n### Infusion Site Summary (${sites.length} sites)\n- Avg site age: ${avgAge} days | Avg TIR: ${avgTir}% | Avg degradation (last 24h vs first 24h): ${avgDeg > 0 ? "+" : ""}${avgDeg} mg/dL`;
    const badSites = sites.filter((s) => s.degradation > 20);
    if (badSites.length > 0) {
      msg += `\n- ${badSites.length} site(s) showed >20 mg/dL degradation by end of life`;
    }
  }

  // ── Episode clusters ──
  if (d.episodeClusters && d.episodeClusters.length > 0) {
    msg += `\n\n### Out-of-Range Episode Clusters\n${d.episodeClusters.map((c) => `- **${c.label}**: ${c.count} episodes, avg ${c.avgDuration} min, avg peak ${c.avgPeak} mg/dL${c.commonDay ? ` (most common: ${c.commonDay})` : ""}\n  Possible cause: ${c.possibleCause}`).join("\n")}`;
  }

  if (d.notableDays && d.notableDays.length > 0) {
    msg += `\n\n### Notable Days (Outliers)\n${d.notableDays.map((nd) => `- **${nd.date} (${nd.dayOfWeek})**: mean ${nd.mean}, TIR ${nd.tir}%, ${nd.lows} low readings, ${nd.highs} high readings${nd.note ? ` — ${nd.note}` : ""}`).join("\n")}`;
  }

  if (d.corrections && d.corrections.length > 0) {
    msg += `\n\n### Recent Correction Effectiveness\n${d.corrections.map((c) => `- ${c.time}: ${c.units}U correction, BG ${c.bgBefore}→${c.bgAfter60min} mg/dL (effective ISF: ${c.effectiveISF} mg/dL per unit)`).join("\n")}`;
  }

  if (d.agpByHour && d.agpByHour.length > 0) {
    // Compact format: one line per hour, flag problem hours
    msg += `\n\n### AGP Percentiles by Hour\n${d.agpByHour.map((a) => {
      const flag = a.p90 > 250 ? " ⚠HIGH" : a.p10 < 65 ? " ⚠LOW" : "";
      return `${String(a.hour).padStart(2, "0")}:00 P50=${a.p50} [${a.p10}-${a.p90}]${flag}`;
    }).join(" | ")}`;
  }

  msg += `\n\nPlease analyze this data and provide a comprehensive insights report following your analysis framework.`;

  return msg;
}
