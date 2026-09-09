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
# shelfarr's own docker-entrypoint auto-generates and persists its
# SECRET_KEY_BASE + ActiveRecord encryption keys to /rails/storage on first
# boot when RAILS_MASTER_KEY/SECRET_KEY_BASE are unset — the documented
# zero-config path. Supplying our own RAILS_MASTER_KEY bypassed that and
# broke boot (Rails tried to decrypt config/credentials.yml.enc with a key
# that doesn't match; "key must be 16 bytes" / MessageEncryptor::InvalidMessage
# depending on key length). Do not reintroduce a RAILS_MASTER_KEY env var here.

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

# Phase 3 (shelfarr-migration.md): encrypts BookOrbit's stored migration
# source connection config at rest (Settings > Migration), same pattern as
# EMAIL_ENCRYPTION_KEY upstream. Not strictly required by BookOrbit, but
# recommended by its own .env.example — provision it since we're wiring up
# a real migration source (the old calibre library import).
BOOKORBIT_MIGRATION_ENCRYPTION_KEY=$(bws secret get "50a1e625-3d38-4fe1-b499-b4c00162f739" \
    --access-token "$BWS_ACCESS_TOKEN" | jq -r .value | tr -d '[:space:]')
[[ -n "$BOOKORBIT_MIGRATION_ENCRYPTION_KEY" && "$BOOKORBIT_MIGRATION_ENCRYPTION_KEY" != "null" ]] \
  || { echo "media-server pre-deploy: failed to fetch bookorbit-migration-encryption-key" >&2; exit 1; }

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
CALIBRE_LIBRARY_DIR="/mnt/storage/books/calibre-library"
mkdir -p "$CALIBRE_CONFIG_DIR" "$CALIBREWEB_CONFIG_DIR" "$CALIBRE_LIBRARY_DIR"
chown -R 1000:1000 "${CONFIG_ROOT}/calibre" "${CONFIG_ROOT}/calibre-web" "$CALIBRE_LIBRARY_DIR"
chmod 0755 "${CONFIG_ROOT}/calibre" "$CALIBRE_CONFIG_DIR" "${CONFIG_ROOT}/calibre-web" "$CALIBREWEB_CONFIG_DIR"

# shelfarr + BookOrbit dirs. BOOKS_LIBRARY_* (renamed from BOOKS_TRIAL_* in
# Phase 3 of shelfarr-migration.md — the shelfarr/BookOrbit library is now
# production, no "trial"-named path stays live) is deliberately separate
# from CALIBRE_LIBRARY_DIR — the old calibre library is imported in via
# BookOrbit's own Migration UI, then retired in Phase 4, not merged on disk.
SHELFARR_CONFIG_DIR="${CONFIG_ROOT}/shelfarr/storage"
BOOKORBIT_DATA_DIR="${CONFIG_ROOT}/bookorbit/data"
BOOKORBIT_POSTGRES_DATA_DIR="${CONFIG_ROOT}/bookorbit/postgres"
BOOKS_LIBRARY_ROOT_DIR="/mnt/storage/books/library"
BOOKS_LIBRARY_EBOOKS_DIR="${BOOKS_LIBRARY_ROOT_DIR}/ebooks"
BOOKS_LIBRARY_AUDIOBOOKS_DIR="${BOOKS_LIBRARY_ROOT_DIR}/audiobooks"
BOOKS_LIBRARY_COMICS_DIR="${BOOKS_LIBRARY_ROOT_DIR}/comics"

# One-time migration: the directory used to live at the old shelfarr-trial
# path (Phase 2). Move it in place before mkdir -p below would otherwise
# create an empty dir at the new path and orphan the real data at the old
# one. Idempotent — no-ops on every deploy after the first.
_OLD_BOOKS_TRIAL_ROOT_DIR="/mnt/storage/books/shelfarr-trial"
if [[ -d "$_OLD_BOOKS_TRIAL_ROOT_DIR" && ! -e "$BOOKS_LIBRARY_ROOT_DIR" ]]; then
  echo "media-server pre-deploy: migrating ${_OLD_BOOKS_TRIAL_ROOT_DIR} -> ${BOOKS_LIBRARY_ROOT_DIR}"
  mv "$_OLD_BOOKS_TRIAL_ROOT_DIR" "$BOOKS_LIBRARY_ROOT_DIR"
fi

mkdir -p "$SHELFARR_CONFIG_DIR" "$BOOKORBIT_DATA_DIR" "$BOOKORBIT_POSTGRES_DATA_DIR" \
  "$BOOKS_LIBRARY_EBOOKS_DIR" "$BOOKS_LIBRARY_AUDIOBOOKS_DIR" "$BOOKS_LIBRARY_COMICS_DIR"
chown -R 1000:1000 "${CONFIG_ROOT}/shelfarr" "${CONFIG_ROOT}/bookorbit/data" "$BOOKS_LIBRARY_ROOT_DIR"
chmod 0755 "$SHELFARR_CONFIG_DIR" "$BOOKORBIT_DATA_DIR" "$BOOKS_LIBRARY_ROOT_DIR" "$BOOKS_LIBRARY_EBOOKS_DIR" "$BOOKS_LIBRARY_AUDIOBOOKS_DIR" "$BOOKS_LIBRARY_COMICS_DIR"

# Phase 3 calibre-library import prep: stopped-snapshot copies of
# calibre-web's app.db and calibre's metadata.db for BookOrbit's Settings >
# Migration wizard ("Calibre-Web Automated" source, snapshot mode — see
# compose.yaml comment on bookorbit-app for why this works against stock
# calibre-web). Regenerated fresh on every deploy so the snapshot never
# goes stale before Alex runs the import in the UI. Neither python3 nor
# the sqlite3 CLI exist in the Komodo Periphery container this script
# actually runs in (confirmed 2026-09-09 — a python3-based online-backup
# approach failed silently here with "command not found" even though
# python3 is present on the bare host); plain `cp` is all that's
# available. To stay safe against a concurrent writer, this mirrors the
# exact same guard BookOrbit's own migration connector applies to the
# source file before it'll touch it: skip (don't copy) if a non-empty
# -wal/-journal sidecar is present, since that's a live/uncommitted
# database and BookOrbit would refuse it anyway. Source files
# intentionally optional — this stack still has calibre/calibre-web
# running (Phase 4 removes them), but a from-scratch deploy without that
# data present must not fail.
BOOKORBIT_MIGRATION_IMPORTS_DIR="${CONFIG_ROOT}/bookorbit/imports"
mkdir -p "$BOOKORBIT_MIGRATION_IMPORTS_DIR"
_snapshot_calibre_db() {
  local src="$1" dst="$2"
  [[ -f "$src" ]] || { echo "media-server pre-deploy: bookorbit migration snapshot skipped for ${dst##*/} (source missing)" >&2; return 0; }
  for _suffix in -wal -journal; do
    if [[ -s "${src}${_suffix}" ]]; then
      echo "media-server pre-deploy: bookorbit migration snapshot skipped for ${dst##*/} (active ${_suffix} sidecar present)" >&2
      return 0
    fi
  done
  cp -p "$src" "${dst}.tmp" && mv "${dst}.tmp" "$dst"
}
_snapshot_calibre_db "/mnt/storage/media/config/calibre-web/config/app.db" "${BOOKORBIT_MIGRATION_IMPORTS_DIR}/app.db"
_snapshot_calibre_db "/mnt/storage/books/calibre-library/metadata.db" "${BOOKORBIT_MIGRATION_IMPORTS_DIR}/metadata.db"
chown -R 1000:1000 "$BOOKORBIT_MIGRATION_IMPORTS_DIR"
chmod 0755 "$BOOKORBIT_MIGRATION_IMPORTS_DIR"
chmod 0644 "$BOOKORBIT_MIGRATION_IMPORTS_DIR"/*.db 2>/dev/null || true
# BookOrbit's bundled Postgres (pgvector/pgvector:pg18) hard-codes uid/gid
# 999 for its "postgres" user and does not honor PUID/PGID like the LSIO
# images above. Its entrypoint's first (root) pass only chowns $PGDATA
# itself (the "postgres/pgdata" subdir) before re-execing as uid 999 — it
# never touches this directory's own root, which this script's `umask 077`
# otherwise leaves as root:root 0700. On the uid-999 pass, postgres then
# can't even traverse into its own parent dir and crash-loops forever on
# "mkdir: cannot create directory '.../postgres': Permission denied".
# Confirmed 2026-09-07 by reproducing the entrypoint under bash -x against
# the real bind mount (914 restarts before this was found). Chowning here,
# every deploy, is what the pgvector image assumes the operator has
# already done — it does not and cannot do this part itself.
chown -R 999:999 "$BOOKORBIT_POSTGRES_DATA_DIR"

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
  echo "HARDCOVER_API_KEY=${HARDCOVER_API_KEY}"
  echo "SONARR_API_KEY=${SONARR_API_KEY}"
  echo "SONARR_CRON_CRONTAB=$(pwd)/murderbot/media-server/config/sonarr-cron/crontab.txt"
  echo "CALIBRE_CUSTOM_INIT=${CALIBRE_CUSTOM_INIT_DIR}"
  echo "HARDCOVER_PROVIDER_FILE=${HARDCOVER_PROVIDER_DIR}/hardcover.py"
  echo "CALIBRE_SYNC_SCRIPTS=${CALIBRE_SYNC_SCRIPTS_DIR}"
  echo "SHELFARR_CONFIG=${SHELFARR_CONFIG_DIR}"
  echo "BOOKORBIT_DATA_FOLDER=${BOOKORBIT_DATA_DIR}"
  echo "BOOKORBIT_POSTGRES_DATA=${BOOKORBIT_POSTGRES_DATA_DIR}"
  echo "BOOKORBIT_JWT_SECRET=${BOOKORBIT_JWT_SECRET}"
  echo "BOOKORBIT_SETUP_BOOTSTRAP_TOKEN=${BOOKORBIT_SETUP_BOOTSTRAP_TOKEN}"
  echo "BOOKORBIT_POSTGRES_PASSWORD=${BOOKORBIT_POSTGRES_PASSWORD}"
  echo "BOOKORBIT_MIGRATION_ENCRYPTION_KEY=${BOOKORBIT_MIGRATION_ENCRYPTION_KEY}"
  echo "BOOKORBIT_MIGRATION_IMPORTS_FOLDER=${BOOKORBIT_MIGRATION_IMPORTS_DIR}"
  echo "BOOKORBIT_APP_URL=https://bookorbit.media.amer.dev"
  echo "BOOKS_LIBRARY_ROOT=${BOOKS_LIBRARY_ROOT_DIR}"
  echo "BOOKS_LIBRARY_EBOOKS_FOLDER=${BOOKS_LIBRARY_EBOOKS_DIR}"
  echo "BOOKS_LIBRARY_AUDIOBOOKS_FOLDER=${BOOKS_LIBRARY_AUDIOBOOKS_DIR}"
  echo "BOOKS_LIBRARY_COMICS_FOLDER=${BOOKS_LIBRARY_COMICS_DIR}"
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
