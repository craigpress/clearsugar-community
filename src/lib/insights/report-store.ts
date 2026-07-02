/**
 * ClearSugar — Persistent report storage via local filesystem
 *
 * Stores generated insight reports so they survive server restarts.
 * Reports are keyed by date range for easy retrieval.
 */

import { loadJSON, saveJSON, deleteJSON, listKeys } from "@/lib/local-store";

const REPORT_PREFIX = "insights/reports/";

export interface StoredReport {
  generatedAt: string;
  days: number;
  period: string;
  model: string;
  provider: string;
  durationMs: number;
  summary: {
    readings: number;
    mean: number;
    tir: number;
    gmi: number;
    low: number;
    veryLow: number;
    high: number;
    veryHigh: number;
  };
  /** LLM-generated markdown report */
  report: string;
  /** Rule-based pattern cards (kept for the Patterns tab) */
  patterns: Array<{
    id: string;
    title: string;
    severity: "positive" | "low" | "moderate" | "high";
    description: string;
    suggestion: string;
  }>;
  /** Structured payload passed to the LLM, for reproducibility + grounding chat. */
  inputData?: unknown;
  /** Version tag for the prompt/payload schema used to generate this report. */
  promptVersion?: string;
  /** Set when AI-stated figures diverge from source data beyond tolerance. */
  dataConsistencyWarning?: string;
  /** Dated pump profile / CIQ settings changes detected within the period. */
  profileChanges?: Array<{ date: string; changes: string[] }>;
}

/**
 * Save a report to disk.
 * Key format: insights/reports/2026-04-06_30d.json
 */
export async function saveReport(report: StoredReport): Promise<string> {
  const dateStr = report.generatedAt.slice(0, 10); // YYYY-MM-DD
  const key = `${REPORT_PREFIX}${dateStr}_${report.days}d.json`;
  await saveJSON(key, report);
  return key;
}

/**
 * Load the most recent report, optionally filtered by day count.
 */
export async function loadLatestReport(days?: number): Promise<StoredReport | null> {
  const keys = await listKeys(REPORT_PREFIX);
  if (keys.length === 0) return null;

  let candidates = keys;
  if (days) {
    candidates = keys.filter((k) => k.includes(`_${days}d.json`));
  }
  if (candidates.length === 0) return null;

  // Sort by filename descending (date is in the filename)
  candidates.sort((a, b) => b.localeCompare(a));

  return loadJSON<StoredReport | null>(candidates[0], null);
}

/**
 * List all stored reports (metadata only).
 */
export async function listReports(): Promise<Array<{
  key: string;
}>> {
  const keys = await listKeys(REPORT_PREFIX);
  return keys.map((k) => ({ key: k }));
}

/**
 * Delete old reports, keeping the most recent N per day-count.
 */
export async function pruneReports(keepPerDayCount: number = 3): Promise<number> {
  const keys = await listKeys(REPORT_PREFIX);

  // Group by day count suffix
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const match = key.match(/_(\d+d)\.json$/);
    const group = match ? match[1] : "unknown";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(key);
  }

  let deleted = 0;
  for (const [, group] of groups) {
    // Sort descending by filename (date-based)
    group.sort((a, b) => b.localeCompare(a));
    for (let i = keepPerDayCount; i < group.length; i++) {
      await deleteJSON(group[i]);
      deleted++;
    }
  }

  return deleted;
}
