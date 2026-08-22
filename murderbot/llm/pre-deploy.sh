#!/usr/bin/env bash
# Writes murderbot/llm/.env from BWS + Komodo Variables for Komodo deploy.
# Invoked by Komodo Periphery: BWS_ACCESS_TOKEN and MURDERBOT_LLM_PROFILE are
# exported before this script runs (see resource-sync/stacks.toml's pre_deploy
# command -- MURDERBOT_LLM_PROFILE is interpolated there from the Komodo
# Variable of the same name, NOT read from git. That Variable is what the
# gpu-switcher service (murderbot/gpu-switcher/) changes to switch models --
# this script just turns it into COMPOSE_PROFILES so `docker compose up`
# picks the right profile in murderbot/llm/compose.yaml).
set -euo pipefail

: "${BWS_ACCESS_TOKEN:?BWS_ACCESS_TOKEN required}"
: "${MURDERBOT_LLM_PROFILE:?MURDERBOT_LLM_PROFILE required (set via Komodo Variable)}"

case "$MURDERBOT_LLM_PROFILE" in
  qwen36|qwen38|qwen3coder) ;;
  *) echo "pre-deploy: unknown MURDERBOT_LLM_PROFILE '$MURDERBOT_LLM_PROFILE' (expected qwen36, qwen38, or qwen3coder)" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HF_TOKEN=$(bws secret get "d76ac5f6-3c43-4bc8-bb99-b444016f4aed" \
    --access-token "$BWS_ACCESS_TOKEN" | jq -r .value | tr -d '[:space:]')

[[ -n "$HF_TOKEN" && "$HF_TOKEN" != "null" ]] \
  || { echo "pre-deploy: failed to fetch hugging-face-read-only" >&2; exit 1; }

umask 077
printf 'HF_TOKEN=%s\nCOMPOSE_PROFILES=%s\n' "$HF_TOKEN" "$MURDERBOT_LLM_PROFILE" > llm/.env

echo "pre-deploy: llm/.env written (COMPOSE_PROFILES=$MURDERBOT_LLM_PROFILE)"
