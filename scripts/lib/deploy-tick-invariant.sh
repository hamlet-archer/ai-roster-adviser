#!/usr/bin/env bash
# deploy-tick-invariant.sh — TEMPLATE for the post-deploy "service must
# be active" invariant that every agent puller (`scripts/pull-deploy.sh`)
# should carry. Copy this chunk into the puller (or `source` it via a
# vendored sibling), wire it at the existing `"$DEPLOY_SCRIPT" || …`
# site, and substitute the per-agent variables documented below.
#
# Anchored against `ai-ops-meta/architect-backlog.md` §R4.
#
# ─── The invariant ──────────────────────────────────────────────────────
# After every puller tick that invoked deploy.sh, the long-running daemon
# unit MUST be `active` if it was `active` going into the tick.
#
# The 2026-05-27 outages (`ai-chief` 58min flock race + `ai-calendar-
# adviser` 27min EACCES) shared a single failure mode: `deploy.sh` runs
# `sudo systemctl stop <service>` early; a later step fails under
# `set -euo pipefail`; the matching `sudo systemctl start <service>`
# line never executes. The service stays dead until either the next
# code-change deploy tick (could be hours / days if nothing lands) or
# a stability-mode SSH probe catches it (≤30 min on the current cron).
#
# The puller is the only piece of the chain that runs every ~2 min
# regardless of deploy success — so it carries the invariant.
#
# ─── Per-agent substitutions ────────────────────────────────────────────
# UNIT             The long-running daemon name (e.g.
#                  `ai-calendar-adviser.service`, `ai-chief.service`,
#                  `ai-comms-adviser-query.service`,
#                  `ai-roster-adviser.service`). Required.
# SYSTEMCTL_BIN    Defaults to `systemctl`. Override only for tests that
#                  stub the binary (matches the existing `probe_daemon`
#                  override in puller smoke tests).
# JOURNAL_LOG_FN   Defaults to `printf '%s\n'` to stderr, which systemd
#                  captures into journald. Override only if the puller
#                  has its own structured logger.
#
# ─── Safety constraints (FROM R4 PARENT, DO NOT DROP) ───────────────────
# (a) Only restart if the pre-deploy state was `active`. If the service
#     was already dead going in, this tick's deploy failure isn't what
#     killed it — restarting masks an unrelated outage and the
#     stability runner's §1c probe (or a fresh DM) should handle it.
# (b) Cap at 1 restart attempt per tick. A restart that itself fails
#     must propagate as `Result=failure` to systemd so stability mode
#     escalates. Looping start-failures here would spin the puller.
#
# ─── Wiring sketch (per-agent puller, inside its 2-min tick) ────────────
#
#     # 1. BEFORE invoking deploy.sh — capture pre-deploy state.
#     pre_deploy_state=$(deploy_tick_invariant__pre_state)
#
#     # 2. Existing deploy invocation, capture exit status.
#     deploy_status=0
#     "$DEPLOY_SCRIPT" || deploy_status=$?
#
#     # 3. AFTER the deploy completes — enforce the invariant.
#     deploy_tick_invariant__post "$deploy_status" "$pre_deploy_state"
#
# The two helpers below are the entire library surface.
# ────────────────────────────────────────────────────────────────────────

# Resolve the per-agent variables exactly once. Subsequent re-source is a
# no-op (defaults already applied). UNIT is required for production
# wiring but deferred to first call so the SMOKE harness at the bottom
# can set it after sourcing.
#
# SYSTEMCTL_BIN defaults to /usr/bin/systemctl (full path so sudo will
# accept it without PATH resolution). Override only for tests that
# stub the binary — the smoke harness below does this.
: "${SYSTEMCTL_BIN:=/usr/bin/systemctl}"

# Override with a structured logger if the puller has one; otherwise
# we emit a single line to stderr, which systemd captures into journald.
if [[ -z "${JOURNAL_LOG_FN:-}" ]]; then
  deploy_tick_invariant__log() { printf '%s\n' "$*" >&2; }
  JOURNAL_LOG_FN=deploy_tick_invariant__log
fi

# Read the unit's current ActiveState. Returns one of:
#   active | inactive | failed | activating | deactivating | unknown
# Used before AND after the deploy. The `pre_deploy_state` value gates
# the recovery: we only restart if the unit was `active` going in.
deploy_tick_invariant__pre_state() {
  : "${UNIT:?deploy-tick-invariant.sh: UNIT must be set to the daemon *.service name}"
  "$SYSTEMCTL_BIN" show -p ActiveState --value "$UNIT" 2>/dev/null || echo "unknown"
}

# Enforce the invariant. Call AFTER the deploy invocation.
#
# Arguments:
#   $1  deploy_status     The exit code captured from `"$DEPLOY_SCRIPT" || …`
#   $2  pre_deploy_state  Output of __pre_state, taken before the deploy
#
# Behaviour:
#   - If deploy succeeded (deploy_status=0): no-op. Deploy's own
#     systemctl start succeeded.
#   - If deploy failed AND pre_deploy_state was not "active": no-op.
#     This isn't our outage to fix; let stability mode escalate.
#   - If deploy failed AND pre_deploy_state was "active" AND unit is
#     currently NOT active: log a structured event, run ONE
#     `reset-failed` + `start` attempt. If the start itself fails,
#     propagate the failure (no retry, no loop).
#   - Returns 0 if the invariant holds (or the recovery succeeded);
#     non-zero if the recovery itself failed.
deploy_tick_invariant__post() {
  local deploy_status="$1"
  local pre_deploy_state="$2"

  if [[ "$deploy_status" -eq 0 ]]; then
    return 0  # deploy succeeded; trust its own start step
  fi

  if [[ "$pre_deploy_state" != "active" ]]; then
    "$JOURNAL_LOG_FN" "deploy_tick_invariant: skip unit=$UNIT pre_state=$pre_deploy_state deploy_status=$deploy_status reason=not_our_outage"
    return 0
  fi

  # Pre-state was active. Did the deploy leave the unit dead?
  local post_state
  post_state=$("$SYSTEMCTL_BIN" show -p ActiveState --value "$UNIT" 2>/dev/null || echo "unknown")

  if [[ "$post_state" == "active" ]]; then
    return 0  # unit recovered itself (or deploy did manage to restart)
  fi

  "$JOURNAL_LOG_FN" "deploy_tick_invariant: restoring unit=$UNIT pre_state=$pre_deploy_state post_state=$post_state deploy_status=$deploy_status"

  # ONE attempt. No loop. If this fails, propagate the failure code so
  # systemd marks this puller tick `Result=failure` and stability mode
  # picks it up.
  if ! sudo "$SYSTEMCTL_BIN" reset-failed "$UNIT" 2>&1; then
    "$JOURNAL_LOG_FN" "deploy_tick_invariant: reset-failed failed unit=$UNIT"
    return 1
  fi

  if ! sudo "$SYSTEMCTL_BIN" start "$UNIT" 2>&1; then
    "$JOURNAL_LOG_FN" "deploy_tick_invariant: start failed unit=$UNIT"
    return 1
  fi

  # Verify it actually came up. systemctl start returns 0 the moment the
  # ExecStartPre lines have queued — a unit that crashes in ExecStart
  # would slip through without this check.
  local final_state
  final_state=$("$SYSTEMCTL_BIN" show -p ActiveState --value "$UNIT" 2>/dev/null || echo "unknown")
  if [[ "$final_state" != "active" ]]; then
    "$JOURNAL_LOG_FN" "deploy_tick_invariant: start returned 0 but ActiveState=$final_state unit=$UNIT"
    return 1
  fi

  "$JOURNAL_LOG_FN" "deploy_tick_invariant: restored unit=$UNIT final_state=active"
  return 0
}

# ─── Local smoke test (optional, off by default) ────────────────────────
# Run as: SMOKE=1 bash deploy-tick-invariant.sh
# Uses a stub `systemctl` to verify the function logic without root or a
# live systemd. Keep this hermetic so future R4.b..R4.e installs can
# adopt the same harness.
if [[ "${SMOKE:-0}" == "1" ]]; then
  set -euo pipefail
  TMPDIR_SMOKE=$(mktemp -d)
  trap 'rm -rf "$TMPDIR_SMOKE"' EXIT

  cat > "$TMPDIR_SMOKE/systemctl" <<'STUB'
#!/usr/bin/env bash
# Stub systemctl. Reads state-file at $SMOKE_STATE_FILE.
state_file="${SMOKE_STATE_FILE:?SMOKE_STATE_FILE not set}"
if [[ "$1 $2" == "show -p" && "$3 $4" == "ActiveState --value" ]]; then
  cat "$state_file"
  exit 0
fi
if [[ "$1" == "reset-failed" || "$1" == "start" ]]; then
  echo "active" > "$state_file"  # simulate successful start
  exit 0
fi
echo "stub-systemctl: unhandled: $*" >&2
exit 0
STUB
  chmod +x "$TMPDIR_SMOKE/systemctl"

  UNIT="smoke.service"
  SYSTEMCTL_BIN="$TMPDIR_SMOKE/systemctl"
  export SMOKE_STATE_FILE="$TMPDIR_SMOKE/state"
  sudo() { "$@"; }  # bypass sudo in smoke
  export -f sudo
  deploy_tick_invariant__log() { echo "[log] $*"; }
  JOURNAL_LOG_FN=deploy_tick_invariant__log

  # Case 1: deploy succeeded → no-op
  echo "active" > "$SMOKE_STATE_FILE"
  pre=$(deploy_tick_invariant__pre_state)
  deploy_tick_invariant__post 0 "$pre"
  [[ "$(cat "$SMOKE_STATE_FILE")" == "active" ]] || { echo "CASE 1 FAIL"; exit 1; }

  # Case 2: deploy failed but unit was inactive going in → no-op
  echo "inactive" > "$SMOKE_STATE_FILE"
  pre=$(deploy_tick_invariant__pre_state)
  deploy_tick_invariant__post 1 "$pre"
  [[ "$(cat "$SMOKE_STATE_FILE")" == "inactive" ]] || { echo "CASE 2 FAIL"; exit 1; }

  # Case 3: deploy failed, unit was active but now dead → restore
  echo "active" > "$SMOKE_STATE_FILE"
  pre=$(deploy_tick_invariant__pre_state)
  echo "failed" > "$SMOKE_STATE_FILE"  # simulate deploy left it dead
  deploy_tick_invariant__post 1 "$pre"
  [[ "$(cat "$SMOKE_STATE_FILE")" == "active" ]] || { echo "CASE 3 FAIL"; exit 1; }

  echo "smoke: all 3 cases PASS"
fi
