#!/usr/bin/env bash
# Writes murderbot/llm/.env from BWS for Komodo deploy.
# Invoked by Komodo Periphery from the gitops repo root.
set -euo pipefail

: "${BWS_ACCESS_TOKEN:?BWS_ACCESS_TOKEN required}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fetch_secret() {
    local id="$1"
    local val
    val=$(bws secret get "$id" 2>/dev/null | jq -r .value)
    val=$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    printf '%s' "$val"
}

SWITCH_PSK=$(fetch_secret "fb822d8e-fd24-4d6c-b854-b478010f282d")
HF_TOKEN=$(fetch_secret "d76ac5f6-3c43-4bc8-bb99-b444016f4aed")

[[ -n "$SWITCH_PSK" && "$SWITCH_PSK" != "null" ]] \
  || { echo "pre-deploy: failed to fetch llm-switch-psk" >&2; exit 1; }
[[ -n "$HF_TOKEN" && "$HF_TOKEN" != "null" ]] \
  || { echo "pre-deploy: failed to fetch hugging-face-read-only" >&2; exit 1; }

umask 077
{
  echo "SWITCH_PSK=${SWITCH_PSK}"
  echo "HF_TOKEN=${HF_TOKEN}"
  echo "LLAMA_IMAGE_TAG=${LLAMA_IMAGE_TAG:-latest}"
  echo "MODEL=${MODEL:-/mnt/models/llms/qwen36/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf}"
  echo "NGL=${NGL:-99}"
  echo "CTX=${CTX:-131072}"
} > llm/.env

echo "pre-deploy: llm/.env written"
