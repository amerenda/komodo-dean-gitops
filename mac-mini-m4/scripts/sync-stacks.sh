#!/bin/bash
# Keeps GitOps checkouts fresh on the Mac Mini host (no manual git pull / inject).
#
# 1) Komodo stack clones under ~/komodo/stacks/* (PERIPHERY_ROOT_DIRECTORY).
#    ALL git repos under stacks/ are pulled to origin/main automatically — no
#    hardcoded list. Adding a new Komodo stack never requires touching this script.
# 2) The host working copy KOMODO_HOST_REPO (default ~/komodo-dean-gitops): fast-
#    forward to match origin. After any FF update, re-runs inject-secrets via
#    `sudo launchctl kickstart` so new inject-secrets.sh + BWS values apply
#    without SSH. Requires NOPASSWD for that launchctl line (see setup-macmini).
#
# Runs via LaunchAgent every 60 seconds.
set -euo pipefail

# Host repo (launchd plists and inject-secrets.sh live here)
HOST_REPO="${KOMODO_HOST_REPO:-$HOME/komodo-dean-gitops}"
# Komodo Periphery stack checkouts (same remote as HOST_REPO, usually main)
KOMODO_PERIPHERY_ROOT="${KOMODO_PERIPHERY_ROOT:-$HOME/komodo}"
STACKS_ROOT="$KOMODO_PERIPHERY_ROOT/stacks"
STACK_SERVICES="$STACKS_ROOT/services"
DOCKER="$HOME/.orbstack/bin/docker"
LOG="/tmp/komodo-stack-sync.log"

# Rotate log if over 100KB
[ -f "$LOG" ] && [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt 102400 ] && : > "$LOG"

CHANGED=""
DIRS_BEFORE=""
SYNCED=false

sync_host_gitops() {
    [ -d "${HOST_REPO}/.git" ] || return 0
    cd "$HOST_REPO" || return 0

    git fetch --quiet origin 2>/dev/null || return 0

    local local_h remote_ref
    local_h=$(git rev-parse HEAD)
    if git rev-parse @{u} >/dev/null 2>&1; then
        remote_ref=$(git rev-parse @{u})
    else
        git rev-parse origin/main >/dev/null 2>&1 || return 0
        remote_ref=$(git rev-parse origin/main)
    fi

    [ "$local_h" = "$remote_ref" ] && return 0

    if ! git merge-base --is-ancestor HEAD "$remote_ref" 2>/dev/null; then
        echo "$(date): host repo not fast-forwardable to ${remote_ref}, skipping (fix branch or merge)" >> "$LOG"
        return 0
    fi

    local c
    c=$(git diff --name-only "$local_h" "$remote_ref" 2>/dev/null || true)
    git reset --hard "$remote_ref" --quiet
    echo "$(date): synced host repo ${HOST_REPO} ${local_h} -> ${remote_ref}" >> "$LOG"
    CHANGED="${CHANGED}"$'\n'"$c"
    SYNCED=true

    if sudo -n /bin/launchctl kickstart -k system/com.local.inject-secrets >>"$LOG" 2>&1; then
        echo "$(date): kicked inject-secrets after host gitops sync" >> "$LOG"
    else
        echo "$(date): WARN: sudo launchctl kickstart inject-secrets failed (install NOPASSWD via setup-macmini, or run inject-secrets once)" >> "$LOG"
    fi
}

sync_one() {
    local dir="$1"
    [ -d "$dir/.git" ] || return 0
    cd "$dir" || return 0

    git fetch --quiet origin main 2>/dev/null || return 0
    local local_h remote_h
    local_h=$(git rev-parse HEAD)
    remote_h=$(git rev-parse origin/main)
    [ "$local_h" = "$remote_h" ] && return 0

    local c
    c=$(git diff --name-only "$local_h" "$remote_h" 2>/dev/null || true)
    git reset --hard origin/main --quiet
    echo "$(date): synced $(basename "$dir") $local_h -> $remote_h" >> "$LOG"
    CHANGED="$CHANGED"$'\n'"$c"
    SYNCED=true
}

sync_host_gitops

# Snapshot services dir structure before sync (used to detect periphery config additions)
if [ -d "$STACK_SERVICES/.git" ]; then
    cd "$STACK_SERVICES"
    DIRS_BEFORE=$(find . -type d | sort | /sbin/md5 -q)
fi

# Sync ALL Komodo-managed stack git checkouts — new stacks are picked up automatically
for stack_dir in "$STACKS_ROOT"/*/; do
    [ -d "$stack_dir/.git" ] || continue
    sync_one "$stack_dir"
done

if [ "$SYNCED" != true ]; then
    exit 0
fi

if [ -d "$STACK_SERVICES/.git" ]; then
    cd "$STACK_SERVICES"
    DIRS_AFTER=$(find . -type d | sort | /sbin/md5 -q)
    if [ -n "$DIRS_BEFORE" ] && [ "$DIRS_BEFORE" != "$DIRS_AFTER" ]; then
        echo "$(date): directory structure changed, restarting periphery" >> "$LOG"
        "$DOCKER" restart komodo-periphery-1 2>/dev/null || true
    fi
fi

# Paths are repo-root-relative (e.g. mac-mini-m4/homeassistant/...) after the
# komodo-dean-gitops layout move; older ^homeassistant/ patterns never matched.
if echo "$CHANGED" | grep -qE '^mac-mini-m4/monitoring/compose\.yaml'; then
    # compose.yaml changed — command-line flags don't take effect on reload; need full compose up.
    echo "$(date): monitoring compose.yaml changed — running compose up" >> "$LOG"
    "$DOCKER" compose -f "$HOST_REPO/mac-mini-m4/monitoring/compose.yaml" up -d --remove-orphans >> "$LOG" 2>&1 || true
elif echo "$CHANGED" | grep -qE '^mac-mini-m4/monitoring/'; then
    echo "$(date): monitoring config/rules changed — reloading prometheus, restarting grafana" >> "$LOG"
    # Prometheus supports live config reload via HTTP (--web.enable-lifecycle); no restart needed.
    curl -sf -X POST http://localhost:9090/-/reload >> "$LOG" 2>&1 \
        || "$DOCKER" restart prometheus >> "$LOG" 2>&1 || true
    # Grafana auto-detects dashboard JSON changes via provisioning but needs a restart
    # to pick up datasource or env changes.
    "$DOCKER" restart grafana >> "$LOG" 2>&1 || true
fi

if echo "$CHANGED" | grep -qE '^mac-mini-m4/homeassistant/'; then
    echo "$(date): homeassistant config changed, restarting homeassistant" >> "$LOG"
    "$DOCKER" restart homeassistant 2>/dev/null || true
fi

if echo "$CHANGED" | grep -qE '^mac-mini-m4/zigbee2mqtt/'; then
    echo "$(date): zigbee2mqtt files changed, restarting zigbee2mqtt" >> "$LOG"
    "$DOCKER" restart zigbee2mqtt 2>/dev/null || true
fi

if echo "$CHANGED" | grep -qE '^mac-mini-m4/komodo/'; then
    echo "$(date): komodo stack files changed, redeploying" >> "$LOG"
    # Always use compose down+up (not restart/rm) so network endpoints are
    # cleaned up properly. docker rm -f without compose down leaves stale
    # libnetwork endpoints that block future deploys.
    "$DOCKER" compose -f "$HOST_REPO/mac-mini-m4/komodo/compose.yaml" down --remove-orphans >> "$LOG" 2>&1 || true
    "$DOCKER" compose -f "$HOST_REPO/mac-mini-m4/komodo/compose.yaml" up -d >> "$LOG" 2>&1 || true
fi

if echo "$CHANGED" | grep -qE '^mac-mini-m4/core/'; then
    echo "$(date): core stack files changed, redeploying" >> "$LOG"
    "$DOCKER" compose -f "$HOST_REPO/mac-mini-m4/core/compose.yaml" up -d --remove-orphans >> "$LOG" 2>&1 || true
fi

if echo "$CHANGED" | grep -qE '^mac-mini-m4/runners/'; then
    echo "$(date): runners stack files changed, redeploying" >> "$LOG"
    "$DOCKER" compose -p runners -f "$HOST_REPO/mac-mini-m4/runners/compose.yaml" up -d --remove-orphans >> "$LOG" 2>&1 || true
fi

if echo "$CHANGED" | grep -qE '^mac-mini-m4/openwebui/'; then
    echo "$(date): openwebui stack files changed, redeploying" >> "$LOG"
    # openwebui compose uses env_file (.env written by inject-secrets) so we run
    # compose from the Komodo stacks checkout (already pulled by the sync loop above).
    OWUI_STACKS_DIR="$STACKS_ROOT/openwebui"
    "$DOCKER" compose -f "$OWUI_STACKS_DIR/mac-mini-m4/openwebui/compose.yaml" up -d --remove-orphans >> "$LOG" 2>&1 || true
fi
