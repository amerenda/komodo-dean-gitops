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

### Current pinned versions

| Service | Image | Pinned Version | Notes |
|---------|-------|----------------|-------|
| profilarr | `santiagosayshey/profilarr` | `v1.1.4` | Latest stable release |
| prowlarr | `linuxserver/prowlarr` | `2.3.5` | linuxserver tag (no `-lsN`) |
| sabnzbd | `lscr.io/linuxserver/sabnzbd` | `5.0.3` | linuxserver tag |
| radarr | `lscr.io/linuxserver/radarr` | `6.1.1` | linuxserver tag |
| sonarr | `linuxserver/sonarr` | `4.0.17` | Sonarr V4 — no custom script hooks |
| bazarr | `linuxserver/bazarr` | `1.5.6` | linuxserver tag |
| jellyfin | `linuxserver/jellyfin` | `10.11.8` | Pinned since stack creation |
| seerr | `ghcr.io/seerr-team/seerr` | `v3.2.0` | GitHub release tag |
| recyclarr | `ghcr.io/recyclarr/recyclarr` | `7` | Major version only (stable v7 API) |
| calibre | `lscr.io/linuxserver/calibre` | `9.11.0` | linuxserver tag (no `-lsN`) |
| calibre-web | `lscr.io/linuxserver/calibre-web` | `0.6.26` | linuxserver tag (no `-lsN`) |
| lazylibrarian | `lscr.io/linuxserver/lazylibrarian` | `9838d6fe-ls314` | No semver releases exist upstream — only commit-hash build tags. Bumped from f4110fff 2026-07-23: that build's `add_book` handler didn't accept the `source=` param the frontend sends, causing a 404 on every "add book" click. |
