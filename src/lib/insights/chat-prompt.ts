/**
 * ClearSugar — System prompt for Ask ClearSugar chat
 *
 * Lighter version of the insights prompt, designed for interactive Q&A.
 * Gets the latest report context injected so the LLM can answer
 * questions about recent data.
 */

import { SAFETY_CORE } from "./safety-core";
import { getPatientProfile, describePatient } from "@/lib/patient-profile";

async function buildAskSystemPromptBase(): Promise<string> {
  const profile = await getPatientProfile();
  const bio = describePatient(profile);

  return `You are ClearSugar, an AI assistant that helps caregivers manage a patient's Type 1 Diabetes. You have deep knowledge of CGM data analysis, insulin pump therapy, and pediatric endocrinology.

## Patient Context
- **Patient**: ${bio}
- **Caregivers**: The patient's caregivers manage their care.

## Your Role
Answer questions about the patient's glucose data conversationally but precisely. Use numbers and specific times. When suggesting changes, always frame them as "worth discussing with your endo" — you are a data analyst, not a prescriber.

Keep responses concise but thorough. Use markdown for readability. If asked about something not in the data, say so rather than guessing.

## Important
- When you reference the report data, be specific with numbers and dates

${SAFETY_CORE}`;
}

/**
 * Build system prompt with recent report context injected.
 *
 * `inputData` is the structured payload that generated the report (stats,
 * mealTypeSummary, pumpProfile, etc.). When present, a compact JSON of the key
 * figures is injected so answers are grounded in the real source numbers rather
 * than the model's prose recollection of its own report.
 */
export async function buildAskSystemPrompt(reportContext?: string, inputData?: unknown): Promise<string> {
  let prompt = await buildAskSystemPromptBase();

  if (reportContext) {
    prompt += `\n\n## Recent Report Data\nThe following is the most recent AI-generated insights report. Use this to answer questions about the patient's recent glucose patterns:\n\n${reportContext}`;
  } else {
    prompt += "\n\nNo recent report data is available. You can answer general diabetes management questions, but cannot reference specific glucose patterns.";
  }

  const figures = inputData ? extractKeyFigures(inputData) : null;
  if (figures) {
    prompt += `\n\n## Source Data (ground truth — prefer these exact numbers over the prose report above)\nThese are the computed figures the report was built from. When citing TIR, mean, meal response, or pump settings, use THESE numbers:\n\n\`\`\`json\n${JSON.stringify(figures)}\n\`\`\``;
  }

  return prompt;
}

/** Pull the key figures from a stored report's inputData into a compact object. */
function extractKeyFigures(inputData: unknown): Record<string, unknown> | null {
  if (!inputData || typeof inputData !== "object") return null;
  const d = inputData as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (d.period !== undefined) out.period = d.period;
  if (d.dataSpan !== undefined) out.dataSpan = d.dataSpan;
  if (d.coverage !== undefined) out.coverage = d.coverage;
  if (d.stats !== undefined) out.stats = d.stats;
  if (d.overnightStats !== undefined) out.overnightStats = d.overnightStats;
  if (d.mealTypeSummary !== undefined) out.mealTypeSummary = d.mealTypeSummary;
  if (d.pumpProfile !== undefined) out.pumpProfile = d.pumpProfile;
  if (d.basalAdequacy !== undefined) out.basalAdequacy = d.basalAdequacy;
  return Object.keys(out).length > 0 ? out : null;
}
