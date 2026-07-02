#!/usr/bin/env python3
"""
ClearSugar — ONNX prediction microservice.
Loads all 36 LightGBM models and serves multi-point predictions.

Runs alongside tconnect-webhook on a different port (9877).
"""

import http.server
import json
import math
import os
import sys
import time
import hashlib
import numpy as np

PORT = int(os.environ.get("PREDICT_PORT", "9877"))
MODEL_DIR = os.environ.get("MODEL_DIR", "/opt/clearsugar-models")
CACHE_TTL = int(os.environ.get("CACHE_TTL", "180"))  # seconds (3 min default)
PREDICT_TOKEN = os.environ.get("PREDICT_TOKEN", "")

# Physiologic sanity bounds for incoming features (reject, do NOT clamp-and-serve).
SGV_MIN, SGV_MAX = 20.0, 600.0          # currentSgv / min1h / max1h / mean*
ROC_ABS_MAX = 30.0                      # mg/dL per minute (well beyond CGM limits)

# Load all ONNX models at startup
print("Loading ONNX models...", flush=True)

try:
    import onnxruntime as ort
except ImportError:
    print("ERROR: onnxruntime not installed. Run: pip install onnxruntime", flush=True)
    sys.exit(1)

sessions = {}
for h in range(5, 185, 5):
    point_path = os.path.join(MODEL_DIR, f"glucose_pred_{h}.onnx")
    q10_path = os.path.join(MODEL_DIR, f"glucose_pred_{h}_q10.onnx")
    q90_path = os.path.join(MODEL_DIR, f"glucose_pred_{h}_q90.onnx")
    if os.path.exists(point_path):
        sessions[h] = {
            "point": ort.InferenceSession(point_path, providers=["CPUExecutionProvider"]),
            "q10": ort.InferenceSession(q10_path, providers=["CPUExecutionProvider"]),
            "q90": ort.InferenceSession(q90_path, providers=["CPUExecutionProvider"]),
        }

print(f"Loaded {len(sessions)} horizon models", flush=True)

# Load metadata
meta_path = os.path.join(MODEL_DIR, "meta.json")
meta = {}
if os.path.exists(meta_path):
    with open(meta_path) as f:
        meta = json.load(f)

# Expected input width + target semantics from metadata (fallbacks for old models).
FEATURE_COUNT = int(meta.get("featureCount", 20))
TARGET = meta.get("target", "absolute")  # "delta" => add currentSgv back to predictions
print(f"Feature count: {FEATURE_COUNT}, target: {TARGET}", flush=True)


def _feature_index(name, default):
    names = meta.get("featureNames")
    if isinstance(names, list) and name in names:
        return names.index(name)
    return default


CURRENT_SGV_IDX = _feature_index("currentSgv", 0)

# Per-horizon multiplicative band-scale factors (conformal calibration from the
# trainer's validation partition). Keys are horizon-minute strings. Default 1.0
# when absent so old models keep their raw bands.
BAND_SCALE = meta.get("bandScale", {}) if isinstance(meta.get("bandScale"), dict) else {}


def _band_scale(horizon):
    """Look up the calibrated band-scale factor for a horizon (default 1.0)."""
    try:
        return float(BAND_SCALE.get(str(int(horizon)), 1.0))
    except (TypeError, ValueError):
        return 1.0


def _smooth_points(points):
    """Light centered moving-average (window 3) over the ABSOLUTE point series.

    Smooths jagged cross-horizon trajectories without erasing genuine turns.
    Confidence half-widths (point-low, high-point) are preserved per point and
    recentered on the smoothed point; bands are re-clamped so low <= point <= high.
    The first point is kept exactly equal to the raw prediction (anchored to reality).
    Only applies when there are >= 3 points; otherwise returns points unchanged.
    """
    n = len(points)
    if n < 3:
        return points

    raw = [p["predicted"] for p in points]
    smoothed = list(raw)
    # Centered window-3 average for interior points; endpoints handled separately.
    for i in range(1, n - 1):
        smoothed[i] = (raw[i - 1] + raw[i] + raw[i + 1]) / 3.0
    # First point anchored to reality (raw). Last point: 2-point trailing average.
    smoothed[0] = raw[0]
    smoothed[n - 1] = (raw[n - 2] + raw[n - 1]) / 2.0

    out = []
    for i, p in enumerate(points):
        lo_half = p["predicted"] - p["low"]    # >= 0
        hi_half = p["high"] - p["predicted"]   # >= 0
        new_pt = smoothed[i]
        new_lo = new_pt - lo_half
        new_hi = new_pt + hi_half
        pt_c = max(39, min(401, new_pt))
        lo_c = max(39, min(401, new_lo))
        hi_c = max(39, min(401, new_hi))
        lo_c = min(lo_c, pt_c)
        hi_c = max(hi_c, pt_c)
        out.append({
            "offset": p["offset"],
            "predicted": round(pt_c),
            "low": round(lo_c),
            "high": round(hi_c),
        })
    return out


def _validate_features(features):
    """Return None if valid, else an error string. Reject non-finite / out-of-range."""
    if not isinstance(features, list):
        return "features must be a list"
    if len(features) != FEATURE_COUNT:
        return f"need {FEATURE_COUNT} features, got {len(features)}"
    for i, v in enumerate(features):
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            return f"feature[{i}] is not numeric"
        if not math.isfinite(v):
            return f"feature[{i}] is not finite (NaN/inf)"
    cur = features[CURRENT_SGV_IDX]
    if not (SGV_MIN <= cur <= SGV_MAX):
        return f"currentSgv {cur} out of physiologic range [{SGV_MIN}, {SGV_MAX}]"
    return None

# Prediction cache: {cache_key: (timestamp, response_json)}
_cache = {}


def _cache_key(features, horizon):
    """Hash features + horizon for cache lookup."""
    raw = json.dumps({"f": features, "h": horizon}, sort_keys=True)
    return hashlib.md5(raw.encode()).hexdigest()


class PredictHandler(http.server.BaseHTTPRequestHandler):
    def _check_auth(self):
        """Return True if authorized (or no token configured)."""
        if not PREDICT_TOKEN:
            return True
        auth = self.headers.get("Authorization", "")
        return auth == f"Bearer {PREDICT_TOKEN}"

    def do_POST(self):
        if self.path != "/predict":
            self.send_error(404)
            return

        if not self._check_auth():
            self.send_error(401, "Invalid token")
            return

        # Parse body defensively — a malformed body must be a clean 400, not a crash.
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(content_length)
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise ValueError("body must be a JSON object")
        except (ValueError, json.JSONDecodeError):
            self.send_error(400, "Malformed JSON body")
            return

        features = body.get("features")
        horizon = body.get("horizon", 60)

        # Validate feature count, finiteness, and physiologic range. Reject garbage.
        err = _validate_features(features)
        if err:
            self.send_error(400, err)
            return

        # Check cache
        key = _cache_key(features, horizon)
        now = time.time()
        if key in _cache:
            cached_time, cached_response = _cache[key]
            if now - cached_time < CACHE_TTL:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("X-Cache", "HIT")
                self.end_headers()
                self.wfile.write(cached_response.encode())
                return

        # Cache miss — run inference
        input_data = np.array([features], dtype=np.float32)
        current_sgv = float(features[CURRENT_SGV_IDX])
        # For delta-target models, predictions are Δglucose; add currentSgv back.
        base = current_sgv if TARGET == "delta" else 0.0
        points = []

        for h in range(5, horizon + 1, 5):
            if h not in sessions:
                continue
            s = sessions[h]
            # Reconstruct absolute point + raw bands (delta target => add currentSgv).
            p = base + float(s["point"].run(None, {"input": input_data})[0].flat[0])
            lo = base + float(s["q10"].run(None, {"input": input_data})[0].flat[0])
            hi = base + float(s["q90"].run(None, {"input": input_data})[0].flat[0])
            # Enforce monotonicity — prevent quantile crossing
            lo, hi = min(lo, hi), max(lo, hi)
            lo = min(lo, p)
            hi = max(hi, p)
            # Apply per-horizon conformal band-scale to the half-widths around p.
            scale = _band_scale(h)
            lo = p - (p - lo) * scale
            hi = p + (hi - p) * scale
            # Clamp to physiologic display range AFTER scaling.
            points.append({
                "offset": h,
                "predicted": round(max(39, min(401, p))),
                "low": round(max(39, min(401, lo))),
                "high": round(max(39, min(401, hi))),
            })

        # Cross-horizon trajectory smoothing (item 1): light window-3 average over
        # the absolute point series, recentering each point's preserved band.
        points = _smooth_points(points)

        response = json.dumps({"points": points, "model": "lightgbm-onnx", "horizon": horizon})

        # Store in cache
        _cache[key] = (now, response)
        # Evict old entries
        for k in list(_cache):
            if now - _cache[k][0] > CACHE_TTL * 2:
                del _cache[k]

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("X-Cache", "MISS")
        self.end_headers()
        self.wfile.write(response.encode())

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "ok",
                "models": len(sessions),
                "featureCount": FEATURE_COUNT,
                "target": TARGET,
                "modelVersion": meta.get("modelVersion"),
                "meta": meta,
                "cache_ttl": CACHE_TTL,
                "cache_entries": len(_cache),
            }).encode())
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.end_headers()

    def log_message(self, f, *a):
        print(f"[predict] {a[0]}", flush=True)


if __name__ == "__main__":
    server = http.server.HTTPServer(("0.0.0.0", PORT), PredictHandler)
    print(f"Predict server :{PORT} ({len(sessions)} models, cache={CACHE_TTL}s)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
