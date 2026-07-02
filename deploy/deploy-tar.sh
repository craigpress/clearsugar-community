#!/usr/bin/env bash
# ClearSugar — build and deploy to your server via tar-over-ssh.
# Use when rsync isn't available. Mirrors deploy.sh: ships standalone + static +
# public, preserves the runtime .env (loaded via systemd EnvironmentFile), then
# restarts the service.
#
# Usage: DEPLOY_HOST=user@host [DEPLOY_APP_DIR=/opt/clearsugar/app] ./deploy/deploy-tar.sh
#    or: ./deploy/deploy-tar.sh user@host [/opt/clearsugar/app]
#
# --owner=0 --group=0 (create) + --no-same-owner (extract) keep tar from trying
# to map/restore the source environment's uid/gid, which otherwise emits non-fatal
# "Cannot change ownership" warnings and a nonzero exit that pipefail treats as
# fatal — aborting the deploy after the standalone step.
set -euo pipefail

TARGET="${DEPLOY_HOST:-${1:-}}"
APP_DIR="${DEPLOY_APP_DIR:-${2:-/opt/clearsugar/app}}"

if [ -z "$TARGET" ]; then
  echo "Usage: DEPLOY_HOST=user@host $0   (or: $0 user@host [/opt/clearsugar/app])" >&2
  exit 1
fi

echo "==> Building Next.js standalone..."
npm run build

echo "==> Shipping standalone (preserving .env)..."
tar -C .next/standalone --owner=0 --group=0 --exclude='./.env' --exclude='./.env.local' -czf - . \
  | ssh "$TARGET" "tar -C $APP_DIR --no-same-owner -xzf -"

echo "==> Shipping static..."
ssh "$TARGET" "mkdir -p $APP_DIR/.next/static"
tar -C .next/static --owner=0 --group=0 -czf - . | ssh "$TARGET" "tar -C $APP_DIR/.next/static --no-same-owner -xzf -"

echo "==> Shipping public..."
ssh "$TARGET" "mkdir -p $APP_DIR/public"
tar -C public --owner=0 --group=0 -czf - . | ssh "$TARGET" "tar -C $APP_DIR/public --no-same-owner -xzf -"

echo "==> Restarting ClearSugar service..."
ssh "$TARGET" "systemctl restart clearsugar"
sleep 2
ssh "$TARGET" "systemctl is-active clearsugar && systemctl status clearsugar --no-pager -l | head -12"
echo "==> Done."
