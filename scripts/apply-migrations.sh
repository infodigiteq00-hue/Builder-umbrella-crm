#!/usr/bin/env bash
# Applies migrations/NNNN-*.sql in order, starting at number FROM, and stops at the first error.
#   scripts/apply-migrations.sh 40 --remote --dry     show what would run
#   scripts/apply-migrations.sh 40 --remote           run them on the live database
# Run it from the crm/ folder. Take a backup first (Settings → Backup & restore → Download full backup).
set -euo pipefail
FROM="${1:?usage: apply-migrations.sh <first migration number> [--remote] [--dry]}"; shift || true
TARGET="--local"; DRY=0
for a in "$@"; do case "$a" in --remote) TARGET="--remote";; --dry) DRY=1;; esac; done
for f in migrations/*.sql; do
  base="$(basename "$f")"; n=$((10#${base:0:4}))
  [ "$n" -ge "$FROM" ] || continue
  if [ "$DRY" = 1 ]; then echo "would apply $base"; continue; fi
  echo "applying $base ($TARGET)…"
  npx wrangler d1 execute crm $TARGET --file="$f"
done
echo "done."
