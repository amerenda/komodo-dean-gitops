#!/usr/bin/env bash
# Writes murderbot/llm/.env from BWS for Komodo deploy.
# Invoked by Komodo Periphery: BWS_ACCESS_TOKEN is exported before this script runs.
set -euo pipefail

: "${BWS_ACCESS_TOKEN:?BWS_ACCESS_TOKEN required}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HF_TOKEN=$(bws secret get "d76ac5f6-3c43-4bc8-bb99-b444016f4aed" \
    --access-token "$BWS_ACCESS_TOKEN" | jq -r .value | tr -d '[:space:]')

[[ -n "$HF_TOKEN" && "$HF_TOKEN" != "null" ]] \
  || { echo "pre-deploy: failed to fetch hugging-face-read-only" >&2; exit 1; }

umask 077
printf 'HF_TOKEN=%s\n' "$HF_TOKEN" > llm/.env

echo "pre-deploy: llm/.env written"
