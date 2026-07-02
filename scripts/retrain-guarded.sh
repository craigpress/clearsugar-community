#!/usr/bin/env bash
# ClearSugar — Guarded weekly retrain.
# Trains a fresh model, evaluates BOTH the new model and the currently-deployed
# model on the same held-out window, and PROMOTES the new model only if it is at
# least as good on hypo-detection AND overall RMSE. Otherwise keeps the current
# model. Designed to run unattended (scheduled). All steps logged.
#
# Run from the clearsugar project root:
#   DEPLOY_HOST=user@host bash scripts/retrain-guarded.sh
# Required: DEPLOY_HOST (the predict-server host, user@host for ssh/scp).
# Optional: NIGHTSCOUT_URL (default http://localhost:1337), REMOTE_MODEL_DIR,
#           PREDICT_SERVICE, DAYS, EVAL_DAYS, PYTHON.
set -uo pipefail

NIGHTSCOUT_URL="${NIGHTSCOUT_URL:-http://localhost:1337}"
DEPLOY_TARGET="${DEPLOY_HOST:-}"
REMOTE_MODEL_DIR="${REMOTE_MODEL_DIR:-/opt/clearsugar-models}"
PREDICT_SERVICE="${PREDICT_SERVICE:-clearsugar-predict}"
DAYS="${DAYS:-90}"
EVAL_DAYS="${EVAL_DAYS:-7}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-python}"

if [ -z "$DEPLOY_TARGET" ]; then
  echo "Usage: DEPLOY_HOST=user@host bash scripts/retrain-guarded.sh" >&2
  exit 1
fi

WORK="$(mktemp -d)"
NEWDIR="$WORK/new"; CURDIR="$WORK/cur"
mkdir -p "$NEWDIR" "$CURDIR"
LOG_TS="$(date +%Y%m%d-%H%M%S)"
echo "━━ Guarded retrain $LOG_TS ━━  NS=$NIGHTSCOUT_URL  train=${DAYS}d eval=${EVAL_DAYS}d"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# 1. Train new model (trainer holds out the last EVAL_DAYS by default)
echo "[1/5] Training new model..."
$PYTHON "$SCRIPT_DIR/train-model.py" --days "$DAYS" --url "$NIGHTSCOUT_URL" --output "$NEWDIR" || { echo "TRAIN FAILED — abort, keeping current model"; exit 1; }
ls "$NEWDIR"/glucose_pred_30.onnx >/dev/null 2>&1 || { echo "No ONNX produced (check onnxconverter-common) — abort"; exit 1; }

# 2. Pull current deployed model for an apples-to-apples eval
echo "[2/5] Fetching current deployed model..."
scp -q "$DEPLOY_TARGET:$REMOTE_MODEL_DIR/"*.onnx "$DEPLOY_TARGET:$REMOTE_MODEL_DIR/meta.json" "$CURDIR/" 2>/dev/null || echo "  (no current model to compare — will promote if new is sane)"

# 3. Evaluate both on the same held-out window
echo "[3/5] Evaluating new vs current ($EVAL_DAYS d held-out)..."
$PYTHON "$SCRIPT_DIR/evaluate-model.py" --url "$NIGHTSCOUT_URL" --days "$EVAL_DAYS" --model-dir "$NEWDIR" >/dev/null 2>&1 || { echo "NEW eval failed — abort"; exit 1; }
HAVE_CUR=0
if ls "$CURDIR"/glucose_pred_30.onnx >/dev/null 2>&1; then
  $PYTHON "$SCRIPT_DIR/evaluate-model.py" --url "$NIGHTSCOUT_URL" --days "$EVAL_DAYS" --model-dir "$CURDIR" >/dev/null 2>&1 && HAVE_CUR=1
fi

# 4. Decide promotion (Python compares the two eval-report.json files)
echo "[4/5] Promotion decision..."
DECISION=$($PYTHON - "$NEWDIR/eval-report.json" "$CURDIR/eval-report.json" "$HAVE_CUR" <<'PY'
import json, sys
newp, curp, have_cur = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
n = json.load(open(newp))["overall"]
new_rmse = n["rmse"]; new_pers = n["persistence"]["rmse"]; new_sens70 = n["hypo70"]["sensitivity"]
# Gate 1: new must beat the persistence baseline (else the ML adds nothing)
if new_rmse > new_pers:
    print("KEEP|new RMSE %.1f worse than persistence %.1f" % (new_rmse, new_pers)); sys.exit()
if not have_cur:
    print("PROMOTE|no current model to compare; new beats persistence"); sys.exit()
c = json.load(open(curp))["overall"]
cur_rmse = c["rmse"]; cur_sens70 = c["hypo70"]["sensitivity"]
# Gate 2: not worse on hypo-detection AND not materially worse on RMSE (allow 2% slack)
if new_sens70 + 1e-9 >= cur_sens70 and new_rmse <= cur_rmse * 1.02:
    print("PROMOTE|new RMSE %.1f<=%.1f, hypo70 sens %.3f>=%.3f" % (new_rmse, cur_rmse, new_sens70, cur_sens70)); sys.exit()
print("KEEP|new not better: RMSE %.1f vs %.1f, hypo70 %.3f vs %.3f" % (new_rmse, cur_rmse, new_sens70, cur_sens70))
PY
)
VERDICT="${DECISION%%|*}"; REASON="${DECISION#*|}"
echo "  → $VERDICT — $REASON"

# 5. Promote if approved
if [ "$VERDICT" = "PROMOTE" ]; then
  echo "[5/5] Promoting: backup + deploy + restart..."
  ssh "$DEPLOY_TARGET" "cp -r $REMOTE_MODEL_DIR ${REMOTE_MODEL_DIR}.bak.$LOG_TS 2>/dev/null || true"
  scp -q "$NEWDIR"/*.onnx "$NEWDIR/meta.json" "$DEPLOY_TARGET:$REMOTE_MODEL_DIR/"
  ssh "$DEPLOY_TARGET" "systemctl restart $PREDICT_SERVICE && sleep 4 && curl -s http://localhost:9877/health | head -c 200"
  # Keep only the 4 most recent backups
  ssh "$DEPLOY_TARGET" "ls -dt ${REMOTE_MODEL_DIR}.bak.* 2>/dev/null | tail -n +5 | xargs -r rm -rf"
  echo ""
  echo "  ✅ Promoted new model ($LOG_TS)."
else
  echo "[5/5] Keeping current model. New model discarded."
fi
echo "━━ Done $LOG_TS ━━"
