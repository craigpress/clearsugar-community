/**
 * ClearSugar — glucose validity invariant (server side)
 *
 * Invalid, missing, or sentinel readings must never be classified into a
 * range category, pushed to a Live Activity, or evaluated against alert
 * thresholds. Dexcom/Nightscout emit sentinel codes 0-12 on sensor faults;
 * 39 is the "LOW" clamp and IS a real clinical reading. Values >= 600 are
 * outside the physiological/display range.
 *
 * The iOS app has a parallel invariant (GlucoseReading.isValid). Keep the
 * two in sync when changing bounds.
 */

/** Highest Dexcom sensor-error sentinel code. */
const MAX_SENTINEL_CODE = 12;
/** Exclusive upper bound for a plausible reading. */
const MAX_SGV = 600;

export function isValidSgv(sgv: unknown): sgv is number {
  return (
    typeof sgv === "number" &&
    Number.isFinite(sgv) &&
    sgv > MAX_SENTINEL_CODE &&
    sgv < MAX_SGV
  );
}

/** Drop invalid values from a sparkline series so sensor errors don't render as dips to zero. */
export function sanitizeSparkline(values: number[]): number[] {
  return values.filter(isValidSgv);
}
