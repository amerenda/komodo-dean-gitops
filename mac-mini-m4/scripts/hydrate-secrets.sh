#!/usr/bin/env bash
# Shared secret/template hydration for Komodo pre_deploy hooks.
# Usage: hydrate-secrets.sh <stack-dir>
# Invoked by Komodo Periphery from the gitops repo root, so <stack-dir> is
# relative to that root (e.g. mac-mini-m4/couchdb). Reads <stack-dir>/secrets.toml,
# fetches every [[secret]] entry by name via one `bws secret list` call
# (porting openwebui's existing pattern -- fewer BWS round-trips than N
# `bws secret get <uuid>` calls), writes <stack-dir>/.env atomically, then
# renders any [[template]] entries via envsubst.
#
# Written as a portable subset-of-TOML parser (plain POSIX awk + bash
# process substitution, no gawk-only match()-with-array, no mapfile) since
# this runs under macOS's stock /bin/bash (3.2) and /usr/bin/awk (BSD awk),
# not guaranteed GNU tool versions.
#
# [[dir]] entries (directory/permission setup) are not handled here yet --
# see Projects/deployment-optimizations/Plans/komodo-deploy-hygiene.md
# Phase 3/4 in the Dean Obsidian vault.
set -euo pipefail

: "${BWS_ACCESS_TOKEN:?BWS_ACCESS_TOKEN required (cat /run/secrets/bws-access-token)}"

STACK_DIR="${1:?usage: hydrate-secrets.sh <stack-dir>}"
MANIFEST="${STACK_DIR}/secrets.toml"
[[ -f "$MANIFEST" ]] || { echo "hydrate-secrets: no manifest at $MANIFEST" >&2; exit 1; }

extract_pairs() {
  # $1 = table name (e.g. "secret"), $2 = first field, $3 = second field.
  # Prints "<field1>\t<field2>" per [[<table>]] block found in $MANIFEST.
  awk -v table="$1" -v f1="$2" -v f2="$3" '
    $0 ~ "^\\[\\[" table "\\]\\]" {
      if (intbl && v1 != "" && v2 != "") print v1 "\t" v2
      intbl=1; v1=""; v2=""; next
    }
    /^\[\[/ { if (intbl && v1 != "" && v2 != "") print v1 "\t" v2; intbl=0 }
    intbl && $0 ~ "^" f1 "[ \t]*=" {
      line=$0; sub(/^[^"]*"/, "", line); sub(/".*/, "", line); v1=line
    }
    intbl && $0 ~ "^" f2 "[ \t]*=" {
      line=$0; sub(/^[^"]*"/, "", line); sub(/".*/, "", line); v2=line
    }
    END { if (intbl && v1 != "" && v2 != "") print v1 "\t" v2 }
  ' "$MANIFEST"
}

BWS_LIST_JSON="$(bws secret list --access-token "$BWS_ACCESS_TOKEN")"

ENV_TMP="${STACK_DIR}/.env.tmp.$$"
trap 'rm -f "$ENV_TMP"' EXIT
umask 077
: > "$ENV_TMP"

SECRET_COUNT=0
while IFS=$'\t' read -r env_name bws_name; do
  [[ -z "$env_name" ]] && continue
  value="$(printf '%s' "$BWS_LIST_JSON" | jq -r --arg k "$bws_name" '.[] | select(.key == $k) | .value')"
  if [[ -z "$value" || "$value" == "null" ]]; then
    echo "hydrate-secrets: failed to fetch '$bws_name' (for $env_name) from BWS" >&2
    exit 1
  fi
  printf '%s=%s\n' "$env_name" "$value" >> "$ENV_TMP"
  SECRET_COUNT=$((SECRET_COUNT + 1))
done < <(extract_pairs secret name bws_name)

mv "$ENV_TMP" "${STACK_DIR}/.env"
trap - EXIT

TEMPLATE_COUNT=0
while IFS=$'\t' read -r src dest; do
  [[ -z "$src" ]] && continue
  TPL_TMP="${STACK_DIR}/${dest}.tmp.$$"
  (
    set -a
    # shellcheck disable=SC1090
    source "${STACK_DIR}/.env"
    set +a
    envsubst < "${STACK_DIR}/${src}" > "$TPL_TMP"
  )
  mv "$TPL_TMP" "${STACK_DIR}/${dest}"
  TEMPLATE_COUNT=$((TEMPLATE_COUNT + 1))
done < <(extract_pairs template src dest)

echo "hydrate-secrets: wrote ${STACK_DIR}/.env (${SECRET_COUNT} secrets, ${TEMPLATE_COUNT} templates)"
