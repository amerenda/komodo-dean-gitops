# media-server stack

Komodo-managed Docker Compose stack on murderbot (Debian Periphery host).

## Version pinning — REQUIRED

All container images MUST be pinned to a specific version tag. **Never use `:latest`.**

Rules for agents/editors working with this repo:

1. Always pin images to the latest stable semver release tag (e.g. `4.0.17`, not a commit hash or digest)
2. For linuxserver images, use the simple X.Y.Z tag (not the `-lsN` build suffix unless needed for compatibility)
3. For GitHub container registry images, include the `v` prefix if that's how releases are tagged (e.g. `v3.2.0`)
4. Do NOT pin to commit SHA digests or image digests — use human-readable version numbers only
5. When bumping versions: verify the new tag exists on Docker Hub/ghcr.io, check changelogs for breaking changes, then update the compose.yaml and pre-deploy.sh if env vars changed

## Jellyfin — known issue: SQLite "database is locked" under concurrent access

Since Jellyfin 10.9/10.10 (EF Core SQLite backend rewrite), concurrent DB access
(library scans, playback, multiple simultaneous Streamyfin downloads all hitting
the DB at once) can throw `SQLite Error 5: 'database is locked'`, failing the
in-flight request. Confirmed in our own logs 2026-07 (burst of failed `/Items`
and `/Shows/.../Episodes` requests during a nightly library scan). This is an
open upstream architecture issue, not fully fixed as of 10.11.8 — see
forum.jellyfin.org/t-sqlite-error-database-is-locked and
github.com/jellyfin/jellyfin/issues/15057.

Mitigations applied/considered, roughly in order of effort:
1. **Applied 2026-07-28:** `JELLYFIN_SQLITE__disableSecondLevelCache=true` env
   var (compose.yaml) — community-reported to reduce lock frequency, not a full fix.
2. Not yet applied: limit `LibraryScanFanoutConcurrency` / `ParallelImageEncodingLimit`
   to 1 in Jellyfin admin settings (currently both `0` = unlimited in system.xml) —
   reduces DB contention during scans. Requires Jellyfin admin UI access.
3. Not yet applied: disabling non-essential plugins to test for conflicts.
   Intro Skipper is installed and has been named in community bug reports as a
   contributor to lock-ups; LDAP and Kodi Sync Queue plugins are not installed here.
4. **Applied 2026-08-02:** Config dir moved off the RAID5 HDD array
   (`/mnt/storage`) onto the NVMe SSD (`nvme0n1`, Patriot M.2 P320 128GB,
   mounted at `/`) — now at `/opt/jellyfin-config` on the host, set via
   `JELLYFIN_CONFIG_ROOT` in `pre-deploy.sh` (separate from `CONFIG_ROOT`,
   which stays on RAID for every other service in this stack). This is the
   standard recommendation but is reported to help, not fully resolve, this
   issue.

## Jellyfin metadata — known issue: anime plugins contaminating Movies/TV

Jellyfin has AniDB, AniList, and AniSearch plugins installed. At default settings
(AniDB `TitleSimilarityThreshold=50`), these plugins match Hollywood movies to
unrelated anime/hentai titles by fuzzy title similarity. Discovered 2026-07-06:
63+ movies had AniDB metadata, 57+ had AniList metadata (wrong titles, plots,
hentai genres, anime actors).

### What pre-deploy.sh fixes automatically

`pre-deploy.sh` copies `config/jellyfin-plugins/Jellyfin.Plugin.AniDB.xml` (and
AniList/AniSearch) into the Jellyfin plugin config dir on every deploy, enforcing
`TitleSimilarityThreshold=95`. This is a band-aid — the root fix requires the
Jellyfin admin UI.

### Manual fix required in Jellyfin admin UI

For each non-anime library (Movies, TV, Discover if not anime):
1. Admin → Libraries → (library) → ⋮ → Edit
2. Open "Metadata downloaders" section
3. Remove **AniDB**, **AniList**, **AniSearch** from the enabled providers list
4. Save

After disabling per-library, refresh all metadata for each affected library
(Admin → Libraries → (library) → ⋮ → Refresh Metadata → Replace all metadata).
This will regenerate the 63+ contaminated movie.nfo files from TMDB only.

## Sonarr missing-episode search cron

Sonarr has no built-in recurring task to search for episodes it already knows
are missing. Its only scheduled tasks are `Rss Sync` (15 min — catches new
releases as indexers post them) and `Refresh Monitored Downloads` (1 min —
polls status of downloads already queued). Neither backfills an episode
Sonarr failed to grab the first time (bad initial release, indexer outage, a
show added to the library after it aired). Confirmed directly against this
instance 2026-08-28 (`GET /api/v3/system/task` showed only those two tasks);
also confirmed live that this gap is not theoretical — Star Trek: The Next
Generation had been sitting at 1/178 episode files since being added
2026-05-05, simply because nothing had ever searched for the other 177.

`sonarr-missing-search-cron` (compose.yaml) runs a `docker:27-cli` container
with busybox crond — same shape as `mac-mini-m4/docker-maintenance` — that
POSTs `{"name":"MissingEpisodeSearch"}` to Sonarr's command API daily at 4am
America/New_York. Schedule/command lives in
`config/sonarr-cron/crontab.txt`. Sonarr's `urlBase` on this instance is
`/sonarr` (confirmed via `GET /api/v3/config/host`) — the cron's URL must
include that path segment or every request 307s and wget silently no-ops.

`SONARR_API_KEY` is fetched from BWS (`sonarr-api-key`) in `pre-deploy.sh`,
same pattern as `HARDCOVER_API_KEY`. Busybox crond inherits the container's
process environment for jobs it spawns (unlike vixie-cron, which strips it),
so referencing `$SONARR_API_KEY` directly in the crontab line works without
a separate env file.

## Book metadata — one source of truth: Hardcover

Three writers touched book metadata independently (manual `calibredb add`,
LazyLibrarian's GoodReads-backed import, calibre's own auto-lookup on
import), producing inconsistent series/title data (e.g. "Red Rising" (id 1)
had no series link at all while Golden Son/Morning Star did). Fixed
2026-07-23 by making calibre + Hardcover.app the single metadata authority:

1. LazyLibrarian imports a book and writes its ISBN into calibre via OPF
   (`<dc:identifier opf:scheme="ISBN">`, see `metadata_opf.py`) — this is
   the *only* thing LazyLibrarian's own metadata is trusted for now.
2. The `calibre-metadata-sync` sidecar (compose.yaml, reuses the `calibre`
   image with `entrypoint` overridden to skip s6/Xvfb — calibredb and
   fetch-ebook-metadata are headless CLI tools) polls every 15 min for books
   with an ISBN identifier not yet marked `hardcover_synced`, and pulls
   canonical title/authors/series/tags from Hardcover via
   `fetch-ebook-metadata --allowed-plugin Hardcover` — restricted to that one
   source, no merging with Amazon/Google Books. Script:
   `config/calibre-mods/hardcover-metadata-sync.py`.
3. calibre's own GUI/`calibredb` uses the `RobBrazier/calibre-plugins`
   Hardcover Source plugin (installed via `calibre-customize -a`, config
   dir persisted at `${CALIBRE_CONFIG}`); its API key is seeded on every
   container start by a `custom-cont-init.d` script
   (`config/calibre-mods/10-hardcover-key.sh`) from `HARDCOVER_API_KEY`.
4. calibre-web's manual "Search metadata" button also gets a Hardcover
   option via `darkestthewhite/calibre-web-hardcover`
   (`config/calibre-web-mods/hardcover.py`, bind-mounted directly onto
   `cps/metadata_provider/hardcover.py` — calibre-web auto-discovers every
   `.py` file in that directory, no registration needed).

**Known gap:** books whose only identifier is `goodreads` (no ISBN) never
get picked up by the sync sidecar — no fallback title/author search, by
design, to avoid fuzzy-match false positives. `HARDCOVER_API_KEY` is one
BWS secret (`hardcover-api-key`) shared by all three integration points.

## shelfarr + BookOrbit trial — replacing LazyLibrarian/calibre-web

Added 2026-09-03, Phase 2 of a planned migration (full decision record and
plan: Obsidian `Projects/Media Server Stack/Plans/shelfarr-migration.md`
and its background note). LazyLibrarian has no real download-curation
model and grabs far more books/editions than wanted — a known, long-
standing upstream limitation, not a config bug
([DobyTang/LazyLibrarian#867](https://github.com/DobyTang/LazyLibrarian/issues/867)).

**This is a trial, not a cutover.** `shelfarr` and `bookorbit-app`/
`bookorbit-db` write only to `BOOKS_TRIAL_*` paths
(`/mnt/storage/books/shelfarr-trial/{ebooks,audiobooks}`) — never
`CALIBRE_LIBRARY_FOLDER`. LazyLibrarian/calibre/calibre-web keep running
unchanged; nothing about the live library or the existing
`books.amer.dev`/`calibre.amer.dev`/`opds.amer.dev` ingress changes in this
phase.

- **shelfarr** replaces LazyLibrarian as the acquisition/curation layer —
  it auto-selects a single best release per request (optionally gated by
  admin approval) instead of grabbing every match. Reuses the existing
  `prowlarr`/`sabnzbd` containers, configured via its own UI (Settings >
  Indexers / Download Clients) post-deploy — no env var wiring for that.
- **BookOrbit** replaces calibre-web as the serving layer — chosen over
  Grimmory/Audiobookshelf because it ships a dedicated KOReader plugin
  (native on-device catalog browser + download, the best fit for the Boox
  Onyx Go 7, which runs real KOReader) plus plain OPDS support (covers the
  XTeink X3's CrossPoint firmware). Runs its own bundled Postgres
  (`bookorbit-db`, `pgvector/pgvector:pg18`, as shipped upstream) rather
  than the shared mac-mini-m4 Postgres instance, to avoid an untested
  extension/version mismatch during the trial.
- **kosync/libsync is mandatory and untouched by this trial** — both
  devices keep syncing reading position via the existing
  `libsync.amer.dev` exactly as before. BookOrbit's own three-way progress
  sync feature must stay disabled — never enable it, to avoid two systems
  writing conflicting progress for the same book.
- shelfarr is the sole acquisition/curation gate — BookOrbit's own
  built-in book-request feature (indexers, download clients) is
  deliberately left unconfigured, to avoid two competing acquisition
  paths.
- `SHELFARR_RAILS_MASTER_KEY`, `BOOKORBIT_JWT_SECRET`,
  `BOOKORBIT_SETUP_BOOTSTRAP_TOKEN`, and `BOOKORBIT_POSTGRES_PASSWORD` are
  BWS secrets, fetched in `pre-deploy.sh` the same way as
  `HARDCOVER_API_KEY`/`SONARR_API_KEY`.

### Current pinned versions

| Service | Image | Pinned Version | Notes |
|---------|-------|----------------|-------|
| profilarr | `santiagosayshey/profilarr` | `v1.1.4` | Latest stable release |
| prowlarr | `linuxserver/prowlarr` | `2.3.5` | linuxserver tag (no `-lsN`) |
| sabnzbd | `lscr.io/linuxserver/sabnzbd` | `5.0.3` | linuxserver tag |
| radarr | `lscr.io/linuxserver/radarr` | `6.1.1` | linuxserver tag |
| sonarr | `linuxserver/sonarr` | `4.0.17` | Sonarr V4 — no custom script hooks |
| bazarr | `linuxserver/bazarr` | `1.5.6` | linuxserver tag |
| jellyfin | `linuxserver/jellyfin` | `10.11.11` | Upgraded 2026-07-13 to unblock IntroSkipper ≥1.10.11.20 |
| seerr | `ghcr.io/seerr-team/seerr` | `v3.2.0` | GitHub release tag |
| recyclarr | `ghcr.io/recyclarr/recyclarr` | `7` | Major version only (stable v7 API) |
| calibre | `lscr.io/linuxserver/calibre` | `9.11.0` | linuxserver tag (no `-lsN`) |
| calibre-web | `lscr.io/linuxserver/calibre-web` | `0.6.26` | linuxserver tag (no `-lsN`) |
| lazylibrarian | `lscr.io/linuxserver/lazylibrarian` | `9838d6fe-ls314` | No semver releases exist upstream — only commit-hash build tags. Bumped from f4110fff 2026-07-23: that build's `add_book` handler didn't accept the `source=` param the frontend sends, causing a 404 on every "add book" click. |
| sonarr-missing-search-cron | `docker:27-cli` | `27` | Same crond shape/version as mac-mini-m4/docker-maintenance. Daily `MissingEpisodeSearch` — see config/sonarr-cron/crontab.txt. |
| shelfarr | `ghcr.io/pedro-revez-silva/shelfarr` | `2026.08.31.1` | GitHub release `v2026.08.31.1`; OCI tag drops the `v` prefix per upstream's own versioning note. Trial only, see section above. |
| bookorbit-app / bookorbit-db | `ghcr.io/bookorbit/bookorbit` / `pgvector/pgvector` | `2.8.1` / `pg18` | BookOrbit's GitHub release tag is `v2.8.1` but its OCI/GHCR image tag drops the `v` prefix (confirmed against the registry directly — `v2.8.1` 404s as `manifest unknown`, `2.8.1` resolves); same convention as shelfarr above. bookorbit-db pinned to major-version tag only, same pattern as recyclarr — upstream doesn't publish patch-level pgvector/PG tags. Trial only, see section above. |
