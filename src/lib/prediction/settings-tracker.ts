// Control-IQ settings change tracker (SAFE, additive — never affects firing).
//
// Nightscout profile docs capture basal/ISF/carb-ratio schedule changes, but
// the pump's Control-IQ dosing inputs (weight, TDD, basal limit, max bolus,
// sleep schedule) only appear in the published pump-state snapshot. The
// advisor cron sees that snapshot every 5 minutes; this module diffs it
// against the last stored snapshot and appends dated change events to
// advisor/settings-changes.json so AI insights can flag "settings changed on
// DATE — compare before/after" instead of averaging across a regime change.

import { loadJSON, saveJSON } from "../local-store";
import type { PumpState } from "../types";

const SNAPSHOT_KEY = "advisor/pump-settings.json";
const CHANGES_KEY = "advisor/settings-changes.json";
const MAX_EVENTS = 100;

interface SettingsSnapshot {
  tdd: number | null;
  weightLb: number | null;
  basalLimitUHr: number | null;
  maxBolusU: number | null;
  profileTargetMgdl: number | null;
  sleepStartMin: number | null;
  sleepEndMin: number | null;
  sleepEnabled: boolean | null;
}

export interface SettingsChangeEvent {
  at: number;
  date: string; // YYYY-MM-DD (ET)
  changes: string[];
}

function snapshotOf(ps: PumpState): SettingsSnapshot {
  const c = ps.controlIQ ?? {};
  return {
    tdd: c.tdd ?? null,
    weightLb: c.weightLb ?? null,
    basalLimitUHr: c.basalLimitUHr ?? null,
    maxBolusU: c.maxBolusU ?? null,
    profileTargetMgdl: c.profileTargetMgdl ?? null,
    sleepStartMin: c.sleepSchedule?.startMin ?? null,
    sleepEndMin: c.sleepSchedule?.endMin ?? null,
    sleepEnabled: c.sleepSchedule?.enabled ?? null,
  };
}

const FIELD_LABELS: Record<keyof SettingsSnapshot, string> = {
  tdd: "Total daily insulin (TDD, U)",
  weightLb: "Weight (lb)",
  basalLimitUHr: "Basal limit (U/hr)",
  maxBolusU: "Max bolus (U)",
  profileTargetMgdl: "CIQ target (mg/dL)",
  sleepStartMin: "Sleep schedule start (min from midnight)",
  sleepEndMin: "Sleep schedule end (min from midnight)",
  sleepEnabled: "Sleep schedule enabled",
};

/**
 * Compare the live pump-state settings against the stored snapshot; on a
 * difference, append a dated event and update the snapshot. Null-safe: a
 * field that is null in either snapshot is skipped (missing pump-state data
 * must never register as a "change"). Returns the change strings (empty when
 * nothing changed).
 */
export async function trackSettingsChanges(
  pumpState: PumpState | null,
  now: number
): Promise<string[]> {
  if (!pumpState?.controlIQ) return [];
  const current = snapshotOf(pumpState);
  const prev = await loadJSON<SettingsSnapshot | Record<string, never>>(
    SNAPSHOT_KEY,
    {}
  );

  if (!("tdd" in prev)) {
    // First run — just seed the snapshot.
    await saveJSON(SNAPSHOT_KEY, current);
    return [];
  }

  const changes: string[] = [];
  for (const key of Object.keys(FIELD_LABELS) as (keyof SettingsSnapshot)[]) {
    const a = (prev as SettingsSnapshot)[key];
    const b = current[key];
    if (a == null || b == null) continue;
    if (a !== b) changes.push(`${FIELD_LABELS[key]}: ${a}→${b}`);
  }

  if (changes.length > 0) {
    const events = await loadJSON<SettingsChangeEvent[]>(CHANGES_KEY, []);
    events.push({
      at: now,
      date: new Date(now).toLocaleDateString("en-CA", {
        timeZone: "America/New_York",
      }),
      changes,
    });
    await saveJSON(CHANGES_KEY, events.slice(-MAX_EVENTS));
  }
  // Keep the snapshot current (also refreshes non-null fields after nulls).
  await saveJSON(SNAPSHOT_KEY, current);
  return changes;
}

/** Load recorded settings-change events at/after sinceMs (newest first). */
export async function loadSettingsChanges(
  sinceMs: number
): Promise<SettingsChangeEvent[]> {
  const events = await loadJSON<SettingsChangeEvent[]>(CHANGES_KEY, []);
  return events.filter((e) => e.at >= sinceMs).sort((a, b) => b.at - a.at);
}
