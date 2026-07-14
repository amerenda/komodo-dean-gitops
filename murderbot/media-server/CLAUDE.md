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
