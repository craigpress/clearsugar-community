// ClearSugar — Shared numeric helpers
//
// Single source of truth for percentile and min/max over potentially very large
// arrays (90 days of CGM data ~ 25k elements). Spread-based Math.min/Math.max
// throw RangeError on arrays that large, so use reduce-based variants.

/**
 * Linear-interpolated percentile on an ascending-sorted array.
 * @param sortedAsc values sorted ascending
 * @param fraction percentile as a fraction in [0, 1] (e.g. 0.1 for p10)
 */
export function percentile(sortedAsc: number[], fraction: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = fraction * (sortedAsc.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sortedAsc[lower];
  return sortedAsc[lower] + (sortedAsc[upper] - sortedAsc[lower]) * (idx - lower);
}

/** Minimum of an array via reduce. Returns 0 for an empty array. */
export function minOf(values: number[]): number {
  if (values.length === 0) return 0;
  let m = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] < m) m = values[i];
  }
  return m;
}

/** Maximum of an array via reduce. Returns 0 for an empty array. */
export function maxOf(values: number[]): number {
  if (values.length === 0) return 0;
  let m = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] > m) m = values[i];
  }
  return m;
}
