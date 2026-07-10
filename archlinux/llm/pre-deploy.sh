#!/usr/bin/env bash
# Writes archlinux/llm/.env for Komodo deploy (Compose loads it for interpolation + container env).
# Run from repo root: bash archlinux/llm/pre-deploy.sh
# llm-agent removed 2026-06-29 — Ollama-only stack, LiteLLM routes directly to :11434.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OLLAMA_DATA_HOST_PATH="${OLLAMA_DATA_HOST_PATH:-${HOME}/.ollama}"
OLLAMA_MODELS_HOST_PATH="${OLLAMA_MODELS_HOST_PATH:-/mnt/storage/models}"
VIDEO_GID_DETECTED="$(getent group video | cut -d: -f3 || true)"
RENDER_GID_DETECTED="$(getent group render | cut -d: -f3 || true)"
VIDEO_GID="${VIDEO_GID:-${VIDEO_GID_DETECTED:-985}}"
RENDER_GID="${RENDER_GID:-${RENDER_GID_DETECTED:-989}}"

{
  echo "OLLAMA_AMD_IMAGE_TAG=${OLLAMA_AMD_IMAGE_TAG:-0.21.0-rocm}"
  echo "VIDEO_GID=${VIDEO_GID:-985}"
  echo "RENDER_GID=${RENDER_GID:-989}"
  echo "HSA_OVERRIDE_GFX_VERSION=${HSA_OVERRIDE_GFX_VERSION:-}"
  echo "OLLAMA_DATA_HOST_PATH=${OLLAMA_DATA_HOST_PATH}"
  echo "OLLAMA_MODELS_HOST_PATH=${OLLAMA_MODELS_HOST_PATH}"
} > llm/.env

# Merge gitops.env (static overrides: host paths).
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
