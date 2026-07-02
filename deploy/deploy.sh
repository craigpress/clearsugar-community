#!/usr/bin/env bash
# ClearSugar — Build and deploy the standalone Next.js build to your server.
# Run from the clearsugar/ directory on the dev machine.
#
# Usage: DEPLOY_HOST=user@host [DEPLOY_APP_DIR=/opt/clearsugar/app] ./deploy/deploy.sh
#    or: ./deploy/deploy.sh user@host [/opt/clearsugar/app]
set -euo pipefail

TARGET="${DEPLOY_HOST:-${1:-}}"
APP_DIR="${DEPLOY_APP_DIR:-${2:-/opt/clearsugar/app}}"

if [ -z "$TARGET" ]; then
  echo "Usage: DEPLOY_HOST=user@host $0   (or: $0 user@host [/opt/clearsugar/app])" >&2
  exit 1
fi

echo "==> Building Next.js standalone..."
npm run build

echo "==> Syncing standalone build to $TARGET:$APP_DIR..."
# --delete prunes stale files, but NEVER the runtime env (loaded via systemd
# EnvironmentFile=$APP_DIR/.env) — excluding it keeps the server config.
rsync -avz --delete --exclude='.env' --exclude='.env.local' .next/standalone/ "$TARGET:$APP_DIR/"
rsync -avz .next/static/ "$TARGET:$APP_DIR/.next/static/"
rsync -avz public/ "$TARGET:$APP_DIR/public/"

echo "==> Restarting ClearSugar service..."
ssh "$TARGET" "systemctl restart clearsugar"

echo "==> Done. Checking status..."
ssh "$TARGET" "systemctl status clearsugar --no-pager -l"
