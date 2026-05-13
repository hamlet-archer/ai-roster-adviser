#!/usr/bin/env bash
# pull-deploy.sh — poll origin/main; if HEAD changed, invoke the
# server-side /opt/ai-roster-adviser-deploy/deploy.sh which handles the
# heavy lifting (git reset, npm ci, build, systemd unit refresh, service
# restart). Run by systemd timer ai-roster-adviser-pull-deploy.timer
# every ~2 min on golden-ai-ops.
#
# Mirrors ai-calendar-adviser + ai-web-fetcher + ai-comms-adviser polling
# pattern: cloud-egress webhook POSTs are unreliable from inside the
# runner sandbox, so polling closes the loop deterministically.
#
# Stable runtime path: /opt/ai-roster-adviser-deploy/pull-deploy.sh
# (lives outside /opt/ai-roster-adviser so git resets inside the repo
# cannot wipe it). Source of truth is the copy in this repo at
# scripts/pull-deploy.sh; deploy.sh self-installs the stable copy on
# each successful run.

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/ai-roster-adviser}"
BRANCH="${BRANCH:-main}"
DEPLOY_SCRIPT="${DEPLOY_SCRIPT:-/opt/ai-roster-adviser-deploy/deploy.sh}"
STABLE_PATH="${STABLE_PATH:-/opt/ai-roster-adviser-deploy/pull-deploy.sh}"

# systemd ProtectHome=read-only hides ~/.ssh — match the deploy.sh
# pattern and point at the staged key + known_hosts under /etc.
export GIT_SSH_COMMAND="ssh -i /etc/ai-roster-adviser-deploy/ssh/key -o IdentitiesOnly=yes -o UserKnownHostsFile=/etc/ai-roster-adviser-deploy/ssh/known_hosts -o StrictHostKeyChecking=yes"

cd "$REPO_DIR"

git fetch --quiet origin "$BRANCH"
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [[ "$LOCAL" == "$REMOTE" ]]; then
  exit 0
fi

echo "HEAD differs (${LOCAL:0:7} → ${REMOTE:0:7}); delegating to ${DEPLOY_SCRIPT}"

# deploy.sh reads ${REMOTE} via its own git fetch + reset; we just hand off.
"$DEPLOY_SCRIPT"

# Self-update the stable copy after the deploy succeeds, so the next
# timer tick uses whatever version of this script we just pulled.
# `install` writes-then-renames atomically — safe to overwrite the file
# currently executing.
if [[ -f "$REPO_DIR/scripts/pull-deploy.sh" ]] && [[ "$(realpath "$0")" == "$STABLE_PATH" ]]; then
  install -m 755 "$REPO_DIR/scripts/pull-deploy.sh" "$STABLE_PATH"
fi
