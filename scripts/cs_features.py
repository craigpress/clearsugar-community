#!/usr/bin/env python3
"""
ClearSugar — shared data loading + feature engineering.

Imported by both train-model.py and evaluate-model.py so that the feature
definitions stay in lockstep. The canonical 20-feature ordered list lives here
(FEATURE_NAMES) and MUST match src/lib/prediction/types.ts ML_FEATURE_NAMES
(same names, same order).

Time-of-day features are computed in America/New_York to match feature-engine.ts.
The target is Δglucose (sgv(t+h) - sgv(t)); callers reconstruct the absolute
prediction by adding currentSgv back.
"""

import math
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import requests

# America/New_York — used for ALL time-of-day + schedule lookups so the trainer
# matches feature-engine.ts (which uses Intl with timeZone America/New_York).
NY_TZ = ZoneInfo("America/New_York")

# ── Canonical feature list (20). Order MUST match types.ts ML_FEATURE_NAMES. ──
FEATURE_NAMES = [
    "currentSgv", "roc5", "roc15", "roc30",
    "iob", "cob", "insulinAge",
    "minuteOfDay", "dayOfWeek", "sinTime", "cosTime",
    "siteAgeHours", "currentISF", "recentCV", "agpDeviation",
    "glucoseMomentum",
    "mean1h", "mean3h", "min1h", "max1h",
    # Control-IQ mode (from Sleep/Exercise usermode treatments, now synced by
    # tconnectsync v3.0.0). Appended AFTER the original 20 so existing feature
    # positions are unchanged. MUST match types.ts ML_FEATURE_NAMES + feature-engine.ts.
    "sleepActive", "exerciseActive",
]

INSULIN_DELAY_MIN = 10  # 10-minute delay before insulin starts acting (matches Loop)


# ── Nightscout Data Fetching ──

def ns_headers(api_secret: str = ""):
    h = {"Accept": "application/json", "User-Agent": "ClearSugar-Trainer/1.0"}
    if api_secret:
        h["API-SECRET"] = api_secret
    return h


def fetch_entries(url: str, days: int, api_secret: str = "") -> pd.DataFrame:
    """Fetch CGM entries from Nightscout (last `days` days)."""
    since = int((datetime.utcnow() - timedelta(days=days)).timestamp() * 1000)
    entries = []
    count = 10000  # max per request

    print(f"Fetching {days} days of CGM data...")
    params = {"count": count, "find[date][$gte]": since}
    resp = requests.get(f"{url}/api/v1/entries.json", headers=ns_headers(api_secret), params=params)
    resp.raise_for_status()
    batch = resp.json()
    entries.extend(batch)

    # Paginate if needed
    while len(batch) == count:
        oldest = min(e["date"] for e in batch)
        params["find[date][$lt]"] = oldest
        resp = requests.get(f"{url}/api/v1/entries.json", headers=ns_headers(api_secret), params=params)
        resp.raise_for_status()
        batch = resp.json()
        entries.extend(batch)

    print(f"  Got {len(entries)} CGM readings")
    df = pd.DataFrame(entries)
    if df.empty:
        return df
    df = df[df["type"] == "sgv"].copy()
    df["date"] = pd.to_numeric(df["date"])
    df = df.sort_values("date").reset_index(drop=True)
    return df


def fetch_treatments(url: str, days: int, api_secret: str = "") -> pd.DataFrame:
    """Fetch treatments from Nightscout (last `days` days)."""
    since = (datetime.utcnow() - timedelta(days=days)).isoformat()
    treatments = []
    count = 10000

    print(f"Fetching {days} days of treatments...")
    params = {"count": count, "find[created_at][$gte]": since}
    resp = requests.get(f"{url}/api/v1/treatments.json", headers=ns_headers(api_secret), params=params)
    resp.raise_for_status()
    batch = resp.json()
    treatments.extend(batch)

    while len(batch) == count:
        oldest = batch[-1].get("created_at", "")
        params["find[created_at][$lt]"] = oldest
        resp = requests.get(f"{url}/api/v1/treatments.json", headers=ns_headers(api_secret), params=params)
        resp.raise_for_status()
        batch = resp.json()
        treatments.extend(batch)

    print(f"  Got {len(treatments)} treatments")
    df = pd.DataFrame(treatments)
    if df.empty:
        return df
    # Compute mills if missing
    if "mills" not in df.columns:
        df["mills"] = 0
    df["mills"] = df.apply(
        lambda r: r["mills"] if r.get("mills", 0) and r["mills"] > 0
        else int(pd.Timestamp(r["created_at"]).timestamp() * 1000),
        axis=1,
    )
    return df.sort_values("mills").reset_index(drop=True)


def fetch_profile(url: str, api_secret: str = "") -> dict:
    """Fetch pump profile from Nightscout."""
    resp = requests.get(f"{url}/api/v1/profile.json", headers=ns_headers(api_secret))
    resp.raise_for_status()
    profiles = resp.json()
    if not profiles:
        raise ValueError("No pump profile found in Nightscout")
    profile = profiles[0]
    default_name = profile.get("defaultProfile", "Default")
    store = profile["store"][default_name]
    return {
        "dia": float(store.get("dia", 5)),
        "sens": store.get("sens", [{"timeAsSeconds": 0, "value": 50}]),
        "carbratio": store.get("carbratio", [{"timeAsSeconds": 0, "value": 10}]),
        "basal": store.get("basal", [{"timeAsSeconds": 0, "value": 0.5}]),
    }


# ── IOB / COB Calculations (must match physiological-model.ts) ──

def calculate_iob(
    bolus_times: np.ndarray,
    bolus_units: np.ndarray,
    dia_min: float,
    at_time: int,
    temp_basal_segments: np.ndarray | None = None,
) -> float:
    """Insulin on board using the Maksimovic model with 10-min delay (vectorized).

    Mirrors physiological-model.ts calculateIOB: sums bolus contributions PLUS a
    temp-basal contribution (delta above/below scheduled basal). Aggregate IOB is
    floored at 0.

    temp_basal_segments: optional Nx4 array of
        [start_ms, end_ms, delta_rate_units_per_hr, scheduled_basal(unused)]
    Only the first three columns are used; the delta term mirrors the TS overlap
    math: extraInsulin = deltaRate * overlapHours, applied at the overlap midpoint
    age through the same iob curve.
    """
    iob_total = 0.0

    ages = (at_time - bolus_times) / 60_000  # minutes
    mask = (ages >= 0) & (ages < dia_min)
    if mask.any():
        eff = ages[mask] - INSULIN_DELAY_MIN
        in_delay = eff <= 0
        frac = _iob_curve_vec(np.clip(eff, 0.001, None), dia_min)
        frac = np.clip(frac, 0.0, 1.0)
        frac[in_delay] = 1.0
        iob_total += float(np.sum(bolus_units[mask] * frac))

    # Temp-basal delta contribution (mirror calculateIOB in physiological-model.ts)
    if temp_basal_segments is not None and len(temp_basal_segments) > 0:
        window_start = at_time - dia_min * 60_000
        for seg in temp_basal_segments:
            start_ms, end_ms, delta_rate = seg[0], seg[1], seg[2]
            if delta_rate == 0:
                continue
            if not (start_ms < at_time and end_ms > window_start):
                continue
            overlap_start = max(start_ms, window_start)
            overlap_end = min(end_ms, at_time)
            if overlap_end <= overlap_start:
                continue
            duration_hrs = (overlap_end - overlap_start) / 3_600_000
            extra_insulin = delta_rate * duration_hrs
            avg_age = (at_time - (overlap_start + overlap_end) / 2) / 60_000
            iob_total += extra_insulin * iob_curve(avg_age, dia_min)

    return max(0.0, iob_total)


def _iob_curve_vec(t: np.ndarray, dia_min: float) -> np.ndarray:
    """Vectorized Maksimovic fraction-remaining for effective ages t (post-delay)."""
    td = dia_min - INSULIN_DELAY_MIN
    tp = 75.0 - INSULIN_DELAY_MIN
    tau = tp * (1 - tp / td) / (1 - 2 * tp / td)
    a = 2 * tau / td
    S = 1 / (1 - a + (1 + a) * np.exp(-td / tau))
    return 1 - S * (1 - a) * (
        (t ** 2 / (tau * td * (1 - a)) - t / tau - 1) * np.exp(-t / tau) + 1
    )


def iob_curve(minutes_age: float, dia_minutes: float) -> float:
    """Scalar Maksimovic fraction-remaining with 10-min delay (matches TS iobCurvePercent)."""
    effective_age = minutes_age - INSULIN_DELAY_MIN
    if effective_age <= 0:
        return 1.0  # still in delay period
    if minutes_age >= dia_minutes:
        return 0.0
    td = dia_minutes - INSULIN_DELAY_MIN
    tp = 75.0 - INSULIN_DELAY_MIN
    t = effective_age
    tau = tp * (1 - tp / td) / (1 - 2 * tp / td)
    a = 2 * tau / td
    S = 1 / (1 - a + (1 + a) * math.exp(-td / tau))
    iob = 1 - S * (1 - a) * ((t ** 2 / (tau * td * (1 - a)) - t / tau - 1) * math.exp(-t / tau) + 1)
    return max(0.0, min(1.0, iob))


def calculate_cob(carb_times: np.ndarray, carb_grams: np.ndarray, at_time: int) -> float:
    """Carbs on board (vectorized). Hermite S-curve over 180 min, then absorbed.

    Matches carbAbsorptionPercent in physiological-model.ts: ~7% absorbed at
    30 min, ~26% at 60 min, ~74% at 120 min, 100% by 180 min. 4h safety window.
    """
    ages = (at_time - carb_times) / 60_000  # minutes
    mask = (ages >= 0) & (ages < 240)
    if not mask.any():
        return 0.0
    a = ages[mask]
    shifted = np.clip(a / 180.0, 0.0, 1.0)
    absorbed_frac = shifted * shifted * (3.0 - 2.0 * shifted)
    remaining = carb_grams[mask] * (1.0 - absorbed_frac)
    return float(np.sum(remaining))


# ── Scheduled values + time helpers (America/New_York) ──

def get_scheduled_value(schedule: list, at_time: int) -> float:
    """Look up a time-scheduled value (ISF, CR, basal) for a given timestamp, in NY tz."""
    if not schedule:
        return 0.0
    dt = datetime.fromtimestamp(at_time / 1000, NY_TZ)
    seconds = dt.hour * 3600 + dt.minute * 60 + dt.second
    value = schedule[0]["value"]
    for entry in schedule:
        if entry["timeAsSeconds"] <= seconds:
            value = entry["value"]
        else:
            break
    return float(value)


def ny_time_parts(at_time: int):
    """Return (minute_of_day, day_of_week_js, sin_time, cos_time) in America/New_York.
    day_of_week_js is 0=Sun..6=Sat to match feature-engine.ts / JS getDay()."""
    dt = datetime.fromtimestamp(at_time / 1000, NY_TZ)
    minute_of_day = dt.hour * 60 + dt.minute
    day_of_week_js = dt.isoweekday() % 7  # Mon=1..Sun=7 -> Sun=0..Sat=6
    sin_time = math.sin(2 * math.pi * minute_of_day / 1440)
    cos_time = math.cos(2 * math.pi * minute_of_day / 1440)
    return minute_of_day, day_of_week_js, sin_time, cos_time


# ── AGP / site change context ──

def compute_agp_medians(entries: pd.DataFrame) -> dict:
    """Compute AGP median for each 30-min slot (in America/New_York).

    IMPORTANT: pass ONLY the training partition here to avoid leaking validation
    data into the agpDeviation feature.
    """
    entries = entries.copy()
    dt = pd.to_datetime(entries["date"], unit="ms", utc=True).dt.tz_convert(NY_TZ)
    slot = (dt.dt.hour * 60 + dt.dt.minute) // 30 * 30
    medians = entries.assign(slot=slot).groupby("slot")["sgv"].median().to_dict()
    return medians


def find_site_changes(treatments: pd.DataFrame) -> list:
    """Extract site change timestamps."""
    if treatments.empty or "eventType" not in treatments.columns:
        return []
    sc = treatments[treatments["eventType"] == "Site Change"]
    return sorted(sc["mills"].tolist())


def get_site_age_hours(site_changes: list, at_time: int) -> float:
    """Hours since last site change."""
    last = None
    for sc in site_changes:
        if sc <= at_time:
            last = sc
        else:
            break
    if last is None:
        return 72.0
    return (at_time - last) / 3_600_000


def build_temp_basal_segments(treatments: pd.DataFrame, profile: dict) -> np.ndarray:
    """Build Nx3 temp-basal segments [start_ms, end_ms, delta_rate] from treatments.

    delta_rate = (absolute|rate) - scheduledBasal(at start), mirroring
    physiological-model.ts calculateIOB temp-basal handling.
    """
    if treatments.empty or "eventType" not in treatments.columns:
        return np.empty((0, 3), dtype=np.float64)
    tb = treatments[treatments["eventType"] == "Temp Basal"].copy()
    if tb.empty:
        return np.empty((0, 3), dtype=np.float64)

    segs = []
    basal_sched = profile["basal"]
    for _, r in tb.iterrows():
        duration = r.get("duration", 0)
        if not duration or duration <= 0:
            continue
        rate = r.get("absolute", None)
        if rate is None or (isinstance(rate, float) and math.isnan(rate)):
            rate = r.get("rate", None)
        if rate is None or (isinstance(rate, float) and math.isnan(rate)):
            continue
        start_ms = float(r["mills"])
        end_ms = start_ms + float(duration) * 60_000
        scheduled = get_scheduled_value(basal_sched, int(start_ms))
        delta_rate = float(rate) - scheduled
        if delta_rate == 0:
            continue
        segs.append([start_ms, end_ms, delta_rate])

    if not segs:
        return np.empty((0, 3), dtype=np.float64)
    return np.array(segs, dtype=np.float64)


# ── Feature Engineering ──

def extract_features_at(
    entries: pd.DataFrame,
    profile: dict,
    agp_medians: dict,
    site_changes: list,
    idx: int,
    bolus_times_arr: np.ndarray,
    bolus_units_arr: np.ndarray,
    carb_times_arr: np.ndarray,
    carb_grams_arr: np.ndarray,
    dia_min: float,
    temp_basal_segments: np.ndarray | None = None,
    sleep_intervals: np.ndarray | None = None,
    exercise_intervals: np.ndarray | None = None,
) -> dict | None:
    """Extract the feature vector at a given reading index (+ timestamp)."""
    row = entries.iloc[idx]
    now = row["date"]
    sgv = row["sgv"]

    # Need at least 6 prior readings (~30 min)
    if idx < 6:
        return None

    recent = entries.iloc[max(0, idx - 36): idx + 1]  # up to 3h back
    recent_sorted = recent.sort_values("date", ascending=False)
    values = recent_sorted["sgv"].values
    times = recent_sorted["date"].values

    def roc_window(window_min):
        cutoff = now - window_min * 60_000
        mask = times >= cutoff
        t = times[mask]
        v = values[mask]
        if len(t) < 2:
            return 0.0
        x = (t - now) / 60_000
        n = len(x)
        sx, sy, sxy, sx2 = x.sum(), v.sum(), (x * v).sum(), (x * x).sum()
        denom = n * sx2 - sx * sx
        if denom == 0:
            return 0.0
        return float((n * sxy - sx * sy) / denom)  # mg/dL per minute

    roc5 = roc_window(5)
    roc15 = roc_window(15)
    roc30 = roc_window(30)

    iob = calculate_iob(bolus_times_arr, bolus_units_arr, dia_min, now, temp_basal_segments)
    cob = calculate_cob(carb_times_arr, carb_grams_arr, now)

    prior_mask = bolus_times_arr <= now
    insulin_age = (now - bolus_times_arr[prior_mask].max()) / 60_000 if prior_mask.any() else 360.0

    # Temporal features (America/New_York)
    minute_of_day, day_of_week_js, sin_time, cos_time = ny_time_parts(now)

    site_age = get_site_age_hours(site_changes, now)
    current_isf = get_scheduled_value(profile["sens"], now)

    # Recent CV (2h), population std (ddof=0) to match TS, rounded to 1 decimal
    two_h_cutoff = now - 2 * 3_600_000
    two_h = recent_sorted[recent_sorted["date"] >= two_h_cutoff]["sgv"]
    if len(two_h) >= 2:
        m = two_h.mean()
        recent_cv = (two_h.std(ddof=0) / m * 100) if m > 0 else 0.0
    else:
        recent_cv = 0.0

    slot = (minute_of_day // 30) * 30
    agp_median = agp_medians.get(slot, sgv)
    agp_deviation = sgv - agp_median

    # Glucose momentum (2nd derivative)
    momentum = 0.0
    if len(values) >= 5:
        mid_mask = (now - times) >= 8 * 60_000
        old_mask = (now - times) >= 18 * 60_000
        mid_vals = values[mid_mask]
        old_vals = values[old_mask]
        if len(mid_vals) > 0 and len(old_vals) > 0:
            mid_sgv = mid_vals[0]
            old_sgv = old_vals[0]
            mid_dt = (now - times[mid_mask][0]) / 60_000
            old_dt = (times[mid_mask][0] - times[old_mask][0]) / 60_000
            if mid_dt > 0 and old_dt > 0:
                roc_recent = (sgv - mid_sgv) / mid_dt
                roc_earlier = (mid_sgv - old_sgv) / old_dt
                avg_dt = (mid_dt + old_dt) / 2
                momentum = (roc_recent - roc_earlier) / avg_dt

    one_h_cutoff = now - 3_600_000
    three_h_cutoff = now - 3 * 3_600_000
    one_h = recent_sorted[recent_sorted["date"] >= one_h_cutoff]["sgv"]
    three_h = recent_sorted[recent_sorted["date"] >= three_h_cutoff]["sgv"]

    return {
        "currentSgv": sgv,
        "roc5": roc5,
        "roc15": roc15,
        "roc30": roc30,
        "iob": round(iob, 2),
        "cob": round(cob),
        "insulinAge": round(insulin_age),
        "minuteOfDay": minute_of_day,
        "dayOfWeek": day_of_week_js,
        "sinTime": sin_time,
        "cosTime": cos_time,
        "siteAgeHours": site_age,
        "currentISF": current_isf,
        "recentCV": round(recent_cv, 1),
        "agpDeviation": agp_deviation,
        "glucoseMomentum": round(momentum, 4),
        "mean1h": round(one_h.mean()) if len(one_h) > 0 else sgv,
        "mean3h": round(three_h.mean()) if len(three_h) > 0 else sgv,
        "min1h": int(one_h.min()) if len(one_h) > 0 else sgv,
        "max1h": int(one_h.max()) if len(one_h) > 0 else sgv,
        "sleepActive": _in_any_interval(sleep_intervals, now),
        "exerciseActive": _in_any_interval(exercise_intervals, now),
        "timestamp": now,
    }


def precompute_mode_intervals(treatments: pd.DataFrame):
    """Return (sleep_intervals, exercise_intervals) as Nx2 [start_ms, end_ms] arrays
    from Sleep/Exercise usermode treatments. A marker covers [start, start+duration];
    provisional 'Not Ended' markers carry a long duration and just stay active."""
    def intervals_for(kind):
        if treatments.empty or "eventType" not in treatments.columns:
            return np.empty((0, 2), dtype=np.float64)
        m = treatments[treatments["eventType"] == kind]
        if m.empty:
            return np.empty((0, 2), dtype=np.float64)
        starts = m["mills"].values.astype(np.float64)
        durs = (m["duration"].fillna(0).values.astype(np.float64)
                if "duration" in m.columns else np.zeros(len(m)))
        return np.column_stack([starts, starts + durs * 60_000.0])
    return intervals_for("Sleep"), intervals_for("Exercise")


def _in_any_interval(intervals: np.ndarray | None, t: float) -> float:
    """1.0 if t falls within any [start, end] interval, else 0.0."""
    if intervals is None or len(intervals) == 0:
        return 0.0
    return 1.0 if bool(((t >= intervals[:, 0]) & (t <= intervals[:, 1])).any()) else 0.0


def precompute_treatment_arrays(treatments: pd.DataFrame, profile: dict):
    """Return (bolus_times, bolus_units, carb_times, carb_grams, temp_basal_segments)."""
    if treatments.empty:
        empty = np.empty(0, dtype=np.float64)
        return empty, empty, empty, empty, np.empty((0, 3), dtype=np.float64)

    boluses_df = treatments[treatments["insulin"].fillna(0) > 0]
    bolus_times_arr = boluses_df["mills"].values.astype(np.float64)
    bolus_units_arr = boluses_df["insulin"].values.astype(np.float64)

    carbs_df = treatments[treatments["carbs"].fillna(0) > 0]
    carb_times_arr = carbs_df["mills"].values.astype(np.float64)
    carb_grams_arr = carbs_df["carbs"].values.astype(np.float64)

    temp_basal_segments = build_temp_basal_segments(treatments, profile)
    return bolus_times_arr, bolus_units_arr, carb_times_arr, carb_grams_arr, temp_basal_segments
