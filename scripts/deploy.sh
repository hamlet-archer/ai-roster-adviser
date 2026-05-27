#!/bin/bash
# ai-roster-adviser deploy from GitHub. Pulls origin/main, npm ci, builds,
# restarts services. Locked + logged.
# Lives at /opt/ai-roster-adviser-deploy/deploy.sh (intentionally OUTSIDE
# /opt/ai-roster-adviser so a git clean inside the repo cannot wipe it).
# Source of truth: this file in the repo (scripts/deploy.sh). The puller
# (scripts/pull-deploy.sh) self-installs this copy to the stable path on
# each successful run.
#
# Mirrors ai-calendar-adviser/scripts/deploy.sh shape; uses the
# ai-chief-deploy lock-path pattern (LOCK in /opt, NOT /tmp) because the
# ai-roster-adviser-pull-deploy.service sets PrivateTmp=true and a flock
# on /tmp/<name> from inside a PrivateTmp unit acquires a namespaced file
# that provides no mutual exclusion (see ai-chief PR #155 + ai-ops-meta
# backlog R2 for the underlying anti-pattern).
set -euo pipefail
exec >> /var/log/ai-roster-adviser-deploy.log 2>&1
# LOCK lives in /opt/ai-roster-adviser-deploy (writable per ReadWritePaths
# inheritance / non-/usr-/etc-/boot path under ProtectSystem=full) so
# concurrent invocations actually serialize on the same inode.
LOCK=/opt/ai-roster-adviser-deploy/deploy.lock

# Public-repo clone via HTTPS — no SSH key needed for fetches.
# (Comms-adviser uses an SSH deploy key because its mirror branch had
# been pushed via SSH historically; ai-roster-adviser is HTTPS-only, same
# as calendar-adviser.)
# ProtectHome hides /home/ubuntu/.npm; redirect to the deploy-owned dir.
export NPM_CONFIG_CACHE=/opt/ai-roster-adviser-deploy/npm-cache
export NPM_CONFIG_LOGS_DIR=/opt/ai-roster-adviser-deploy/npm-logs
export NPM_CONFIG_PREFIX=/opt/ai-roster-adviser-deploy/npm-prefix
export HOME=/opt/ai-roster-adviser-deploy
mkdir -p "$NPM_CONFIG_CACHE" "$NPM_CONFIG_LOGS_DIR" "$NPM_CONFIG_PREFIX"

RPC_SERVICE=ai-roster-adviser.service
TIMERS=(
  ai-roster-adviser-sync.timer
  ai-roster-adviser-pull-deploy.timer
)

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) deploy start ==="
flock -n "$LOCK" bash -c '
  set -euo pipefail
  cd /opt/ai-roster-adviser
  git fetch origin main
  git checkout -B main origin/main
  git reset --hard origin/main
  # Preserve .env (always); node_modules/dist rebuilt below.
  git clean -fd -e .env -e node_modules/ -e dist/

  echo "stopping services for build window"
  sudo /usr/bin/systemctl stop '"$RPC_SERVICE"' '"${TIMERS[*]}"' || true

  NODE_OPTIONS="--max-old-space-size=1700" npm ci
  NODE_OPTIONS="--max-old-space-size=1700" npm run build
  npm prune --omit=dev

  # Stage updated systemd unit files (in case any changed).
  sudo cp deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/
  sudo /usr/bin/systemctl daemon-reload

  echo "starting services"
  sudo /usr/bin/systemctl start '"$RPC_SERVICE"' '"${TIMERS[*]}"'
  sleep 3
  sudo /usr/bin/systemctl is-active '"$RPC_SERVICE"' >/dev/null
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) deploy ok at $(git rev-parse --short HEAD) ==="
' || { echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) deploy FAILED ==="; exit 1; }
