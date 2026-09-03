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

HARDCOVER_API_KEY=$(bws secret get "df58364d-4e24-4844-bad3-b4900137097e" \
    --access-token "$BWS_ACCESS_TOKEN" | jq -r .value | tr -d '[:space:]')
[[ -n "$HARDCOVER_API_KEY" && "$HARDCOVER_API_KEY" != "null" ]] \
  || { echo "media-server pre-deploy: failed to fetch hardcover-api-key" >&2; exit 1; }

SONARR_API_KEY=$(bws secret get "d3a7aeb5-0dc5-4fa2-99b6-b4b4014fb50a" \
    --access-token "$BWS_ACCESS_TOKEN" | jq -r .value | tr -d '[:space:]')
[[ -n "$SONARR_API_KEY" && "$SONARR_API_KEY" != "null" ]] \
  || { echo "media-server pre-deploy: failed to fetch sonarr-api-key" >&2; exit 1; }

# shelfarr + BookOrbit trial (Phase 2 of the LazyLibrarian→shelfarr migration,
# see Obsidian Projects/Media Server Stack/Plans/shelfarr-migration.md).
SHELFARR_RAILS_MASTER_KEY=$(bws secret get "61e42ee7-67bc-456f-947f-b4ba00e5a451" \
    --access-token "$BWS_ACCESS_TOKEN" | jq -r .value | tr -d '[:space:]')
[[ -n "$SHELFARR_RAILS_MASTER_KEY" && "$SHELFARR_RAILS_MASTER_KEY" != "null" ]] \
  || { echo "media-server pre-deploy: failed to fetch shelfarr-rails-master-key" >&2; exit 1; }

BOOKORBIT_JWT_SECRET=$(bws secret get "50b0512c-9eef-4f95-ab98-b4ba00e5a64c" \
    --access-token "$BWS_ACCESS_TOKEN" | jq -r .value | tr -d '[:space:]')
[[ -n "$BOOKORBIT_JWT_SECRET" && "$BOOKORBIT_JWT_SECRET" != "null" ]] \
  || { echo "media-server pre-deploy: failed to fetch bookorbit-jwt-secret" >&2; exit 1; }

BOOKORBIT_SETUP_BOOTSTRAP_TOKEN=$(bws secret get "82ad16fd-2a27-4817-8884-b4ba00e5a856" \
    --access-token "$BWS_ACCESS_TOKEN" | jq -r .value | tr -d '[:space:]')
[[ -n "$BOOKORBIT_SETUP_BOOTSTRAP_TOKEN" && "$BOOKORBIT_SETUP_BOOTSTRAP_TOKEN" != "null" ]] \
  || { echo "media-server pre-deploy: failed to fetch bookorbit-setup-bootstrap-token" >&2; exit 1; }

BOOKORBIT_POSTGRES_PASSWORD=$(bws secret get "99c027fc-81d7-44f4-837b-b4ba00e5aa50" \
    --access-token "$BWS_ACCESS_TOKEN" | jq -r .value | tr -d '[:space:]')
[[ -n "$BOOKORBIT_POSTGRES_PASSWORD" && "$BOOKORBIT_POSTGRES_PASSWORD" != "null" ]] \
  || { echo "media-server pre-deploy: failed to fetch bookorbit-postgres-password" >&2; exit 1; }

# Remove orphaned containers from pre-k3s-ingress era (nginx/certbot/dns no
# longer in compose; k3s Traefik + cert-manager handle TLS termination).
for _c in nginx certbot dns; do
  docker rm -f "$_c" 2>/dev/null || true
done

ENV=murderbot/media-server/.env

umask 077
CONFIG_ROOT=/mnt/storage/media/config
# Jellyfin config/db lives on the NVMe SSD, not the RAID5 array, to reduce
# SQLite "database is locked" contention under concurrent access (scans +
# playback + Streamyfin downloads). See CLAUDE.md "Jellyfin — known issue".
# Moved 2026-08-02. Every other service's config stays on CONFIG_ROOT (RAID).
JELLYFIN_CONFIG_ROOT=/opt/jellyfin-config
mkdir -p "$JELLYFIN_CONFIG_ROOT"
chown 1000:1000 "$JELLYFIN_CONFIG_ROOT"
SEERR_CONFIG_DIR="${CONFIG_ROOT}/seerr/config"

# Seerr runs as the `node` user (UID/GID 1000) and writes logs below
# /app/config. If Docker created the bind mount path as root on first boot,
# startup fails with EACCES when Seerr tries to create /app/config/logs.
mkdir -p "$SEERR_CONFIG_DIR"
chown 1000:1000 "${CONFIG_ROOT}/seerr" "$SEERR_CONFIG_DIR"
chmod 0755 "${CONFIG_ROOT}/seerr" "$SEERR_CONFIG_DIR"

# Same EACCES-on-first-boot issue applies to the new book stack: linuxserver
# images run as PUID/PGID 1000 and need their config + shared library dirs
# to already be owned 1000:1000 before the container's first start.
CALIBRE_CONFIG_DIR="${CONFIG_ROOT}/calibre/config"
CALIBREWEB_CONFIG_DIR="${CONFIG_ROOT}/calibre-web/config"
LAZYLIBRARIAN_CONFIG_DIR="${CONFIG_ROOT}/lazylibrarian/config"
CALIBRE_LIBRARY_DIR="/mnt/storage/books/calibre-library"
mkdir -p "$CALIBRE_CONFIG_DIR" "$CALIBREWEB_CONFIG_DIR" "$LAZYLIBRARIAN_CONFIG_DIR" "$CALIBRE_LIBRARY_DIR"
chown -R 1000:1000 "${CONFIG_ROOT}/calibre" "${CONFIG_ROOT}/calibre-web" "${CONFIG_ROOT}/lazylibrarian" "$CALIBRE_LIBRARY_DIR"
chmod 0755 "${CONFIG_ROOT}/calibre" "$CALIBRE_CONFIG_DIR" "${CONFIG_ROOT}/calibre-web" "$CALIBREWEB_CONFIG_DIR" "${CONFIG_ROOT}/lazylibrarian" "$LAZYLIBRARIAN_CONFIG_DIR"

# shelfarr + BookOrbit trial dirs. BOOKS_TRIAL_* is deliberately separate
# from CALIBRE_LIBRARY_DIR — nothing here touches the live library until
# Phase 3 of the migration plan. BookOrbit's own Postgres data dir is left
# at default ownership; the pgvector/pgvector image fixes it internally on
# first start.
SHELFARR_CONFIG_DIR="${CONFIG_ROOT}/shelfarr/storage"
BOOKORBIT_DATA_DIR="${CONFIG_ROOT}/bookorbit/data"
BOOKORBIT_POSTGRES_DATA_DIR="${CONFIG_ROOT}/bookorbit/postgres"
BOOKS_TRIAL_ROOT_DIR="/mnt/storage/books/shelfarr-trial"
BOOKS_TRIAL_EBOOKS_DIR="${BOOKS_TRIAL_ROOT_DIR}/ebooks"
BOOKS_TRIAL_AUDIOBOOKS_DIR="${BOOKS_TRIAL_ROOT_DIR}/audiobooks"
mkdir -p "$SHELFARR_CONFIG_DIR" "$BOOKORBIT_DATA_DIR" "$BOOKORBIT_POSTGRES_DATA_DIR" \
  "$BOOKS_TRIAL_EBOOKS_DIR" "$BOOKS_TRIAL_AUDIOBOOKS_DIR"
chown -R 1000:1000 "${CONFIG_ROOT}/shelfarr" "${CONFIG_ROOT}/bookorbit/data" "$BOOKS_TRIAL_ROOT_DIR"
chmod 0755 "$SHELFARR_CONFIG_DIR" "$BOOKORBIT_DATA_DIR" "$BOOKS_TRIAL_ROOT_DIR" "$BOOKS_TRIAL_EBOOKS_DIR" "$BOOKS_TRIAL_AUDIOBOOKS_DIR"

# Hardcover metadata source: calibre plugin's API key is seeded by a
# custom-cont-init.d script (needs to land in its own bind-mounted dir, not
# under /config, since that's a top-level linuxserver init path); calibre-web's
# provider file needs to land exactly on cps/metadata_provider/hardcover.py;
# the sync sidecar's script needs its own dir too. All copied fresh from the
# repo on every deploy so version-controlled edits actually take effect.
CALIBRE_CUSTOM_INIT_DIR="${CONFIG_ROOT}/calibre/custom-cont-init.d"
HARDCOVER_PROVIDER_DIR="${CONFIG_ROOT}/calibre-web/hardcover-mod"
CALIBRE_SYNC_SCRIPTS_DIR="${CONFIG_ROOT}/calibre/sync-scripts"
mkdir -p "$CALIBRE_CUSTOM_INIT_DIR" "$HARDCOVER_PROVIDER_DIR" "$CALIBRE_SYNC_SCRIPTS_DIR"
cp murderbot/media-server/config/calibre-mods/10-hardcover-key.sh "${CALIBRE_CUSTOM_INIT_DIR}/10-hardcover-key.sh"
chmod 0755 "${CALIBRE_CUSTOM_INIT_DIR}/10-hardcover-key.sh"
cp murderbot/media-server/config/calibre-web-mods/hardcover.py "${HARDCOVER_PROVIDER_DIR}/hardcover.py"
cp murderbot/media-server/config/calibre-mods/hardcover-metadata-sync.py "${CALIBRE_SYNC_SCRIPTS_DIR}/hardcover-metadata-sync.py"
cp murderbot/media-server/config/calibre-mods/loop.sh "${CALIBRE_SYNC_SCRIPTS_DIR}/loop.sh"
chmod 0755 "${CALIBRE_SYNC_SCRIPTS_DIR}/loop.sh"
chown -R 1000:1000 "$CALIBRE_CUSTOM_INIT_DIR" "$HARDCOVER_PROVIDER_DIR" "$CALIBRE_SYNC_SCRIPTS_DIR"
{
  echo "CONFIG_BASE=${CONFIG_ROOT}"
  echo "PROFILARR_CONFIG=${CONFIG_ROOT}/profilarr/config"
  echo "RADARR_CONFIG=${CONFIG_ROOT}/radarr/config"
  echo "BAZARR_CONFIG=${CONFIG_ROOT}/bazarr/config"
  echo "SONARR_CONFIG=${CONFIG_ROOT}/sonarr/config"
  echo "RECYCLARR_CONFIG=${CONFIG_ROOT}/recyclarr/config"
  echo "PROWLARR_CONFIG=${CONFIG_ROOT}/prowlarr/config"
  echo "SABNZBD_CONFIG=${CONFIG_ROOT}/sabnzbd/config"
  echo "JELLYFIN_CONFIG=${JELLYFIN_CONFIG_ROOT}"
  echo "SEERR_CONFIG=${CONFIG_ROOT}/seerr/config"
  echo "CALIBRE_CONFIG=${CONFIG_ROOT}/calibre/config"
  echo "CALIBREWEB_CONFIG=${CONFIG_ROOT}/calibre-web/config"
  echo "LAZYLIBRARIAN_CONFIG=${CONFIG_ROOT}/lazylibrarian/config"
  echo "HARDCOVER_API_KEY=${HARDCOVER_API_KEY}"
  echo "SONARR_API_KEY=${SONARR_API_KEY}"
  echo "SONARR_CRON_CRONTAB=$(pwd)/murderbot/media-server/config/sonarr-cron/crontab.txt"
  echo "CALIBRE_CUSTOM_INIT=${CALIBRE_CUSTOM_INIT_DIR}"
  echo "HARDCOVER_PROVIDER_FILE=${HARDCOVER_PROVIDER_DIR}/hardcover.py"
  echo "CALIBRE_SYNC_SCRIPTS=${CALIBRE_SYNC_SCRIPTS_DIR}"
  echo "SHELFARR_CONFIG=${SHELFARR_CONFIG_DIR}"
  echo "SHELFARR_RAILS_MASTER_KEY=${SHELFARR_RAILS_MASTER_KEY}"
  echo "BOOKORBIT_DATA_FOLDER=${BOOKORBIT_DATA_DIR}"
  echo "BOOKORBIT_POSTGRES_DATA=${BOOKORBIT_POSTGRES_DATA_DIR}"
  echo "BOOKORBIT_JWT_SECRET=${BOOKORBIT_JWT_SECRET}"
  echo "BOOKORBIT_SETUP_BOOTSTRAP_TOKEN=${BOOKORBIT_SETUP_BOOTSTRAP_TOKEN}"
  echo "BOOKORBIT_POSTGRES_PASSWORD=${BOOKORBIT_POSTGRES_PASSWORD}"
  echo "BOOKORBIT_APP_URL=http://10.100.20.19:3005"
  echo "BOOKS_TRIAL_ROOT=${BOOKS_TRIAL_ROOT_DIR}"
  echo "BOOKS_TRIAL_EBOOKS_FOLDER=${BOOKS_TRIAL_EBOOKS_DIR}"
  echo "BOOKS_TRIAL_AUDIOBOOKS_FOLDER=${BOOKS_TRIAL_AUDIOBOOKS_DIR}"
  echo "DATA_BASE=/mnt/storage"
  echo "MOVIES_FOLDER=/mnt/storage/movies"
  echo "TV_FOLDER=/mnt/storage/tv"
  echo "BOOKS_FOLDER=/mnt/storage/books"
  echo "CALIBRE_LIBRARY_FOLDER=/mnt/storage/books/calibre-library"
  echo "DISCOVER_FOLDER=/mnt/storage/discover"
  echo "USENET_DOWNLOADS=/mnt/storage/downloads/complete"
  echo "USENET_DOWNLOADS_INCOMPLETE=/mnt/storage/downloads/incomplete"
  echo "TRANSCODE_FOLDER=/mnt/storage/cache/transcode"
  echo "JELLYFIN_URL=http://10.100.20.19:8096"
} > "$ENV"

# Enforce versioned Jellyfin anime plugin configs to prevent title-similarity
# false-matches from contaminating the Movies/TV libraries with anime metadata.
# AniDB at threshold=50 (the default) matched "Obsession (2026)" → hentai and
# "Gladiator II" → hentai, corrupting 63+ movie NFOs before being caught.
# These files pin TitleSimilarityThreshold=95. The per-library fix (disabling
# AniDB/AniList/AniSearch as providers for Movies + TV in the Jellyfin admin
# UI) must be done manually — see CLAUDE.md for steps.
JELLYFIN_PLUGIN_CONF="${JELLYFIN_CONFIG_ROOT}/data/plugins/configurations"
mkdir -p "$JELLYFIN_PLUGIN_CONF"
for _plugin in AniDB AniList AniSearch; do
  _src="murderbot/media-server/config/jellyfin-plugins/Jellyfin.Plugin.${_plugin}.xml"
  _dst="${JELLYFIN_PLUGIN_CONF}/Jellyfin.Plugin.${_plugin}.xml"
  if [[ -f "$_src" ]]; then
    cp "$_src" "$_dst"
    echo "media-server pre-deploy: applied Jellyfin.Plugin.${_plugin}.xml"
  fi
done

# Enforce versioned Jellyfin network config.
# KnownProxies must NOT include 10.100.20.0/24 — listing the whole LAN as a
# trusted proxy causes Jellyfin to treat the Google Home Display / Chromecast
# as a proxy, breaking PublishedServerUri selection for Cast devices.
JELLYFIN_NET_CONF="${JELLYFIN_CONFIG_ROOT}"
_net_src="murderbot/media-server/config/jellyfin-config/network.xml"
if [[ -f "$_net_src" ]]; then
  cp "$_net_src" "${JELLYFIN_NET_CONF}/network.xml"
  echo "media-server pre-deploy: applied network.xml"
fi

# Sanity check: assert media-server compose file is at the expected path so
# Komodo's `docker compose up` doesn't silently use the wrong cwd.
test -f murderbot/media-server/compose.yaml \
  || { echo "media-server pre-deploy: compose file missing in $(pwd)" >&2; exit 1; }
