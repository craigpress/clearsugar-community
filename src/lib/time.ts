// ClearSugar — Patient-timezone date helpers
//
// The deployment server runs in America/New_York, but glucose/insulin bucketing
// must be correct regardless of the server's actual TZ. These helpers always
// compute hour/day/date in the patient's timezone using Intl.DateTimeFormat,
// so they never rely on the server's local time.

export const PATIENT_TZ = "America/New_York";

const hourFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: PATIENT_TZ,
  hour: "2-digit",
  hour12: false,
});

const weekdayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: PATIENT_TZ,
  weekday: "short",
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Hour of day (0-23) in the patient's timezone. */
export function localHour(ts: number | Date): number {
  const d = typeof ts === "number" ? new Date(ts) : ts;
  // "24" can be emitted for midnight in some environments — normalize to 0.
  const h = parseInt(hourFmt.format(d), 10);
  return h === 24 ? 0 : h;
}

/** Day of week (0=Sun .. 6=Sat) in the patient's timezone. */
export function localDayOfWeek(ts: number | Date): number {
  const d = typeof ts === "number" ? new Date(ts) : ts;
  const name = weekdayFmt.format(d);
  return WEEKDAY_INDEX[name] ?? 0;
}

/** Date key "YYYY-MM-DD" in the patient's timezone. */
export function localDateKey(ts: number | Date): string {
  const d = typeof ts === "number" ? new Date(ts) : ts;
  // en-CA formats as YYYY-MM-DD.
  return d.toLocaleDateString("en-CA", { timeZone: PATIENT_TZ });
}
