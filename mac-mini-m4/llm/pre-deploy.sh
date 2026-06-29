#!/usr/bin/env bash
# Writes llm/.env for Komodo deploy (Compose loads it for interpolation + container env).
# Run from the mac-mini-m4/ root inside komodo-dean-gitops.
# llm-agent removed 2026-06-29 — Ollama-only stack, LiteLLM routes directly to :11434.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OLLAMA_DATA_HOST_PATH="${OLLAMA_DATA_HOST_PATH:-${HOME}/.ollama}"
OLLAMA_MODELS_HOST_PATH="${OLLAMA_MODELS_HOST_PATH:-}"

# Komodo often runs this script as root (HOME=/root) or from a *Linux* build container
# (`uname` ≠ Darwin) while the stack targets macOS. In both cases we must not leave
# /root/.ollama in llm/.env.
if [[ "${OLLAMA_DATA_HOST_PATH}" == /root/.ollama || "${OLLAMA_DATA_HOST_PATH}" == /var/root/.ollama ]]; then
  if [[ -d /Users ]]; then
    _cu=""
    if [[ "$(uname -s)" == "Darwin" ]]; then
      _cu="$(stat -f '%Su' /dev/console 2>/dev/null || true)"
    fi
    if [[ -n "${_cu}" && "${_cu}" != "root" && -d "/Users/${_cu}/.ollama" ]]; then
      OLLAMA_DATA_HOST_PATH="/Users/${_cu}/.ollama"
    else
      for _uh in /Users/*; do
        [[ -d "${_uh}/.ollama" ]] || continue
        OLLAMA_DATA_HOST_PATH="${_uh}/.ollama"
        break
      done
    fi
  fi
fi
if [[ -n "${OLLAMA_MODELS_HOST_PATH}" ]] && {
     [[ "${OLLAMA_MODELS_HOST_PATH}" == /root/.ollama/models ]] ||
     [[ "${OLLAMA_MODELS_HOST_PATH}" == /var/root/.ollama/models ]]; }; then
  OLLAMA_MODELS_HOST_PATH="${OLLAMA_DATA_HOST_PATH}/models"
fi
OLLAMA_MODELS_HOST_PATH="${OLLAMA_MODELS_HOST_PATH:-${OLLAMA_DATA_HOST_PATH}/models}"

{
  echo "OLLAMA_IMAGE_TAG=${OLLAMA_IMAGE_TAG:-0.21.0}"
  echo "OLLAMA_DATA_HOST_PATH=${OLLAMA_DATA_HOST_PATH}"
  echo "OLLAMA_MODELS_HOST_PATH=${OLLAMA_MODELS_HOST_PATH}"
} >llm/.env

if [[ -f llm/gitops.env ]]; then
  sed '/^[[:space:]]*#/d;/^[[:space:]]*$/d' llm/gitops.env >>llm/.env
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
