#!/usr/bin/env python3
"""
cs_physio.py — Faithful Python port of ClearSugar's PRODUCTION physiological
prediction model.

Ported byte-for-byte (constants + formulas) from:
  src/lib/prediction/physiological-model.ts
  src/lib/prediction/rescue-carb-detector.ts  (calculateInferredCOB, fast-carb curve)
  feature inputs in src/lib/prediction/feature-engine.ts

This module is the SHARED FOUNDATION for the Phase 0 advisor analysis. Other
agents import it, so the API is stable and correctness is matched to the .ts.

Design choices / divergences resolved (see also the report):
  * Pure stdlib only (urllib, datetime, math). No pandas/numpy/requests/onnx,
    so importing this module is free of side effects. Treatments and readings
    are plain lists of dicts (raw Nightscout JSON shape), NOT DataFrames.
  * scripts/cs_features.py is the TRAINING feature engine (pandas/numpy,
    vectorized, uses zoneinfo America/New_York for get_scheduled_value). Where
    its time handling differs, THIS module follows the production .ts behavior.
  * TIME ZONE: physiological-model.ts getScheduledValue uses JS Date.getHours()
    i.e. the SERVER's local wall-clock time. The production deployment runs in
    America/New_York. The .ts code itself does NOT convert to NY explicitly —
    it relies on the host TZ. Per the task spec, for the 90-day analysis window
    the NY offset is a constant EDT = UTC-4 (post-DST). We therefore apply a
    FIXED -4h offset to derive seconds-of-day and avoid zoneinfo/tzdata on
    Python 3.13/Windows. ASSUMPTION: every timestamp in the analysis window is
    EDT (UTC-4). If the window straddled a DST boundary (Nov/Mar) the
    schedule-segment lookup near 02:00 local could be off by one hour for the
    affected days; the current 90-day window does not.
  * cs_features.py's calculate_cob uses the SAME Hermite smoothstep over 180min
    with a 240min safety window as physiological-model.ts carbAbsorptionPercent
    — they AGREE. (The ML review's "COB divergence" note does not apply to the
    current code; both implement 3s^2-2s^3 over 180min.)
  * MOMENTUM is ASYMMETRIC in the production .ts: rising trends decay faster
    (exp(-step*0.14)) than falling trends (exp(-step*0.045)). The task brief
    quoted only the falling branch; we port BOTH branches faithfully. A trend
    is "rising" when roc > 0.5 mg/dL per 5 min. include_momentum=False zeroes
    the entire momentum term (downstream advisory math runs momentum-free).
"""

from __future__ import annotations

import json
import math
import os
import urllib.parse
import urllib.request
from datetime import datetime, timezone

# ── Constants (match physiological-model.ts exactly) ──
FIVE_MIN_MS = 5 * 60_000
INSULIN_DELAY_MIN = 10          # 10-min delay before insulin acts (matches Loop)
IOB_PEAK_MIN = 75               # tp: time of peak activity for rapid-acting
DEFAULT_DIA_HOURS = 5.0         # falls back to 5h if profile lacks dia
COB_ABSORPTION_MIN = 180        # Hermite smoothstep span
COB_SAFETY_WINDOW_MIN = 240     # fully absorbed by the 4h safety window
RESCUE_ABSORPTION_MIN = 30      # fast-sugar fully absorbed by 30 min
RESCUE_SHIFT_MIN = 20           # fast hermite uses min(1, age/20)

# Fixed EDT offset for the analysis window (see module docstring).
EDT_OFFSET_HOURS = -4
EDT_OFFSET_MS = EDT_OFFSET_HOURS * 3_600_000

NIGHTSCOUT_URL = os.environ.get("NIGHTSCOUT_URL", "http://localhost:1337")
API_SECRET = os.environ.get("NIGHTSCOUT_API_SECRET", "")


# ──────────────────────────────────────────────────────────────────────────
# Fetching (pure stdlib urllib, paginated) — mirrors phase0_observability.py
# ──────────────────────────────────────────────────────────────────────────
def _get(url, params):
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{url}?{qs}", headers={
        "Accept": "application/json",
        "User-Agent": "ClearSugar-Physio/1.0",
        **({"API-SECRET": API_SECRET} if API_SECRET else {}),
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def fetch_treatments(url=NIGHTSCOUT_URL, days=90):
    """Fetch `days` of treatments (raw Nightscout dicts), newest-last."""
    since = datetime.now(timezone.utc).timestamp() - days * 86400
    since_iso = datetime.fromtimestamp(since, timezone.utc).isoformat()
    out, count = [], 10000
    params = {"count": count, "find[created_at][$gte]": since_iso}
    batch = _get(f"{url}/api/v1/treatments.json", params)
    out.extend(batch)
    while len(batch) == count:
        params["find[created_at][$lt]"] = batch[-1].get("created_at", "")
        batch = _get(f"{url}/api/v1/treatments.json", params)
        out.extend(batch)
    return out


def fetch_entries(url=NIGHTSCOUT_URL, days=90):
    """Fetch `days` of CGM sgv entries (raw Nightscout dicts)."""
    since = int((datetime.now(timezone.utc).timestamp() - days * 86400) * 1000)
    out, count = [], 10000
    params = {"count": count, "find[date][$gte]": since}
    batch = _get(f"{url}/api/v1/entries.json", params)
    out.extend(batch)
    while len(batch) == count:
        oldest = min(e["date"] for e in batch)
        params["find[date][$lt]"] = oldest
        batch = _get(f"{url}/api/v1/entries.json", params)
        out.extend(batch)
    return [e for e in out if e.get("type") == "sgv"]


def fetch_profile(url=NIGHTSCOUT_URL):
    """Fetch the active pump profile store entry (sens/carbratio/basal/dia).

    Returns the normalized active store dict with keys: dia (float),
    sens, carbratio, basal (each a list of {timeAsSeconds, value}).
    """
    profiles = _get(f"{url}/api/v1/profile.json", {})
    if not profiles:
        raise ValueError("No pump profile found in Nightscout")
    profile = profiles[0]
    name = profile.get("defaultProfile", "Default")
    store = profile["store"][name]
    dia = store.get("dia", DEFAULT_DIA_HOURS)
    dia = float(dia) if not isinstance(dia, str) else float(dia)
    return {
        "dia": dia,
        "sens": store.get("sens", [{"timeAsSeconds": 0, "value": 50}]),
        "carbratio": store.get("carbratio", [{"timeAsSeconds": 0, "value": 10}]),
        "basal": store.get("basal", [{"timeAsSeconds": 0, "value": 0.5}]),
    }


# ──────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────
def treatment_time(t) -> int:
    """Epoch ms for a treatment: mills if present, else parsed created_at.
    Mirrors treatmentTime() in physiological-model.ts."""
    m = t.get("mills")
    if m and m > 0:
        return int(m)
    ca = t.get("created_at")
    if not ca:
        return 0
    try:
        return int(datetime.fromisoformat(ca.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return 0


def _dia_minutes(profile) -> float:
    dia_hours = profile.get("dia", DEFAULT_DIA_HOURS)
    if isinstance(dia_hours, str):
        dia_hours = float(dia_hours)
    return dia_hours * 60.0


def get_scheduled_value(segments, at_ms: int) -> float:
    """Look up a time-segmented profile value (ISF/CR/basal/target) at at_ms.

    Faithful to getScheduledValue() in physiological-model.ts: picks the last
    segment whose timeAsSeconds <= seconds-of-day. Seconds-of-day is computed
    using the FIXED EDT (-4h) offset (see module docstring) rather than the
    host TZ that the .ts implicitly relies on.
    """
    if not segments:
        return 0.0
    # seconds-of-day in EDT local time
    local_ms = at_ms + EDT_OFFSET_MS
    sec_of_day = int((local_ms // 1000) % 86400)
    value = segments[0]["value"]
    for entry in segments:
        if entry["timeAsSeconds"] <= sec_of_day:
            value = entry["value"]
        else:
            break
    return float(value)


# ──────────────────────────────────────────────────────────────────────────
# IOB — Maksimovic exponential model (DIA from profile, peak 75min, 10min delay)
# ──────────────────────────────────────────────────────────────────────────
def iob_curve_percent(minutes_age: float, dia_minutes: float) -> float:
    """Fraction of a bolus still on board at age `minutes_age`.
    Faithful port of iobCurvePercent() in physiological-model.ts."""
    effective_age = minutes_age - INSULIN_DELAY_MIN
    if effective_age <= 0:
        return 1.0  # still in delay period, 100% remaining
    if minutes_age >= dia_minutes:
        return 0.0

    td = dia_minutes - INSULIN_DELAY_MIN          # effective duration after delay
    tp = IOB_PEAK_MIN - INSULIN_DELAY_MIN         # shift peak by delay
    t = effective_age

    tau = tp * (1 - tp / td) / (1 - 2 * tp / td)
    a = 2 * tau / td
    S = 1 / (1 - a + (1 + a) * math.exp(-td / tau))

    iob = 1 - S * (1 - a) * (
        (t * t / (tau * td * (1 - a)) - t / tau - 1) * math.exp(-t / tau) + 1
    )
    return max(0.0, min(1.0, iob))


def calc_iob(treatments, at_ms: int, profile) -> float:
    """Insulin on board at at_ms. Includes boluses + Control-IQ temp-basal
    deltas (above/below scheduled basal). Aggregate IOB cannot go negative.
    Faithful port of calculateIOB() in physiological-model.ts."""
    dia_minutes = _dia_minutes(profile)
    basal_sched = profile.get("basal", [])
    iob = 0.0

    for t in treatments:
        ins = t.get("insulin")
        if ins and ins > 0:
            age = (at_ms - treatment_time(t)) / 60_000
            if 0 <= age < dia_minutes:
                iob += ins * iob_curve_percent(age, dia_minutes)

        if (
            t.get("eventType") == "Temp Basal"
            and t.get("duration")
            and t.get("duration") > 0
            and (t.get("rate") is not None or t.get("absolute") is not None)
        ):
            start_time = treatment_time(t)
            end_time = start_time + t["duration"] * 60_000
            rate = t.get("absolute")
            if rate is None:
                rate = t.get("rate")
            if rate is None:
                rate = 0
            scheduled = get_scheduled_value(basal_sched, start_time)
            delta_rate = rate - scheduled
            if delta_rate != 0 and start_time < at_ms and end_time > at_ms - dia_minutes * 60_000:
                overlap_start = max(start_time, at_ms - dia_minutes * 60_000)
                overlap_end = min(end_time, at_ms)
                duration_hrs = (overlap_end - overlap_start) / 3_600_000
                extra_insulin = delta_rate * duration_hrs
                avg_age = (at_ms - (overlap_start + overlap_end) / 2) / 60_000
                iob += extra_insulin * iob_curve_percent(avg_age, dia_minutes)

    return max(0.0, iob)


def calc_iob_for_autosens(treatments, dia_minutes: float, at_ms: int) -> float:
    """Simplified IOB (boluses only) used by autosens.
    Faithful port of calculateIOBForAutosens()."""
    iob = 0.0
    for t in treatments:
        ins = t.get("insulin")
        if ins and ins > 0:
            age = (at_ms - treatment_time(t)) / 60_000
            if 0 <= age < dia_minutes:
                iob += ins * iob_curve_percent(age, dia_minutes)
    return max(0.0, iob)


# ──────────────────────────────────────────────────────────────────────────
# COB — Hermite smoothstep over 180min, 240min safety window
# ──────────────────────────────────────────────────────────────────────────
def carb_absorption_percent(minutes_age: float) -> float:
    """Fraction of carbs absorbed at age `minutes_age`.
    Faithful port of carbAbsorptionPercent() in physiological-model.ts."""
    if minutes_age <= 0:
        return 0.0
    if minutes_age >= COB_SAFETY_WINDOW_MIN:
        return 1.0
    shifted = min(1.0, minutes_age / COB_ABSORPTION_MIN)
    return shifted * shifted * (3 - 2 * shifted)


def calc_cob(treatments, at_ms: int) -> float:
    """Carbs on board at at_ms. Faithful port of calculateCOB()."""
    cob = 0.0
    for t in treatments:
        carbs = t.get("carbs")
        if carbs and carbs > 0:
            age = (at_ms - treatment_time(t)) / 60_000
            if 0 <= age < COB_SAFETY_WINDOW_MIN:
                absorbed = carbs * carb_absorption_percent(age)
                cob += carbs - absorbed
    return max(0.0, cob)


# ── Inferred rescue-carb COB (fast-sugar curve) ──
def fast_carb_absorption_percent(minutes_age: float) -> float:
    """Faithful port of fastCarbAbsorptionPercent() in rescue-carb-detector.ts.
    NOTE: the .ts uses min(1, age/20) for the shifted hermite (peaks ~10min,
    fully absorbed by 30min)."""
    if minutes_age <= 0:
        return 0.0
    if minutes_age >= RESCUE_ABSORPTION_MIN:
        return 1.0
    shifted = min(1.0, minutes_age / RESCUE_SHIFT_MIN)
    return shifted * shifted * (3 - 2 * shifted)


def calc_inferred_cob(rescue_carbs, at_ms: int) -> float:
    """Faithful port of calculateInferredCOB(). rescue_carbs is a list of dicts
    with keys 'timestamp' (ms) and 'estimatedGrams'."""
    cob = 0.0
    for rc in rescue_carbs:
        age = (at_ms - rc["timestamp"]) / 60_000
        if 0 <= age < RESCUE_ABSORPTION_MIN:
            absorbed = rc["estimatedGrams"] * fast_carb_absorption_percent(age)
            cob += rc["estimatedGrams"] - absorbed
    return max(0.0, cob)


# ──────────────────────────────────────────────────────────────────────────
# Rate of change — linear regression over a 15-min window, mg/dL per 5 min
# ──────────────────────────────────────────────────────────────────────────
def estimate_roc(readings, window_minutes: int = 15) -> float:
    """Faithful port of estimateRateOfChange(). readings are dicts with
    'date' (ms) and 'sgv'. Returns mg/dL per 5 minutes."""
    if len(readings) < 2:
        return 0.0
    sorted_r = sorted(readings, key=lambda r: r["date"], reverse=True)
    now = sorted_r[0]["date"]
    cutoff = now - window_minutes * 60_000
    win = [r for r in sorted_r if r["date"] >= cutoff]
    if len(win) < 2:
        return 0.0

    n = len(win)
    sum_x = sum_y = sum_xy = sum_x2 = 0.0
    for r in win:
        x = (r["date"] - now) / 60_000  # minutes relative to now (<= 0)
        y = r["sgv"]
        sum_x += x
        sum_y += y
        sum_xy += x * y
        sum_x2 += x * x
    denom = n * sum_x2 - sum_x * sum_x
    if denom == 0:
        return 0.0
    slope = (n * sum_xy - sum_x * sum_y) / denom  # mg/dL per minute
    return slope * 5


# ──────────────────────────────────────────────────────────────────────────
# Autosens — dynamic ISF ratio, clamped [0.5, 1.5], default 1.0 if <24 readings
# ──────────────────────────────────────────────────────────────────────────
def autosens_ratio(readings, treatments, profile) -> float:
    """Faithful port of calculateAutosens(). Returns 1.0 when <24 readings."""
    dia_minutes = _dia_minutes(profile)
    sens_sched = profile.get("sens", [])

    sorted_r = sorted(readings, key=lambda r: r["date"])
    if len(sorted_r) < 24:
        return 1.0

    now = sorted_r[-1]["date"]
    window_start = now - 8 * 3_600_000  # 8 hours

    ratios = []
    for i in range(6, len(sorted_r)):
        current = sorted_r[i]
        if current["date"] < window_start:
            continue
        target_time = current["date"] - 30 * 60_000
        prev = None
        for j in range(i - 1, -1, -1):
            dt = abs(sorted_r[j]["date"] - target_time)
            if dt < 5 * 60_000:
                prev = sorted_r[j]
                break
            if sorted_r[j]["date"] < target_time - 5 * 60_000:
                break
        if prev is None:
            continue

        actual_delta = current["sgv"] - prev["sgv"]
        mid_time = (current["date"] + prev["date"]) / 2

        iob_start = calc_iob_for_autosens(treatments, dia_minutes, prev["date"])
        iob_end = calc_iob_for_autosens(treatments, dia_minutes, current["date"])
        insulin_absorbed = iob_start - iob_end
        if abs(insulin_absorbed) < 0.05:
            continue

        profile_isf = get_scheduled_value(sens_sched, int(mid_time))
        expected_delta = -insulin_absorbed * profile_isf
        if abs(expected_delta) < 3:
            continue

        ratio = actual_delta / expected_delta if expected_delta != 0 else 1
        if 0.2 < ratio < 3.0:
            ratios.append(ratio)

    if len(ratios) < 3:
        return 1.0
    ratios.sort()
    median = ratios[len(ratios) // 2]
    return max(0.5, min(1.5, median))


# ──────────────────────────────────────────────────────────────────────────
# Forward simulation
# ──────────────────────────────────────────────────────────────────────────
def predict_physiological(
    readings,
    treatments,
    profile,
    horizon,
    rescue_carbs=None,
    include_momentum=True,
):
    """Faithful port of predictPhysiological().

    Args:
      readings: list of {'date': ms, 'sgv': mg/dL}
      treatments: list of raw Nightscout treatment dicts
      profile: normalized active store dict (see fetch_profile)
      horizon: prediction horizon in MINUTES (steps = horizon // 5)
      rescue_carbs: optional list of {'timestamp': ms, 'estimatedGrams': g}
      include_momentum: when False, the momentum term is zeroed so the
        trajectory is IOB+COB+basal only (downstream advisory math must run
        momentum-free). Everything else (autosens, ISF, confidence band) is
        identical to the momentum variant.

    Returns dict: {'points': [...], 'iob': float, 'cob': int}
      each point: {'timestamp': ms, 'sgv': int,
                   'confidence': {'low': int, 'high': int}}
    """
    rescue_carbs = rescue_carbs or []
    if len(readings) < 2:
        return {"points": [], "iob": 0.0, "cob": 0}

    sorted_r = sorted(readings, key=lambda r: r["date"], reverse=True)
    latest = sorted_r[0]
    now = latest["date"]
    sens_sched = profile.get("sens", [])
    cr_sched = profile.get("carbratio", [])

    roc = estimate_roc(readings)
    current_iob = calc_iob(treatments, now, profile)
    current_cob = calc_cob(treatments, now)
    ar = autosens_ratio(readings, treatments, profile)

    steps = horizon // 5
    points = []
    prev_sgv = latest["sgv"]

    recent_values = [r["sgv"] for r in sorted_r[:6]]  # last 30 min
    recent_mean = sum(recent_values) / len(recent_values)
    recent_std = math.sqrt(
        sum((v - recent_mean) ** 2 for v in recent_values) / len(recent_values)
    )
    base_uncertainty = max(recent_std, 5)

    is_rising = roc > 0.5

    for step in range(1, steps + 1):
        future_time = now + step * FIVE_MIN_MS

        # 1. Momentum (asymmetric decay) — zeroed when include_momentum False
        if include_momentum:
            roc_decay = math.exp(-step * 0.14) if is_rising else math.exp(-step * 0.045)
            momentum_delta = roc * roc_decay
        else:
            momentum_delta = 0.0

        # 2. IOB effect
        iob_now = calc_iob(treatments, future_time, profile)
        iob_prev = calc_iob(treatments, future_time - FIVE_MIN_MS, profile)
        insulin_absorbed = iob_prev - iob_now
        profile_isf = get_scheduled_value(sens_sched, future_time)
        isf = profile_isf * ar
        iob_effect = -insulin_absorbed * isf

        # 3. COB effect
        cob_now = calc_cob(treatments, future_time)
        cob_prev = calc_cob(treatments, future_time - FIVE_MIN_MS)
        carbs_absorbed = cob_prev - cob_now
        cr = get_scheduled_value(cr_sched, future_time)
        cob_effect = (carbs_absorbed / cr) * isf if cr > 0 else 0.0

        # 4. Inferred rescue carb effect
        rescue_cob_effect = 0.0
        if rescue_carbs:
            rcob_now = calc_inferred_cob(rescue_carbs, future_time)
            rcob_prev = calc_inferred_cob(rescue_carbs, future_time - FIVE_MIN_MS)
            rescue_absorbed = rcob_prev - rcob_now
            rescue_cob_effect = (rescue_absorbed / cr) * isf if cr > 0 else 0.0

        delta = momentum_delta + iob_effect + cob_effect + rescue_cob_effect
        predicted = round(max(39, min(401, prev_sgv + delta)))

        rescue_boost = 1.3 if rescue_carbs else 1.0
        uncertainty_mult = math.sqrt(step) * rescue_boost
        band = base_uncertainty * uncertainty_mult
        confidence_low = round(max(39, predicted - band))
        confidence_high = round(min(401, predicted + band))

        points.append({
            "timestamp": future_time,
            "sgv": predicted,
            "confidence": {"low": confidence_low, "high": confidence_high},
        })
        prev_sgv = predicted

    return {
        "points": points,
        "iob": round(current_iob * 100) / 100,
        "cob": round(current_cob),
    }


if __name__ == "__main__":
    # Smoke / sanity check against live Nightscout (reads only).
    prof = fetch_profile()
    treats = fetch_treatments(days=2)
    entries = fetch_entries(days=1)
    readings = [{"date": int(e["date"]), "sgv": e["sgv"]} for e in entries if e.get("sgv")]
    now = max(r["date"] for r in readings) if readings else 0
    print(f"profile dia={prof['dia']}h  treatments={len(treats)}  readings={len(readings)}")
    print(f"IOB now = {calc_iob(treats, now, prof):.2f} u")
    print(f"COB now = {calc_cob(treats, now):.1f} g")
    print(f"ROC = {estimate_roc(readings):.2f} mg/dL/5min")
    print(f"autosens = {autosens_ratio(readings, treats, prof):.3f}")
    pred = predict_physiological(readings, treats, prof, 60)
    predmf = predict_physiological(readings, treats, prof, 60, include_momentum=False)
    if pred["points"]:
        print(f"60min pred (momentum)   = {pred['points'][-1]['sgv']}")
        print(f"60min pred (momentum-free)= {predmf['points'][-1]['sgv']}")
