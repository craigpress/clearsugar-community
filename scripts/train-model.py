#!/usr/bin/env python3
"""
ClearSugar — LightGBM glucose prediction model trainer

Pulls historical CGM + treatment data from Nightscout, engineers features,
trains LightGBM models for 36 horizons (5..180 min, every 5 min), and exports
to ONNX.

Target is Δglucose: label = sgv(t+h) - sgv(t). The predict server reconstructs
the absolute prediction by adding currentSgv back. Feature engineering + data
loading are shared with evaluate-model.py via cs_features.py; the canonical
20-feature ordered list (FEATURE_NAMES) lives there and must match
src/lib/prediction/types.ts ML_FEATURE_NAMES.

Usage:
    python scripts/train-model.py [--days 90] [--url http://localhost:1337]

Requirements: see scripts/requirements.txt
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

# ── Configuration ──

NIGHTSCOUT_URL = os.environ.get("NIGHTSCOUT_URL", "http://localhost:1337")
API_SECRET = os.environ.get("NIGHTSCOUT_API_SECRET", "")
OUTPUT_DIR = Path(os.environ.get("MODEL_OUTPUT_DIR", "")) or Path(__file__).parent.parent / "public" / "models"

HORIZONS = list(range(5, 185, 5))  # every 5 min from 5 to 180 (36 models)
MODEL_VERSION = "2026-06-12b"
RANDOM_SEED = 42

# Validation = last 7 days; AGP/context features are computed from TRAIN ONLY.
VAL_DAYS = 7


# ── Dataset Building ──

def build_dataset(
    entries: pd.DataFrame,
    treatments: pd.DataFrame,
    profile: dict,
):
    """Build feature + Δlabel dataset from historical data.

    AGP medians are computed from the TRAINING partition only (rows before the
    validation cutoff) to avoid leaking validation data into agpDeviation.
    Returns (dataframe, val_cutoff_ms).
    """
    # Temporal split cutoff (last VAL_DAYS days = validation)
    max_ts = int(entries["date"].max())
    val_cutoff = max_ts - VAL_DAYS * 24 * 3_600_000

    print("Computing AGP medians (training partition only)...")
    train_entries = entries[entries["date"] < val_cutoff]
    if len(train_entries) < 100:
        print("WARNING: very few training entries before the validation cutoff.")
        train_entries = entries  # degrade gracefully for tiny datasets
    agp_medians = compute_agp_medians(train_entries)

    print("Extracting site changes...")
    site_changes = find_site_changes(treatments)

    (
        bolus_times_arr,
        bolus_units_arr,
        carb_times_arr,
        carb_grams_arr,
        temp_basal_segments,
    ) = precompute_treatment_arrays(treatments, profile)
    sleep_iv, exercise_iv = precompute_mode_intervals(treatments)

    dia_min = profile["dia"] * 60

    print("Engineering features (this may take a few minutes)...")
    rows = []
    dates = entries["date"].values

    for idx in range(6, len(entries)):
        if idx % 5000 == 0:
            pct = idx / len(entries) * 100
            print(f"  {pct:.0f}% ({idx}/{len(entries)})")

        features = extract_features_at(
            entries, profile, agp_medians, site_changes, idx,
            bolus_times_arr, bolus_units_arr, carb_times_arr, carb_grams_arr,
            dia_min, temp_basal_segments, sleep_iv, exercise_iv,
        )
        if features is None:
            continue

        now = features["timestamp"]
        current_sgv = features["currentSgv"]

        # Labels: Δglucose at +h min, i.e. sgv(t+h) - sgv(t)
        labels = {}
        for horizon in HORIZONS:
            target_time = now + horizon * 60_000
            diffs = np.abs(dates - target_time)
            closest_idx = int(np.argmin(diffs))
            if diffs[closest_idx] <= 3 * 60_000:  # within 3 min tolerance
                future_sgv = entries.iloc[closest_idx]["sgv"]
                labels[f"target_{horizon}"] = future_sgv - current_sgv  # DELTA target

        if len(labels) > 0:
            features.update(labels)
            rows.append(features)

    df = pd.DataFrame(rows)
    print(f"  Built {len(df)} labeled examples")
    return df, val_cutoff


# ── Model Training ──

def train_models(df: pd.DataFrame, val_cutoff: int) -> dict:
    """Train LightGBM models for each horizon (Δglucose target)."""
    import lightgbm as lgb

    train = df[df["timestamp"] < val_cutoff]
    val = df[df["timestamp"] >= val_cutoff]
    print(f"\nTrain: {len(train)} rows, Validation: {len(val)} rows")

    base_params = {
        "objective": "regression",
        "metric": "rmse",
        "num_leaves": 63,
        "learning_rate": 0.05,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq": 5,
        "min_child_samples": 20,
        "verbose": -1,
        # Reproducibility
        "seed": RANDOM_SEED,
        "random_state": RANDOM_SEED,
        "bagging_seed": RANDOM_SEED,
        "feature_fraction_seed": RANDOM_SEED,
        "deterministic": True,
        "force_row_wise": True,  # required for deterministic + avoids a warning
    }

    results = {}
    for horizon in HORIZONS:
        target_col = f"target_{horizon}"
        train_h = train.dropna(subset=[target_col])
        val_h = val.dropna(subset=[target_col])
        if len(train_h) < 50 or len(val_h) < 10:
            print(f"  Skipping {horizon:3d}min — insufficient data ({len(train_h)} train, {len(val_h)} val)")
            continue
        X_train = train_h[FEATURE_NAMES].values
        X_val = val_h[FEATURE_NAMES].values
        y_train = train_h[target_col].values  # deltas
        y_val = val_h[target_col].values       # deltas
        cur_val = val_h["currentSgv"].values   # to reconstruct absolute for reporting

        is_key = horizon in [15, 30, 60, 90, 120, 180]
        print(f"  Training {horizon:3d}min..." + (" (key)" if is_key else ""), end="", flush=True)

        train_data = lgb.Dataset(X_train, label=y_train, feature_name=FEATURE_NAMES)
        val_data = lgb.Dataset(X_val, label=y_val, feature_name=FEATURE_NAMES, reference=train_data)

        # Point model (L2)
        model = lgb.train(
            base_params,
            train_data,
            num_boost_round=500,
            valid_sets=[val_data],
            callbacks=[lgb.early_stopping(50), lgb.log_evaluation(0)],
        )

        # Quantile models — each gets its OWN early stopping (not the point model's best_iteration)
        params_q10 = {**base_params, "objective": "quantile", "alpha": 0.1, "metric": "quantile"}
        params_q90 = {**base_params, "objective": "quantile", "alpha": 0.9, "metric": "quantile"}

        model_q10 = lgb.train(
            params_q10, train_data, num_boost_round=500,
            valid_sets=[val_data],
            callbacks=[lgb.early_stopping(50), lgb.log_evaluation(0)],
        )
        model_q90 = lgb.train(
            params_q90, train_data, num_boost_round=500,
            valid_sets=[val_data],
            callbacks=[lgb.early_stopping(50), lgb.log_evaluation(0)],
        )

        # Evaluate on the absolute reconstruction (delta + currentSgv)
        pred_delta = model.predict(X_val)
        pred_abs = cur_val + pred_delta
        actual_abs = cur_val + y_val
        rmse = np.sqrt(np.mean((pred_abs - actual_abs) ** 2))
        mae = np.mean(np.abs(pred_abs - actual_abs))

        # ── Quantile band calibration (conformal-style scale) ──
        # Reconstruct absolute q10/q90 bands on the validation partition, then
        # find a single multiplicative factor on the half-widths around the point
        # so empirical coverage of [low, high] hits TARGET_COVERAGE (0.80).
        q10_abs = cur_val + model_q10.predict(X_val)
        q90_abs = cur_val + model_q90.predict(X_val)
        lo_raw = np.minimum(q10_abs, q90_abs)
        hi_raw = np.maximum(q10_abs, q90_abs)
        lo_raw = np.minimum(lo_raw, pred_abs)
        hi_raw = np.maximum(hi_raw, pred_abs)
        cov_raw = float(np.mean((actual_abs >= lo_raw) & (actual_abs <= hi_raw)))
        band_scale = _calibrate_band_scale(pred_abs, lo_raw, hi_raw, actual_abs)
        lo_s = pred_abs - (pred_abs - lo_raw) * band_scale
        hi_s = pred_abs + (hi_raw - pred_abs) * band_scale
        cov_scaled = float(np.mean((actual_abs >= lo_s) & (actual_abs <= hi_s)))
        print(f" RMSE: {rmse:.1f}, MAE: {mae:.1f}, "
              f"cov {cov_raw:.2f}->{cov_scaled:.2f} (scale {band_scale:.2f})")

        importance = dict(zip(FEATURE_NAMES, model.feature_importance("gain")))
        total = sum(importance.values()) or 1
        importance = {k: round(v / total, 4) for k, v in importance.items()}

        results[horizon] = {
            "model": model,
            "model_q10": model_q10,
            "model_q90": model_q90,
            "rmse": round(float(rmse), 1),
            "mae": round(float(mae), 1),
            "bandScale": round(float(band_scale), 3),
            "coverageRaw": round(cov_raw, 3),
            "coverageScaled": round(cov_scaled, 3),
            "importance": importance,
        }

    return results


# Quantile bands target an 80% interval (q10..q90).
TARGET_COVERAGE = 0.80
BAND_SCALE_MIN, BAND_SCALE_MAX = 0.5, 3.0


def _calibrate_band_scale(point, lo, hi, actual):
    """Find a multiplicative half-width scale so coverage of [lo,hi] ≈ 0.80.

    Scales both half-widths symmetrically around the point. Coverage is monotone
    non-decreasing in the scale, so a bisection on the scale converges. The result
    is clamped to [BAND_SCALE_MIN, BAND_SCALE_MAX].
    """
    lo_half = point - lo
    hi_half = hi - point

    def coverage(scale):
        l = point - lo_half * scale
        h = point + hi_half * scale
        return float(np.mean((actual >= l) & (actual <= h)))

    # If even the max scale can't reach target, return max; if min already exceeds, return min.
    if coverage(BAND_SCALE_MAX) <= TARGET_COVERAGE:
        return BAND_SCALE_MAX
    if coverage(BAND_SCALE_MIN) >= TARGET_COVERAGE:
        return BAND_SCALE_MIN

    lo_s, hi_s = BAND_SCALE_MIN, BAND_SCALE_MAX
    for _ in range(40):
        mid = (lo_s + hi_s) / 2.0
        if coverage(mid) < TARGET_COVERAGE:
            lo_s = mid
        else:
            hi_s = mid
    return max(BAND_SCALE_MIN, min(BAND_SCALE_MAX, hi_s))


# ── ONNX Export ──

def export_onnx(results: dict):
    """Export trained models to ONNX format."""
    try:
        import onnxmltools
        from onnxmltools.convert.lightgbm.convert import convert as convert_lgbm
        from onnxconverter_common.data_types import FloatTensorType
    except ImportError:
        print("\nWARNING: onnxmltools not installed. Saving LightGBM native format instead.")
        print("  Install with: pip install onnxmltools skl2onnx onnxconverter-common")
        for horizon, res in results.items():
            path = OUTPUT_DIR / f"glucose_pred_{horizon}.lgb"
            res["model"].save_model(str(path))
            print(f"  Saved {path}")
        return

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    for horizon, res in results.items():
        initial_type = [("input", FloatTensorType([None, len(FEATURE_NAMES)]))]
        onnx_model = convert_lgbm(res["model"], initial_types=initial_type)
        path = OUTPUT_DIR / f"glucose_pred_{horizon}.onnx"
        onnxmltools.utils.save_model(onnx_model, str(path))
        print(f"  Exported {path} ({path.stat().st_size / 1024:.0f} KB)")

        for suffix, key in [("q10", "model_q10"), ("q90", "model_q90")]:
            onnx_q = convert_lgbm(res[key], initial_types=initial_type)
            qpath = OUTPUT_DIR / f"glucose_pred_{horizon}_{suffix}.onnx"
            onnxmltools.utils.save_model(onnx_q, str(qpath))

    print(f"  All ONNX models exported to {OUTPUT_DIR}")


# ── Metadata ──

def save_metadata(results: dict, training_days: int, dataset_summary: dict):
    """Save model metadata for the UI + serving handshake."""
    key_horizons = [15, 30, 60, 90, 120, 180]
    importance_src = results.get(30) or next(iter(results.values()))
    meta = {
        "trainedAt": datetime.utcnow().isoformat() + "Z",
        "modelVersion": MODEL_VERSION,
        "target": "delta",  # predictions are sgv(t+h) - sgv(t); add currentSgv back at serve
        "featureNames": FEATURE_NAMES,
        "featureCount": len(FEATURE_NAMES),
        "trainingDays": training_days,
        "horizons": sorted(results.keys()),
        "validationRMSE": {str(h): r["rmse"] for h, r in results.items()},
        "validationMAE": {str(h): r["mae"] for h, r in results.items()},
        # Per-horizon conformal band-scale (target coverage 0.80) applied to the
        # q10/q90 half-widths at serve time. Default 1.0 if a horizon is absent.
        "bandScale": {str(h): r["bandScale"] for h, r in results.items()},
        "targetCoverage": TARGET_COVERAGE,
        "validationCoverage": {
            str(h): {"raw": r["coverageRaw"], "scaled": r["coverageScaled"]}
            for h, r in results.items()
        },
        "keyHorizonRMSE": {str(h): results[h]["rmse"] for h in key_horizons if h in results},
        "featureImportance": importance_src["importance"],
        "dataSnapshot": dataset_summary,
    }
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    meta_path = OUTPUT_DIR / "meta.json"
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    print(f"\nMetadata saved to {meta_path}")


# ── Main ──

def main():
    parser = argparse.ArgumentParser(description="Train ClearSugar glucose prediction models")
    parser.add_argument("--days", type=int, default=90, help="Days of history to use (default: 90)")
    parser.add_argument("--url", type=str, default=NIGHTSCOUT_URL, help="Nightscout URL")
    parser.add_argument("--output", type=str, default=None, help="Output directory for ONNX models")
    args = parser.parse_args()

    global OUTPUT_DIR
    if args.output:
        OUTPUT_DIR = Path(args.output)

    print("ClearSugar Model Trainer")
    print(f"  Nightscout: {args.url}")
    print(f"  Training window: {args.days} days")
    print(f"  Model version: {MODEL_VERSION} (target=delta, {len(FEATURE_NAMES)} features)")
    print(f"  Horizons: {HORIZONS} minutes")
    print()

    entries = fetch_entries(args.url, args.days, API_SECRET)
    if entries.empty:
        print("ERROR: No CGM data found. Check Nightscout URL and connectivity.")
        sys.exit(1)

    treatments = fetch_treatments(args.url, args.days, API_SECRET)
    profile = fetch_profile(args.url, API_SECRET)
    print(f"  Profile DIA: {profile['dia']}h")

    dataset, val_cutoff = build_dataset(entries, treatments, profile)
    if len(dataset) < 100:
        print(f"ERROR: Only {len(dataset)} labeled examples. Need at least 100.")
        print("  Try increasing --days or checking Nightscout data quality.")
        sys.exit(1)

    dataset_summary = {
        "rowCount": int(len(dataset)),
        "cgmReadings": int(len(entries)),
        "treatments": int(len(treatments)),
        "dateRangeStart": datetime.utcfromtimestamp(int(entries["date"].min()) / 1000).isoformat() + "Z",
        "dateRangeEnd": datetime.utcfromtimestamp(int(entries["date"].max()) / 1000).isoformat() + "Z",
        "valCutoff": datetime.utcfromtimestamp(val_cutoff / 1000).isoformat() + "Z",
    }

    results = train_models(dataset, val_cutoff)

    export_onnx(results)
    save_metadata(results, args.days, dataset_summary)

    print("\nTraining complete!")
    print(f"  Models: {OUTPUT_DIR}")
    print(f"  To retrain: python scripts/train-model.py --days {args.days}")


if __name__ == "__main__":
    main()
