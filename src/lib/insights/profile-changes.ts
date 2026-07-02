// Pump profile / settings change detection.
//
// Two sources, merged by the insights refresh route:
//  1. Nightscout profile documents (tconnectsync uploads a new profile doc
//     whenever the pump's basal/ISF/carb-ratio/target schedule changes) —
//     diffed here to produce dated change events.
//  2. advisor/settings-changes.json — Control-IQ settings (weight, TDD,
//     basal limit, max bolus, sleep schedule) tracked by the advisor cron,
//     which sees the published pump-state every 5 minutes.
//
// Why this matters: an AI insights report over 90 days is misleading if the
// profile changed mid-period — recommendations must reflect CURRENT settings,
// and before/after comparison is the actually useful analysis.

import type { PumpProfile } from "../types";

export interface ProfileChangeEvent {
  at: number; // epoch ms
  date: string; // YYYY-MM-DD (ET)
  changes: string[]; // human-readable, e.g. "ISF 05:00: 80→70"
}

type ScheduleEntry = { time: string; value: number };

function profileDocTime(p: PumpProfile): number {
  const t = Date.parse(p.startDate ?? p.created_at ?? "");
  return Number.isFinite(t) ? t : 0;
}

function diffSchedule(
  label: string,
  newer: ScheduleEntry[],
  older: ScheduleEntry[]
): string[] {
  const out: string[] = [];
  const oldByTime = new Map(older.map((e) => [e.time, e.value]));
  const newByTime = new Map(newer.map((e) => [e.time, e.value]));
  for (const [time, val] of newByTime) {
    const prev = oldByTime.get(time);
    if (prev === undefined) out.push(`${label} ${time}: added ${val}`);
    else if (prev !== val) out.push(`${label} ${time}: ${prev}→${val}`);
  }
  for (const time of oldByTime.keys()) {
    if (!newByTime.has(time)) out.push(`${label} ${time}: removed`);
  }
  return out;
}

/** Diff two consecutive Nightscout profile docs (newer vs older). */
function diffProfileDocs(newer: PumpProfile, older: PumpProfile): string[] {
  const ns = newer.store[newer.defaultProfile];
  const os = older.store[older.defaultProfile];
  if (!ns || !os) return [];
  const changes: string[] = [
    ...diffSchedule("Basal (U/hr)", ns.basal, os.basal),
    ...diffSchedule("ISF (mg/dL per U)", ns.sens, os.sens),
    ...diffSchedule("Carb ratio (1:X g)", ns.carbratio, os.carbratio),
    ...diffSchedule("Target low", ns.target_low, os.target_low),
    ...diffSchedule("Target high", ns.target_high, os.target_high),
  ];
  const newDia = typeof ns.dia === "string" ? parseFloat(ns.dia) : ns.dia;
  const oldDia = typeof os.dia === "string" ? parseFloat(os.dia) : os.dia;
  if (newDia !== oldDia) changes.push(`DIA: ${oldDia}→${newDia} hours`);
  return changes;
}

function toEtDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

/**
 * Detect dated schedule changes from a list of Nightscout profile docs
 * (any order — sorted internally, newest first). Returns events newest-first,
 * only those at/after `sinceMs`.
 */
export function detectProfileChanges(
  profiles: PumpProfile[],
  sinceMs: number
): ProfileChangeEvent[] {
  const sorted = [...profiles].sort((a, b) => profileDocTime(b) - profileDocTime(a));
  const events: ProfileChangeEvent[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const at = profileDocTime(sorted[i]);
    if (at < sinceMs) break; // older docs can't produce in-window events
    const changes = diffProfileDocs(sorted[i], sorted[i + 1]);
    if (changes.length > 0) {
      events.push({ at, date: toEtDate(at), changes });
    }
  }
  return events;
}

/**
 * Merge NS-profile events with pump-settings events (from
 * advisor/settings-changes.json), clustering everything within a 48-hour
 * window into ONE change event (2026-07-02: a tuning session spans a
 * couple of days of back-and-forth — treat it as a single regime change).
 *
 * Within a cluster, per-field changes are NETTED: "CR 20:00: 7→6" then
 * "6→5" then "5→6" collapses to "7→6", and a field that returns to its
 * starting value drops out entirely. Fields that don't parse as "X→Y"
 * (added/removed entries) are kept verbatim, deduplicated.
 */
const CLUSTER_WINDOW_MS = 48 * 60 * 60 * 1000;

export function mergeChangeEvents(
  ...lists: ProfileChangeEvent[][]
): ProfileChangeEvent[] {
  const all = lists
    .flat()
    .slice()
    .sort((a, b) => a.at - b.at);

  // Group events where the gap to the previous event is ≤ 48h.
  const clusters: ProfileChangeEvent[][] = [];
  for (const ev of all) {
    const cur = clusters[clusters.length - 1];
    if (cur && ev.at - cur[cur.length - 1].at <= CLUSTER_WINDOW_MS) {
      cur.push(ev);
    } else {
      clusters.push([ev]);
    }
  }

  return clusters
    .map((cluster) => {
      const firstFrom = new Map<string, string>();
      const lastTo = new Map<string, string>();
      const other: string[] = [];
      for (const ev of cluster) {
        for (const c of ev.changes) {
          const m = c.match(/^(.+?): (.+?)→(.+)$/);
          if (m) {
            if (!firstFrom.has(m[1])) firstFrom.set(m[1], m[2]);
            lastTo.set(m[1], m[3]);
          } else if (!other.includes(c)) {
            other.push(c);
          }
        }
      }
      const changes = [...lastTo.entries()]
        .filter(([field, to]) => firstFrom.get(field) !== to)
        .map(([field, to]) => `${field}: ${firstFrom.get(field)}→${to}`)
        .concat(other);
      const startDate = cluster[0].date;
      const endDate = cluster[cluster.length - 1].date;
      return {
        at: cluster[cluster.length - 1].at,
        date: startDate === endDate ? startDate : `${startDate} to ${endDate}`,
        changes,
      };
    })
    .filter((ev) => ev.changes.length > 0)
    .sort((a, b) => b.at - a.at);
}
