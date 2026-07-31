#!/usr/bin/env bash
# Renders mac-mini-m4/automation/.env for Komodo deploy (Compose loads it for
# variable interpolation, e.g. JELLYFIN_API_KEY in compose.yaml's
# homeassistant service). Invoked by Komodo Periphery from the gitops repo
# root, so paths below are relative to that root.
set -euo pipefail

: "${BWS_ACCESS_TOKEN:?BWS_ACCESS_TOKEN required (cat /run/secrets/bws-access-token)}"

JELLYFIN_API_KEY=$(bws secret get "53080732-f813-46d7-b53d-b49801601e5d" \
    --access-token "$BWS_ACCESS_TOKEN" | jq -r .value | tr -d '[:space:]')
[[ -n "$JELLYFIN_API_KEY" && "$JELLYFIN_API_KEY" != "null" ]] \
  || { echo "automation pre-deploy: failed to fetch jellyfin-api-key" >&2; exit 1; }

ENV_FILE=mac-mini-m4/automation/.env

umask 077
printf 'JELLYFIN_API_KEY=%s\n' "$JELLYFIN_API_KEY" > "$ENV_FILE"

echo "automation pre-deploy: .env written"
