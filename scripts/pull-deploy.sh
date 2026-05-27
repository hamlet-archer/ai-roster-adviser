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

# R4.e — source the deploy-tick invariant helpers (template vendored from
# ai-ops-meta/deploy/templates/deploy-tick-invariant.sh per architect-
# backlog §R4). Helpers carry the "daemon-must-be-active after every
# deploy tick" invariant; wired below at the existing $DEPLOY_SCRIPT
# invocation site. UNIT is the long-running daemon — for roster-adviser
# this is the W&L sheet sync RPC service.
#
# Sourced by absolute path under $REPO_DIR rather than `dirname $0`
# because the puller runs from STABLE_PATH (outside the repo) — sibling
# lib/ would not be reachable from there. After deploy.sh's git reset
# the lib lives at $REPO_DIR/scripts/lib/. On a fresh repo where the
# lib hasn't landed yet (or in test fixtures that don't stage it), fall
# back to no-op stubs so the puller still runs.
UNIT="ai-roster-adviser.service"
INVARIANT_LIB="${REPO_DIR}/scripts/lib/deploy-tick-invariant.sh"
if [[ -f "$INVARIANT_LIB" ]]; then
  # shellcheck source=scripts/lib/deploy-tick-invariant.sh
  source "$INVARIANT_LIB"
else
  deploy_tick_invariant__pre_state() { echo "unknown"; }
  deploy_tick_invariant__post() { return 0; }
fi

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

# R4.e — capture pre-deploy state BEFORE the deploy fires so the invariant
# helper can tell "deploy killed an active unit" from "unit was already
# dead going in" (the latter is somebody else's outage).
pre_deploy_state=$(deploy_tick_invariant__pre_state)

# deploy.sh reads ${REMOTE} via its own git fetch + reset; we just hand off.
# Use `||` to capture deploy failures so the post-deploy invariant still
# runs and we exit with the underlying status. Without this, `set -e`
# would silently swallow the post-deploy recovery path.
deploy_status=0
"$DEPLOY_SCRIPT" || deploy_status=$?

# R4.e — enforce the post-deploy invariant. If deploy.sh exited non-zero
# AND the daemon was active going in AND the daemon is now dead, do one
# `systemctl reset-failed` + `start` attempt. Any failure here is
# captured in deploy_status so the puller tick propagates Result=failure
# to systemd for stability-mode to escalate.
deploy_tick_invariant__post "$deploy_status" "$pre_deploy_state" || deploy_status=$?

# If the deploy itself failed, skip the post-deploy housekeeping below
# (stable-copy self-install + drift check) — both assume a successful
# deploy and would compound the failure. Propagate the deploy exit
# status so systemd records Result=failure.
if [[ "$deploy_status" -ne 0 ]]; then
  exit "$deploy_status"
fi

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
# Only fires if deploy.sh succeeded (guarded above with an early exit on
# non-zero deploy_status). For each unit just synced, diff
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
