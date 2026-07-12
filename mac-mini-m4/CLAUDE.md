# mac-mini-m4 Komodo Stacks

## Version Pinning — CRITICAL RULE

**All image versions in every compose.yaml are pinned intentionally. Never update a version tag or digest without being explicitly asked to.**

Unpinned or casually-bumped images have caused production outages here. Examples:
- `zigbee2mqtt 2.9.2` broke Zigbee (herdsman 10.x + EFR32 firmware incompatibility, required full crash-loop recovery)

If asked to "update" or "upgrade" a service, confirm the target version explicitly before touching any image tag.

## Stacks

| Directory | Services | Notes |
|-----------|----------|-------|
| `automation/` | Home Assistant, Mosquitto, Zigbee2MQTT | Z2M pinned to 2.9.1 — see CLAUDE.md |
| `core/` | Technitium DNS, pgvector, MongoDB | |
| `docker-maintenance/` | docker-prune cron | Weekly build cache cleanup — see CLAUDE.md |
| `komodo/` | Komodo Core, FerretDB, PostgreSQL DocumentDB | Core uses env-driven tag |
| `llm/` | Ollama, LLM Manager agent | |
| `monitoring/` | Prometheus, Grafana, exporters | |
| `mosquitto/` | Standalone Mosquitto (legacy) | |
| `runners/` | GitHub Actions self-hosted runner | |
| `gtfs-cleanup/` | GTFS data cleanup job | |

## Non-stack directories

| Directory | Purpose |
|-----------|---------|
| `zigbee2mqtt/` | Z2M config, extensions, proxy — not a stack itself (served by `automation/`) |
| `homeassistant/` | HA config files, automations, scripts — mounted by `automation/` |
| `mosquitto/` | Mosquitto config — mounted by `automation/` |
| `launchd/` | macOS launchd plists for host-level services |
| `scripts/` | Deployment scripts (inject-secrets, etc.) |
| `manual_runs/` | One-off commands requiring manual execution |

## Deployment Workflow

**All changes to mac-mini-m4 stacks must be made locally in the git repo and pushed — never edit files directly on the host.**

- The `komodo-dean-gitops` repo is cloned at `~/komodo-dean-gitops` on mac-mini-m4
- A LaunchDaemon (`com.local.komodo-stack-sync.plist`) runs `scripts/sync-stacks.sh` every 60s, which does `git fetch && git pull` and restarts changed compose stacks via Komodo
- Make changes only on murderbot (this machine) in `~/claude/projects/komodo-dean-gitops/mac-mini-m4/`
- Commit and push — the sync script picks up changes within 60 seconds
- **Never** SSH into mac-mini-m4 and edit files directly, run `git pull`, or modify running containers
