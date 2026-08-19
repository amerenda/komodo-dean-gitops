#!/usr/bin/env bash
# Writes murderbot/gpu-switcher/.env from BWS for Komodo deploy.
# Invoked by Komodo Periphery: BWS_ACCESS_TOKEN is exported before this script runs.
set -euo pipefail

: "${BWS_ACCESS_TOKEN:?BWS_ACCESS_TOKEN required}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

KOMODO_API_KEY=$(bws secret get "aff38ee5-4d3d-4642-871c-b4170186c22b" \
    --access-token "$BWS_ACCESS_TOKEN" | jq -r .value | tr -d '[:space:]')
KOMODO_API_SECRET=$(bws secret get "7ff6b6e9-4fcf-4deb-8527-b4170186efb6" \
    --access-token "$BWS_ACCESS_TOKEN" | jq -r .value | tr -d '[:space:]')
SWITCHER_TOKEN=$(bws secret get "0f9116e3-ff97-4c81-8a9b-b4ab0158a812" \
    --access-token "$BWS_ACCESS_TOKEN" | jq -r .value | tr -d '[:space:]')

for name in KOMODO_API_KEY KOMODO_API_SECRET SWITCHER_TOKEN; do
  val="${!name}"
  [[ -n "$val" && "$val" != "null" ]] \
    || { echo "pre-deploy: failed to fetch $name" >&2; exit 1; }
done

umask 077
printf 'KOMODO_API_KEY=%s\nKOMODO_API_SECRET=%s\nSWITCHER_TOKEN=%s\n' \
  "$KOMODO_API_KEY" "$KOMODO_API_SECRET" "$SWITCHER_TOKEN" > gpu-switcher/.env

echo "pre-deploy: gpu-switcher/.env written"
