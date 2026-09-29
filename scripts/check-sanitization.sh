#!/bin/sh
# Install with: cp scripts/check-sanitization.sh .git/hooks/pre-commit
# Personal identity terms belong only in .git/sanitization-denylist.
set -eu
if command -v python3 >/dev/null 2>&1; then
  exec python3 scripts/check-sanitization.py --staged
fi
exec python scripts/check-sanitization.py --staged
