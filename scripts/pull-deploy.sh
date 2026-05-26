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
export GIT_SSH_COMMAND="ssh -i /etc/ai-roster-adviser-deploy/ssh/key -o IdentitiesOnly=yes -o UserKnownHostsFile=/etc/ai-roster-adviser-deploy/ssh/known_hosts -o StrictHostKeyChecking=yes -o HostName=ssh.github.com -p 443"

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

# B8.10.4 — post-daemon-reload systemd-unit drift check. Mirrors the
# B8.10.3 block in ai-calendar-adviser/scripts/pull-deploy.sh: deploy.sh
# lives at /opt/ai-roster-adviser-deploy/deploy.sh on the VPS, not in
# this repo, so the drift check cannot ride inside the daemon-reload
# subshell the way ai-comms-adviser's does. The puller is the closest
# in-repo hook point after deploy.sh's daemon-reload.
#
# Only fires if we got here (deploy.sh succeeded — set -e would have
# killed the script otherwise). For each unit just synced, diff
# `systemctl cat <unit>` (with the `# /etc/systemd/system/<unit>`
# header stripped via tail -n +2) against the in-repo
# deploy/systemd/<unit>. Any drift logs the unit name + unified diff to
# stderr and exits 1 — the puller's systemd unit Result=exit-code
# propagates and the dashboard /health page flips ai-roster-adviser red
# within one heartbeat.
#
# Catches: (a) manual edits to /etc/systemd/system that bypassed
# deploy.sh's unit-file sync, (b) a future regression of that sync,
# (c) drop-in files under /etc/systemd/system/<unit>.d/ that change
# effective unit text.
drift_ok=1
shopt -s nullglob
for unit_path in "$REPO_DIR"/deploy/systemd/*.service "$REPO_DIR"/deploy/systemd/*.timer; do
  unit_name=$(basename "$unit_path")
  diff_tmp=$(mktemp)
  if ! diff -u <(systemctl cat "$unit_name" 2>/dev/null | tail -n +2) "$unit_path" > "$diff_tmp" 2>&1; then
    echo "drift: $unit_name differs between systemctl-cat and $unit_path" >&2
    cat "$diff_tmp" >&2
    drift_ok=
  fi
  rm -f "$diff_tmp"
done
shopt -u nullglob
if [[ -z "${drift_ok:-}" ]]; then
  echo "B8.10.4 drift check FAILED — running systemd unit text differs from in-repo deploy/systemd/" >&2
  exit 1
fi
