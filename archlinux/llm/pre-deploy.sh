#!/usr/bin/env bash
# Writes archlinux/llm/.env for Komodo deploy (Compose loads it for interpolation + container env).
# Run from repo root: bash archlinux/llm/pre-deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BWS_LLM_AGENT_PSK_UUID="cdaa7917-3eba-44b5-a9ea-b41300f1dab5"

OLLAMA_DATA_HOST_PATH="${OLLAMA_DATA_HOST_PATH:-${HOME}/.ollama}"
# Bulk model storage (same default as mac-mini-m4); Ollama uses OLLAMA_MODELS=/mnt/models in compose.
OLLAMA_MODELS_HOST_PATH="${OLLAMA_MODELS_HOST_PATH:-/mnt/storage/models}"
VIDEO_GID_DETECTED="$(getent group video | cut -d: -f3 || true)"
RENDER_GID_DETECTED="$(getent group render | cut -d: -f3 || true)"
VIDEO_GID="${VIDEO_GID:-${VIDEO_GID_DETECTED:-985}}"
RENDER_GID="${RENDER_GID:-${RENDER_GID_DETECTED:-989}}"

export BWS_ACCESS_TOKEN="${BWS_ACCESS_TOKEN:-$(cat /run/secrets/bws-access-token)}"

PSK="$(bws secret get "$BWS_LLM_AGENT_PSK_UUID" --access-token "$BWS_ACCESS_TOKEN" | jq -r .value)"

BACKEND_PUBLIC="${BACKEND_PUBLIC:-https://llm-manager-backend.amer.dev}"
BACKEND_PUBLIC="${BACKEND_PUBLIC%/}"
AGENT_IMAGE_TAG_RESOLVED="${AGENT_IMAGE_TAG:-}"
if [[ -z "$AGENT_IMAGE_TAG_RESOLVED" ]] && command -v curl >/dev/null && command -v jq >/dev/null; then
  AGENT_IMAGE_TAG_RESOLVED="$(curl -sfL "$BACKEND_PUBLIC/api/runners/target-version" | jq -r '.target_version // empty' | tr -d ' \t\r\n' || true)"
fi
if [[ -z "$AGENT_IMAGE_TAG_RESOLVED" ]]; then
  AGENT_IMAGE_TAG_RESOLVED="latest"
fi

{
  echo "LLM_MANAGER_AGENT_PSK=${PSK}"
  echo "BACKEND_URL=https://llm-manager-backend.amer.dev"
  echo "OLLAMA_URL=http://ollama:11434"
  echo "OLLAMA_CONTAINER=ollama"
  echo "AGENT_IMAGE_TAG=${AGENT_IMAGE_TAG_RESOLVED}"
  echo "OLLAMA_AMD_IMAGE_TAG=${OLLAMA_AMD_IMAGE_TAG:-0.21.0-rocm}"
  echo "VIDEO_GID=${VIDEO_GID:-985}"
  echo "RENDER_GID=${RENDER_GID:-989}"
  echo "HSA_OVERRIDE_GFX_VERSION=${HSA_OVERRIDE_GFX_VERSION:-}"
  echo "OLLAMA_DATA_HOST_PATH=${OLLAMA_DATA_HOST_PATH}"
  echo "OLLAMA_MODELS_HOST_PATH=${OLLAMA_MODELS_HOST_PATH}"
} > llm/.env

# Merge gitops.env (static overrides: agent address, host paths).
if [[ -f llm/gitops.env ]]; then
  while IFS= read -r _line; do
    [[ -z "${_line}" || "${_line}" =~ ^[[:space:]]*# ]] && continue
    _k="${_line%%=*}"
    _v="${_line#*=}"
    grep -q "^${_k}=" llm/.env 2>/dev/null && sed -i "s|^${_k}=.*|${_k}=${_v}|" llm/.env || echo "${_line}" >>llm/.env
  done <llm/gitops.env
fi

# UI overrides win for compose-interpolated path variables.
if [[ -f llm/ollama.ui.env ]]; then
  while IFS='=' read -r _k _v; do
    [[ -z "${_k:-}" || "${_k}" =~ ^[[:space:]]*# ]] && continue
    _k="$(echo "${_k}" | tr -d ' \t\r\n')"
    case "$_k" in
      OLLAMA_DATA_HOST_PATH|OLLAMA_MODELS_HOST_PATH)
        grep -v "^${_k}=" llm/.env >llm/.env.tmp || true
        mv llm/.env.tmp llm/.env
        echo "${_k}=${_v}" >>llm/.env
        ;;
    esac
  done <llm/ollama.ui.env
fi

if [[ ! -f llm/ollama.env ]]; then
  cp llm/ollama.env.example llm/ollama.env
fi
if [[ ! -f llm/ollama.ui.env ]]; then
  : >llm/ollama.ui.env
fi

# GPU stack strings for llm-manager Runners UI (agent-amd often cannot read amdgpu sysfs version).
# Injected into the agent container via .env — no new image required. Skip if gitops.env already set.
if ! grep -q '^ROCM_VERSION=' llm/.env 2>/dev/null; then
  if [[ -f /opt/rocm/.info/version ]]; then
    _rocm_v="$(tr -d ' \t\r\n' </opt/rocm/.info/version)"
    if [[ -n "${_rocm_v}" ]]; then
      echo "ROCM_VERSION=${_rocm_v}" >>llm/.env
    fi
  fi
fi
if ! grep -q '^AGENT_AMD_DRIVER_VERSION=' llm/.env 2>/dev/null; then
  if [[ -f /proc/sys/kernel/osrelease ]]; then
    _kr="$(tr -d ' \t\r\n' </proc/sys/kernel/osrelease)"
    if [[ -n "${_kr}" ]]; then
      echo "AGENT_AMD_DRIVER_VERSION=linux-${_kr}" >>llm/.env
    fi
  fi
fi
