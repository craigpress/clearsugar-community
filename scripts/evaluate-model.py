#!/usr/bin/env python3
"""
ClearSugar — Model evaluation and backtesting (held-out data).

Loads the ONNX models from MODEL_DIR, pulls a recent held-out period of real
data from Nightscout, reconstructs absolute predictions (delta target =>
currentSgv + predicted delta), and computes clinically meaningful metrics per
key horizon and overall:

  - RMSE / MAE
  - per-range MAE (actual <70, 70-180, >180)
  - persistence baseline (predict = currentSgv) RMSE/MAE
  - hypo-detection sensitivity & specificity at <70 and <54
  - Parkes (Consensus) Error Grid zone distribution (A/B/C/D/E), Type 1

Writes the full report to MODEL_DIR/eval-report.json and prints a summary.

Usage:
    python scripts/evaluate-model.py --url http://localhost:1337 --days 14 \
        --model-dir public/models
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from cs_features import (
    FEATURE_NAMES,
    compute_agp_medians,
    extract_features_at,
    fetch_entries,
    fetch_profile,
    fetch_treatments,
    find_site_changes,
    precompute_treatment_arrays,
    precompute_mode_intervals,
)

DEFAULT_MODEL_DIR = Path(__file__).parent.parent / "public" / "models"
KEY_HORIZONS = [15, 30, 60, 90, 120]
API_SECRET = os.environ.get("NIGHTSCOUT_API_SECRET", "")


# ── Parkes (Consensus) Error Grid — Type 1 diabetes ──
# Boundaries from:
#   Pfutzner A, et al. "Technical Aspects of the Parkes Error Grid." J Diabetes
#   Sci Technol 2013;7(5):1275-1281 — Table 1 (Type 1) coordinate sets.
# ref = reference (actual) glucose on x-axis, pred = predicted on y-axis (mg/dL).

# Each named line is the UPPER edge of a zone (overestimation side) or the
# LOWER edge (underestimation side). Boundaries are full-domain polylines over
# x in 0..550 and are ordered A (least severe) outward, so a first-match scan
# from A gives the correct zone. ref=x (actual), pred=y (predicted).
_UP = {
    "A": [(0, 50), (30, 50), (140, 170), (280, 380), (430, 550), (550, 550)],
    "B": [(0, 50), (30, 50), (50, 80), (70, 110), (260, 550), (550, 550)],
    "C": [(0, 60), (30, 60), (50, 80), (70, 110), (190, 550), (550, 550)],
    "D": [(0, 100), (25, 100), (50, 125), (80, 215), (125, 550), (550, 550)],
}
_LO = {
    "A": [(0, 0), (50, 0), (170, 145), (385, 300), (550, 450)],
    "B": [(0, 0), (120, 0), (120, 30), (260, 130), (550, 250)],
    "C": [(0, 0), (250, 0), (250, 40), (480, 150), (550, 160)],
}


def _interp_y(polyline, x):
    """Linear-interpolate y on a polyline (list of (x,y)) at the given x."""
    pts = polyline
    if x <= pts[0][0]:
        return pts[0][1]
    if x >= pts[-1][0]:
        return pts[-1][1]
    for i in range(1, len(pts)):
        x0, y0 = pts[i - 1]
        x1, y1 = pts[i]
        if x0 <= x <= x1:
            if x1 == x0:
                return max(y0, y1)
            frac = (x - x0) / (x1 - x0)
            return y0 + frac * (y1 - y0)
    return pts[-1][1]


def parkes_zone(ref: float, pred: float) -> str:
    """Classify a single (actual, predicted) pair into a Parkes Type-1 zone A-E.

    Uses the published Type-1 boundary lines. The grid is split by the identity
    region: above identity uses the 'upper_*' boundaries, below uses 'lower_*'.
    """
    ref = max(0.0, min(550.0, float(ref)))
    pred = max(0.0, min(550.0, float(pred)))

    if pred >= ref:
        # Overestimation side — least-severe zone whose UPPER edge is >= pred.
        for z in ("A", "B", "C", "D"):
            if pred <= _interp_y(_UP[z], ref):
                return z
        return "E"
    else:
        # Underestimation side — least-severe zone whose LOWER edge is <= pred.
        for z in ("A", "B", "C"):
            if pred >= _interp_y(_LO[z], ref):
                return z
        return "D"  # Lower-E is effectively unreachable in the Type-1 grid


def parkes_grid(actual: np.ndarray, predicted: np.ndarray) -> dict:
    zones = {"A": 0, "B": 0, "C": 0, "D": 0, "E": 0}
    for ref, pred in zip(actual, predicted):
        zones[parkes_zone(ref, pred)] += 1
    n = max(1, len(actual))
    return {
        "counts": zones,
        "percent": {z: round(c / n * 100, 2) for z, c in zones.items()},
        "n": int(len(actual)),
    }


# ── Metric helpers ──

def _safe(x):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), 2)


def hypo_sens_spec(actual: np.ndarray, predicted: np.ndarray, threshold: float) -> dict:
    """Sensitivity & specificity of predicting BG < threshold."""
    actual_low = actual < threshold
    pred_low = predicted < threshold
    tp = int(np.sum(actual_low & pred_low))
    fn = int(np.sum(actual_low & ~pred_low))
    tn = int(np.sum(~actual_low & ~pred_low))
    fp = int(np.sum(~actual_low & pred_low))
    sens = tp / (tp + fn) if (tp + fn) > 0 else None
    spec = tn / (tn + fp) if (tn + fp) > 0 else None
    return {
        "threshold": threshold,
        "tp": tp, "fn": fn, "tn": tn, "fp": fp,
        "sensitivity": _safe(sens),
        "specificity": _safe(spec),
        "n_actual_low": int(tp + fn),
    }


def per_range_mae(actual: np.ndarray, predicted: np.ndarray) -> dict:
    err = np.abs(predicted - actual)
    out = {}
    for label, mask in [
        ("lt70", actual < 70),
        ("70_180", (actual >= 70) & (actual <= 180)),
        ("gt180", actual > 180),
    ]:
        out[label] = {
            "n": int(np.sum(mask)),
            "mae": _safe(np.mean(err[mask])) if np.any(mask) else None,
        }
    return out


def band_coverage(actual: np.ndarray, low: np.ndarray, high: np.ndarray) -> dict:
    """Fraction of actuals within the served [low, high] interval (target ~0.80)."""
    inside = (actual >= low) & (actual <= high)
    n = len(actual)
    return {
        "coverage": _safe(float(np.mean(inside))) if n else None,
        "meanWidth": _safe(float(np.mean(high - low))) if n else None,
        "n": int(n),
    }


def horizon_metrics(
    actual: np.ndarray,
    predicted: np.ndarray,
    current: np.ndarray,
    low: np.ndarray | None = None,
    high: np.ndarray | None = None,
    low_raw: np.ndarray | None = None,
    high_raw: np.ndarray | None = None,
) -> dict:
    """Compute the full metric bundle for one horizon (or overall).

    When band arrays are supplied, also report band coverage (% of actuals within
    [low, high]). `low/high` are the SERVED (bandScale-applied) bands; `low_raw/
    high_raw` are the un-scaled bands, reported for comparison when available.
    """
    n = len(actual)
    if n == 0:
        return {"n": 0}
    err = predicted - actual
    rmse = float(np.sqrt(np.mean(err ** 2)))
    mae = float(np.mean(np.abs(err)))

    # Persistence baseline: predict = currentSgv
    perr = current - actual
    p_rmse = float(np.sqrt(np.mean(perr ** 2)))
    p_mae = float(np.mean(np.abs(perr)))

    out = {
        "n": int(n),
        "rmse": _safe(rmse),
        "mae": _safe(mae),
        "perRangeMAE": per_range_mae(actual, predicted),
        "persistence": {"rmse": _safe(p_rmse), "mae": _safe(p_mae)},
        "hypo70": hypo_sens_spec(actual, predicted, 70),
        "hypo54": hypo_sens_spec(actual, predicted, 54),
        "parkes": parkes_grid(actual, predicted),
    }
    if low is not None and high is not None:
        cov = band_coverage(actual, low, high)
        out["coverage"] = cov["coverage"]
        out["bandCoverage"] = {"served": cov}
        if low_raw is not None and high_raw is not None:
            out["bandCoverage"]["raw"] = band_coverage(actual, low_raw, high_raw)
    return out


# ── ONNX loading + inference ──

def load_sessions(model_dir: Path, horizons):
    """Load point + (when present) q10/q90 ONNX sessions per horizon.

    Returns {h: {"point": session, "q10": session|None, "q90": session|None}}.
    """
    import onnxruntime as ort
    sessions = {}
    for h in horizons:
        path = model_dir / f"glucose_pred_{h}.onnx"
        if not path.exists():
            continue
        entry = {"point": ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])}
        for suffix in ("q10", "q90"):
            qpath = model_dir / f"glucose_pred_{h}_{suffix}.onnx"
            entry[suffix] = (
                ort.InferenceSession(str(qpath), providers=["CPUExecutionProvider"])
                if qpath.exists() else None
            )
        sessions[h] = entry
    return sessions


def build_eval_dataset(entries, treatments, profile):
    """Build per-reading feature rows + absolute future SGV labels for all horizons.

    AGP medians use the eval window itself here (this is a held-out period being
    scored, not a train/val split), which is fine — no training happens.
    """
    agp_medians = compute_agp_medians(entries)
    site_changes = find_site_changes(treatments)
    (bt, bu, ct, cg, tbs) = precompute_treatment_arrays(treatments, profile)
    sleep_iv, exercise_iv = precompute_mode_intervals(treatments)
    dia_min = profile["dia"] * 60
    dates = entries["date"].values

    horizons = list(range(5, 185, 5))
    rows = []
    for idx in range(6, len(entries)):
        feats = extract_features_at(
            entries, profile, agp_medians, site_changes, idx,
            bt, bu, ct, cg, dia_min, tbs, sleep_iv, exercise_iv,
        )
        if feats is None:
            continue
        now = feats["timestamp"]
        cur = feats["currentSgv"]
        targets = {}
        for h in horizons:
            tt = now + h * 60_000
            diffs = np.abs(dates - tt)
            ci = int(np.argmin(diffs))
            if diffs[ci] <= 3 * 60_000:
                targets[f"actual_{h}"] = float(entries.iloc[ci]["sgv"])  # ABSOLUTE
        if targets:
            feats.update(targets)
            rows.append(feats)
    return pd.DataFrame(rows)


def evaluate():
    parser = argparse.ArgumentParser(description="Evaluate ClearSugar prediction models on held-out data")
    parser.add_argument("--url", type=str, default=os.environ.get("NIGHTSCOUT_URL", "http://localhost:1337"))
    parser.add_argument("--days", type=int, default=14, help="Days of recent held-out data to evaluate on")
    parser.add_argument("--model-dir", type=str, default=str(DEFAULT_MODEL_DIR))
    args = parser.parse_args()

    model_dir = Path(args.model_dir)
    meta_path = model_dir / "meta.json"
    if not meta_path.exists():
        print(f"ERROR: No meta.json in {model_dir}. Run train-model.py first.")
        sys.exit(1)
    with open(meta_path) as f:
        meta = json.load(f)

    target = meta.get("target", "absolute")
    feature_count = int(meta.get("featureCount", len(FEATURE_NAMES)))
    feature_names = meta.get("featureNames", FEATURE_NAMES)
    band_scale_meta = meta.get("bandScale", {}) if isinstance(meta.get("bandScale"), dict) else {}

    def band_scale_for(h):
        try:
            return float(band_scale_meta.get(str(int(h)), 1.0))
        except (TypeError, ValueError):
            return 1.0
    if list(feature_names) != list(FEATURE_NAMES):
        print("WARNING: meta.featureNames differs from cs_features.FEATURE_NAMES — feature drift!")

    print("ClearSugar Model Evaluation (held-out)")
    print(f"  Model version: {meta.get('modelVersion', '?')}  target={target}  features={feature_count}")
    print(f"  Nightscout: {args.url}   Eval window: {args.days} days")
    print()

    # Pull held-out data
    entries = fetch_entries(args.url, args.days, API_SECRET)
    if entries.empty:
        print("ERROR: No CGM data returned from Nightscout.")
        sys.exit(1)
    treatments = fetch_treatments(args.url, args.days, API_SECRET)
    profile = fetch_profile(args.url, API_SECRET)

    print("Building evaluation dataset...")
    df = build_eval_dataset(entries, treatments, profile)
    if df.empty:
        print("ERROR: No labeled evaluation rows built.")
        sys.exit(1)
    print(f"  {len(df)} evaluation rows")

    horizons = [h for h in range(5, 185, 5)]
    sessions = load_sessions(model_dir, horizons)
    if not sessions:
        print(f"ERROR: No ONNX models found in {model_dir}.")
        sys.exit(1)

    X_all = df[FEATURE_NAMES].values.astype(np.float32)
    cur_all = df["currentSgv"].values.astype(np.float64)

    report = {
        "evaluatedAt": datetime.utcnow().isoformat() + "Z",
        "modelVersion": meta.get("modelVersion"),
        "target": target,
        "evalDays": args.days,
        "nightscout": args.url,
        "horizons": {},
    }

    # Accumulate overall (across key horizons) actual/pred/current + bands
    overall_actual, overall_pred, overall_cur = [], [], []
    overall_lo, overall_hi, overall_lo_raw, overall_hi_raw = [], [], [], []

    for h in horizons:
        if h not in sessions:
            continue
        col = f"actual_{h}"
        mask = df[col].notna().values
        if mask.sum() == 0:
            continue
        Xh = X_all[mask]
        cur_h = cur_all[mask]
        actual_h = df.loc[mask, col].values.astype(np.float64)

        sess = sessions[h]
        raw = sess["point"].run(None, {"input": Xh})[0].reshape(-1).astype(np.float64)
        pred_h = (cur_h + raw) if target == "delta" else raw

        # Reconstruct bands the same way the predict server does (delta + currentSgv,
        # de-cross, clamp to point, apply bandScale, clamp to display range).
        lo_h = hi_h = lo_raw_h = hi_raw_h = None
        if sess.get("q10") is not None and sess.get("q90") is not None:
            q10 = sess["q10"].run(None, {"input": Xh})[0].reshape(-1).astype(np.float64)
            q90 = sess["q90"].run(None, {"input": Xh})[0].reshape(-1).astype(np.float64)
            base = cur_h if target == "delta" else 0.0
            q10a, q90a = base + q10, base + q90
            lo0 = np.minimum(q10a, q90a)
            hi0 = np.maximum(q10a, q90a)
            lo0 = np.minimum(lo0, pred_h)
            hi0 = np.maximum(hi0, pred_h)
            scale = band_scale_for(h)
            lo_h = np.clip(pred_h - (pred_h - lo0) * scale, 39, 401)
            hi_h = np.clip(pred_h + (hi0 - pred_h) * scale, 39, 401)
            lo_raw_h = np.clip(lo0, 39, 401)
            hi_raw_h = np.clip(hi0, 39, 401)

        pred_h = np.clip(pred_h, 39, 401)  # match serving clamp

        m = horizon_metrics(actual_h, pred_h, cur_h, lo_h, hi_h, lo_raw_h, hi_raw_h)
        report["horizons"][str(h)] = m

        if h in KEY_HORIZONS:
            overall_actual.append(actual_h)
            overall_pred.append(pred_h)
            overall_cur.append(cur_h)
            if lo_h is not None:
                overall_lo.append(lo_h)
                overall_hi.append(hi_h)
                overall_lo_raw.append(lo_raw_h)
                overall_hi_raw.append(hi_raw_h)

    if overall_actual:
        # Only pass overall bands if every key horizon contributed bands (shapes align).
        has_bands = len(overall_lo) == len(overall_actual) and len(overall_lo) > 0
        report["overall"] = horizon_metrics(
            np.concatenate(overall_actual),
            np.concatenate(overall_pred),
            np.concatenate(overall_cur),
            np.concatenate(overall_lo) if has_bands else None,
            np.concatenate(overall_hi) if has_bands else None,
            np.concatenate(overall_lo_raw) if has_bands else None,
            np.concatenate(overall_hi_raw) if has_bands else None,
        )

    # ── Write + print ──
    out_path = model_dir / "eval-report.json"
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2)

    _print_report(report)
    print(f"\nFull report written to {out_path}")


def _print_report(report: dict):
    def fmt(v):
        return "—" if v is None else f"{v}"

    print("\n=== Per-horizon (key) ===")
    header = f"{'h(min)':>7} {'n':>6} {'RMSE':>7} {'MAE':>7} {'persRMSE':>9} {'persMAE':>8} {'cover':>6} {'sens70':>7} {'spec70':>7} {'sens54':>7} {'A%':>6} {'A+B%':>6}"
    print(header)
    for h in KEY_HORIZONS:
        m = report["horizons"].get(str(h))
        if not m or m.get("n", 0) == 0:
            continue
        pk = m["parkes"]["percent"]
        ab = round(pk["A"] + pk["B"], 1)
        print(
            f"{h:>7} {m['n']:>6} {fmt(m['rmse']):>7} {fmt(m['mae']):>7} "
            f"{fmt(m['persistence']['rmse']):>9} {fmt(m['persistence']['mae']):>8} "
            f"{fmt(m.get('coverage')):>6} "
            f"{fmt(m['hypo70']['sensitivity']):>7} {fmt(m['hypo70']['specificity']):>7} "
            f"{fmt(m['hypo54']['sensitivity']):>7} {fmt(pk['A']):>6} {fmt(ab):>6}"
        )

    if "overall" in report:
        m = report["overall"]
        print("\n=== Overall (key horizons combined) ===")
        print(f"  n={m['n']}  RMSE={fmt(m['rmse'])}  MAE={fmt(m['mae'])}  "
              f"(persistence RMSE={fmt(m['persistence']['rmse'])}, MAE={fmt(m['persistence']['mae'])})")
        pr = m["perRangeMAE"]
        print(f"  per-range MAE: <70 n={pr['lt70']['n']} MAE={fmt(pr['lt70']['mae'])} | "
              f"70-180 n={pr['70_180']['n']} MAE={fmt(pr['70_180']['mae'])} | "
              f">180 n={pr['gt180']['n']} MAE={fmt(pr['gt180']['mae'])}")
        h70, h54 = m["hypo70"], m["hypo54"]
        print(f"  hypo<70: sens={fmt(h70['sensitivity'])} spec={fmt(h70['specificity'])} "
              f"(actual lows={h70['n_actual_low']})")
        print(f"  hypo<54: sens={fmt(h54['sensitivity'])} spec={fmt(h54['specificity'])} "
              f"(actual lows={h54['n_actual_low']})")
        pk = m["parkes"]["percent"]
        print(f"  Parkes zones: A={pk['A']}% B={pk['B']}% C={pk['C']}% D={pk['D']}% E={pk['E']}%")
        bc = m.get("bandCoverage")
        if bc:
            served = bc.get("served", {})
            raw = bc.get("raw")
            line = (f"  band coverage (target 0.80): served={fmt(served.get('coverage'))} "
                    f"(mean width {fmt(served.get('meanWidth'))})")
            if raw:
                line += f" | raw={fmt(raw.get('coverage'))} (width {fmt(raw.get('meanWidth'))})"
            print(line)


if __name__ == "__main__":
    evaluate()
