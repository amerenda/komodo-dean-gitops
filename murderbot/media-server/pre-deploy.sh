#!/usr/bin/env bash
# Renders murderbot/media-server/.env from BWS for Komodo deploy.
# Invoked by Komodo Periphery from the gitops repo root, so all paths below
# are relative to that root.
set -euo pipefail

# Stale Komodo stack → server bindings may still target archlinux after the
# murderbot migration. Refuse pre-deploy on the known archlinux LAN IP
# (ansible inventory). Unset or override to allow: MEDIA_SERVER_BLOCK_LAN_IPS=""
MEDIA_SERVER_BLOCK_LAN_IPS="${MEDIA_SERVER_BLOCK_LAN_IPS:-10.100.20.25}"
if [[ -n "$MEDIA_SERVER_BLOCK_LAN_IPS" ]]; then
  _ips=" $(hostname -I 2>/dev/null || echo) "
  for _bad in $MEDIA_SERVER_BLOCK_LAN_IPS; do
    [[ -z "$_bad" ]] && continue
    if [[ "$_ips" == *" ${_bad} "* ]]; then
      echo "media-server pre-deploy: blocked on LAN IP ${_bad} (archlinux). In Komodo, set this stack's server to murderbot only." >&2
      exit 1
    fi
  done
fi

: "${BWS_ACCESS_TOKEN:?BWS_ACCESS_TOKEN required (cat /run/secrets/bws-access-token)}"

# Remove orphaned containers from pre-k3s-ingress era (nginx/certbot/dns no
# longer in compose; k3s Traefik + cert-manager handle TLS termination).
for _c in nginx certbot dns; do
  docker rm -f "$_c" 2>/dev/null || true
done

ENV=murderbot/media-server/.env

umask 077
CONFIG_ROOT=/mnt/storage/media/config
SEERR_CONFIG_DIR="${CONFIG_ROOT}/seerr/config"

# Seerr runs as the `node` user (UID/GID 1000) and writes logs below
# /app/config. If Docker created the bind mount path as root on first boot,
# startup fails with EACCES when Seerr tries to create /app/config/logs.
mkdir -p "$SEERR_CONFIG_DIR"
chown 1000:1000 "${CONFIG_ROOT}/seerr" "$SEERR_CONFIG_DIR"
chmod 0755 "${CONFIG_ROOT}/seerr" "$SEERR_CONFIG_DIR"
{
  echo "CONFIG_BASE=${CONFIG_ROOT}"
  echo "PROFILARR_CONFIG=${CONFIG_ROOT}/profilarr/config"
  echo "RADARR_CONFIG=${CONFIG_ROOT}/radarr/config"
  echo "BAZARR_CONFIG=${CONFIG_ROOT}/bazarr/config"
  echo "SONARR_CONFIG=${CONFIG_ROOT}/sonarr/config"
  echo "RECYCLARR_CONFIG=${CONFIG_ROOT}/recyclarr/config"
  echo "PROWLARR_CONFIG=${CONFIG_ROOT}/prowlarr/config"
  echo "SABNZBD_CONFIG=${CONFIG_ROOT}/sabnzbd/config"
  echo "JELLYFIN_CONFIG=${CONFIG_ROOT}/jellyfin/config"
  echo "SEERR_CONFIG=${CONFIG_ROOT}/seerr/config"
  echo "DATA_BASE=/mnt/storage"
  echo "MOVIES_FOLDER=/mnt/storage/movies"
  echo "TV_FOLDER=/mnt/storage/tv"
  echo "BOOKS_FOLDER=/mnt/storage/books"
  echo "DISCOVER_FOLDER=/mnt/storage/discover"
  echo "USENET_DOWNLOADS=/mnt/storage/downloads/complete"
  echo "USENET_DOWNLOADS_INCOMPLETE=/mnt/storage/downloads/incomplete"
  echo "TRANSCODE_FOLDER=/mnt/storage/cache/transcode"
  echo "JELLYFIN_URL=http://10.100.20.19:8096"
} > "$ENV"

# Sanity check: assert media-server compose file is at the expected path so
# Komodo's `docker compose up` doesn't silently use the wrong cwd.
test -f murderbot/media-server/compose.yaml \
  || { echo "media-server pre-deploy: compose file missing in $(pwd)" >&2; exit 1; }
