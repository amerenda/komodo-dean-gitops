# Mac Mini M4 - Core Home Lab Services

Docker Compose stacks for the Mac Mini M4, managed via Komodo GitOps from the
[`komodo-dean-gitops`](https://github.com/amerenda/komodo-dean-gitops) repo
(this folder: `mac-mini-m4/`).

**No manual work on the Mac Mini:** no SSH edits, no one-off deploys, no local-only config files on that host. Stack definitions and env come from **this repo** (merged by Komodo `resource-sync` / stack deploy). Secrets are injected in **`pre_deploy`** (e.g. Bitwarden). Anything that truly cannot live in GitOps (system packages, OS-level dependencies) belongs in **[ansible-playbooks](https://github.com/amerenda/ansible-playbooks)** (`playbooks/infrastructure/setup-macmini.yml`), not ad-hoc on the box.

## Services

### Services stack (`docker-compose.yaml`)

| Service | Network | Port | Purpose |
|---------|---------|------|---------|
| Home Assistant | host | 8123 | Smart home hub |
| Technitium | host | 53, 5380 | DNS server (replaced Pi-hole + BIND9) |
| Whisper | bridge | 10300 | Speech-to-text (Wyoming protocol) |
| Piper | bridge | 10200 | Text-to-speech (Wyoming protocol) |
| OpenWakeWord | bridge | 10400 | Wake word detection |
| Mosquitto | bridge | 1883 | MQTT broker (Zigbee2MQTT, HA) |
| Zigbee2MQTT | bridge | 8080 | Zigbee coordinator bridge |
| Postgres | bridge | 5432 | Primary database (pgvector/pg16) |
| MongoDB | bridge | 27017 | Secondary database (UniFi) |
| Prometheus | bridge | 9090 | Primary metrics TSDB + remote_write receiver |
| Grafana | bridge | 3000 | Primary monitoring dashboards/UI |
| Node Exporter | bridge | 9100 | Host metrics for Prometheus |
| Postgres backup | - | - | Daily backup to GCS |
| MongoDB backup | - | - | Daily backup to GCS |

### Runners stack (`runners/compose.yaml`)

| Service | Purpose |
|---------|---------|
| runner-k3s-runners | GitHub Actions runner for k3s-runners repo |
| runner-ecdysis | GitHub Actions runner for ecdysis repo |
| runner-photos | GitHub Actions runner for photos repo |

### Ollama (native, not Komodo-managed)

llm-manager is retired — there is no `llm/` Komodo stack on this host anymore (the old agent-container stack was deleted; Docker on macOS has no Metal/GPU passthrough anyway, so Ollama in a container was CPU-only and too slow). Ollama runs **natively** via Homebrew, managed as a root LaunchDaemon (`launchd/com.local.ollama.plist`, `RunAtLoad`+`KeepAlive`, bound to `0.0.0.0:11434` — survives reboot with no login required). It's installed and kept running by **Ansible**, not Komodo:

```
ansible-playbook -i inventory/inventory.ini playbooks/infrastructure/setup-macmini.yml \
  --extra-vars "bws_access_token=<TOKEN>" --tags mini-ollama
```

See `ansible-playbooks/playbooks/infrastructure/setup-macmini.yml` (`mini-ollama` tag) for install/model-pull tasks, and `group_vars/macmini_hosts.yml` (`ollama_models`) for which models get pulled. LiteLLM routes to it at `http://10.100.20.18:11434` (`apps/litellm/server/configmap.yaml` in `k3s-dean-gitops`) — currently only `nomic-embed-text` (mem0's embedder) depends on it.

`ollama/environment` and `scripts/configure-native-ollama-bind.sh` are leftovers from the never-finished llm-manager-era transition (patched a Homebrew-managed LaunchAgent plist that nothing loads anymore) — unused, safe to ignore or delete in a future cleanup.

### Komodo stack (`komodo/compose.yaml`)

| Service | Port | Purpose |
|---------|------|---------|
| Komodo Core | 9120 | GitOps UI and API (v2.1.2) |
| Komodo Periphery | 8120 (internal) | Agent for managing Docker on the host (v2.1.2) |
| FerretDB | 27017 (internal) | MongoDB-compatible database for Komodo |
| Postgres (DocumentDB) | 5432 (internal) | Storage backend for FerretDB |

Periphery uses a custom image (`Dockerfile.periphery`) that adds the `bws` CLI
for pre_deploy secret injection.

### Other (not in Compose)

| Service | Port | Purpose |
|---------|------|---------|
| Ollama | 11434 | LLM inference (native macOS, Metal GPU). **`ollama/environment`** in this repo sets **`OLLAMA_HOST=0.0.0.0:11434`** for the Homebrew service (applied on **`llm-mac-mini-m4`** / `llm/` pre-deploy). **`127.0.0.1` only** can break agent reachability depending on Docker/OrbStack networking. |
| BlueBubbles | 1234 | iMessage proxy (native macOS app) |

## Setup

Run the Ansible playbook:

```bash
ansible-playbook -i inventory/inventory.ini playbooks/infrastructure/setup-macmini.yml \
  --extra-vars "bws_access_token=<YOUR_BWS_TOKEN>"
```

The playbook handles: Homebrew, OrbStack, Ollama, system config, secrets,
Komodo + GitOps bootstrap, Tailscale, BlueBubbles install.

### Manual steps after playbook

- **Tailscale**: `ssh mini && tailscale up --accept-routes --ssh` (one-time auth)
- **Auto-login**: System Settings > Users & Groups > Automatic Login
- **BlueBubbles**: Requires GUI setup (Full Disk Access, SIP disable, server password, iMessage sign-in)

## GitOps Flow

### Architecture

```
GitHub push -> pubhooks.amer.dev (k3s Traefik proxy) -> Komodo Core (Mac Mini:9120)
                                                        +- /sync/.../sync    -> ResourceSync executes
                                                        +- /stack/<id>/deploy -> core/automation/monitoring (one webhook + stack id)
                                                        +- /stack/<id>/deploy -> runners (different stack id)
                                                        \- /stack/<id>/deploy -> llm-mac-mini-m4 (optional - separate stack id, see below)
```

### How it works

1. Push to `amerenda/komodo-dean-gitops` on `main`
2. GitHub webhooks fire (each URL is scoped to **one** Komodo stack id - see table below):
   - **ResourceSync webhook** (`/listener/github/sync/komodo-dean-gitops/sync`) - tells Komodo to re-read `resource-sync/stacks.toml` and update stack definitions
   - **Per-stack deploy webhooks** (`/listener/github/stack/<stack-uuid>/deploy`) - each triggers `docker compose up` only for that stack's `file_paths`
3. Each stack's `pre_deploy` script runs first, fetching secrets from BWS via `bws` CLI
4. Komodo runs `docker compose up -d` with the updated compose files

**Keeping `llm-mac-mini-m4` isolated from other deploys:** The stack is defined in `resource-sync/stacks.toml`; let ResourceSync pick it up, then in Komodo create a **dedicated GitHub webhook** whose path is `/listener/github/stack/<llm-mac-mini-m4-stack-uuid>/deploy` - same HMAC secret as the others. Pushes only trigger the stacks whose webhooks you configure; the `llm-mac-mini-m4` webhook does **not** deploy core, automation, monitoring, or runners. Conversely, existing deploy webhooks only touch their own stack ids, so they never pull up `llm-mac-mini-m4` unless you merge those stacks in Komodo (this repo keeps them separate).

### Webhook configuration

All webhooks are configured on the GitHub repo (`amerenda/komodo-dean-gitops`
Settings > Webhooks) and proxy through `pubhooks.amer.dev` (a k3s Traefik
IngressRoute that forwards `/listener/github/*` to the Mac Mini's Komodo Core).

| Webhook | GitHub Hook ID | Endpoint | Purpose |
|---------|---------------|----------|---------|
| ResourceSync | `606876027` | `.../sync/komodo-dean-gitops/sync` | Sync stack definitions from TOML (path updated after rename) |
| Core/Automation/Monitoring deploy | `605400567` | `.../stack/69c4863a9781f84b58ffd7a6/deploy` | Deploy core, automation, and monitoring stacks |
| Runners deploy | `606895878` | `.../stack/69c4863a9781f84b58ffd7a8/deploy` | Deploy runners stack |
| LLM deploy | *(add after sync)* | `.../stack/<llm-mac-mini-m4-stack-uuid>/deploy` | Deploy `mac-mini-m4/llm/` only - use the stack id for **`llm-mac-mini-m4`** from Komodo UI after ResourceSync imports `stacks.toml` |
| Media-server deploy (murderbot) | *(add after sync)* | `.../stack/<media-server-stack-uuid>/deploy` | Deploy `murderbot/media-server/` only - see top-level [README.md](../README.md) |

All webhooks use the `komodo-dean-webhook-secret` from BWS as the HMAC secret.

### Known issue: ResourceSync webhook does not auto-execute

As of Komodo v2.1.2, the ResourceSync `/sync` webhook authenticates successfully
but does not trigger a `RunSync` execution. This appears to be a Komodo bug
(see [moghtech/komodo#1120](https://github.com/moghtech/komodo/issues/1120)).
The stack deploy webhooks work independently, so deployments still trigger on push.
ResourceSync still runs on the 5-minute poll interval (`KOMODO_RESOURCE_POLL_INTERVAL=5-min`)
as a fallback.

### Fallback: 5-minute polling

Komodo Core polls the git repo every 5 minutes regardless of webhooks. If a
webhook fails or is missed, the sync will still happen within 5 minutes.

### Resource sync files

| File | Purpose |
|------|---------|
| `resource-sync/sync.toml` | Defines the ResourceSync resource itself (repo, branch, resource path) |
| `resource-sync/stacks.toml` | Defines the managed stacks (core, automation, monitoring, runners) with pre_deploy scripts |

Stack definitions: `resource-sync/stacks.toml` (core, automation, monitoring, runners, llm-mac-mini-m4)
Sync definition: `resource-sync/sync.toml`

## Komodo Administration

### Upgrading Komodo

1. Update `COMPOSE_KOMODO_IMAGE_TAG` in `komodo/compose.env`
2. Update the base image tag in `komodo/Dockerfile.periphery`
3. On the Mac Mini: `cd ~/komodo-dean-gitops/mac-mini-m4/komodo && docker compose --env-file compose.env build periphery && docker compose --env-file compose.env up -d`

Note: The Komodo stack is self-managed (has `komodo.skip` labels) - it does NOT
auto-deploy via webhooks. You must restart it manually or via SSH after changing
the compose.env or Dockerfile.

### Manually triggering a sync

If the ResourceSync shows "Pending" in the Komodo UI and the Execute button is
unavailable, use the API:

```bash
ssh mini
export PATH="$HOME/.orbstack/bin:$PATH"
ADMIN_PASS=$(cat ~/komodo-dean-gitops/mac-mini-m4/komodo/secrets/komodo-dean-admin-password)
JWT=$(curl -sf http://localhost:9120/auth/login/LoginLocalUser \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASS\"}" | jq -r ".data.jwt")
curl -sf http://localhost:9120/execute/RunSync \
  -H "Content-Type: application/json" \
  -H "Authorization: $JWT" \
  -d '{"sync":"komodo-dean-gitops"}'
```

## Secrets

**Bitwarden Secrets Manager (BWS) is the single source of truth for all secrets.**
No secrets in git, no secrets in GitHub repo/org settings, no manually managed files.

### How secrets flow

```
BWS -> inject-secrets.sh -> files on disk -> Docker containers read at startup
                        -> Komodo API (git provider PAT)
```

Three triggers refresh secrets:

| Trigger | Mechanism | When |
|---------|-----------|------|
| **Boot** | LaunchDaemon runs `scripts/inject-secrets.sh` | Every macOS boot, before OrbStack starts |
| **Ansible** | Playbook runs `scripts/inject-secrets.sh` | On playbook run (`mini-secrets` tag) |
| **Komodo deploy** | `stacks.toml` `pre_deploy` fetches from BWS | On stack deploy/sync via Komodo |

All three paths write to the same locations. The script is idempotent.

### Secret locations on disk

| Path | Contents | Used by |
|------|----------|---------|
| `/Users/alex/.bws-secret` | BWS access token (bootstrapped by Ansible) | inject-secrets.sh, Komodo periphery |
| `~/komodo/runner-secrets/` | GitHub App keys, DockerHub token, GitOps PAT | Runner containers (mounted as `/run/secrets`) |
| `komodo/secrets/` | DB password, passkey, JWT secret, webhook secret, admin password | Komodo Core (via `_FILE` pattern) |
| `komodo/compose.env` | Injected DB password, admin password, passkey | Komodo Compose (plaintext, required by Postgres/FerretDB) |
| `.env` | Service passwords (Pihole, Postgres, MongoDB, backups) | Services Compose |
| `bind9/keys/key.conf` | BIND9 TSIG key | BIND9 container |
| Komodo database | Git provider PAT | Komodo Core (updated via API by inject-secrets.sh) |

Generated files (not in git, created by inject-secrets.sh):
- `runners/compose.env` - non-secret runner config
- `komodo/secrets/*` - Komodo secret files
- `.env` - service passwords
- `bind9/keys/key.conf` - TSIG key

### Rotating a secret

1. Update the secret in BWS
2. Run `sudo bash scripts/inject-secrets.sh` on the Mac Mini (or re-run the Ansible playbook, or reboot)
3. Restart the affected service

The script also updates Komodo's git provider PAT via the Komodo API, so no
separate step is needed for that.

BWS secret IDs are defined in `ansible-playbooks/group_vars/macmini_hosts.yml`.

### Rules

- **NEVER** commit secrets to git
- **NEVER** set GitHub repo/org secrets - all CI secrets come from BWS via runner secret files
- **NEVER** manually create or edit secret files on disk - use BWS + inject-secrets.sh
- `compose.env` files in git contain non-secret config only; secret values are injected by the script

## Directory Structure

```
.
+-- docker-compose.yaml          # Services stack (HA, Technitium, Postgres, MongoDB, etc.)
+-- homeassistant/               # HA configuration (gitops-managed)
|   +-- configuration/           # Mounted read-only into HA container
|   \-- scripts/                 # Setup/migration scripts
+-- komodo/                      # Komodo stack (self-managed, not auto-deployed)
|   +-- compose.yaml             # Core + Periphery + FerretDB + Postgres
|   +-- compose.env              # Config (secrets injected by script)
|   +-- Dockerfile.periphery     # Periphery v2.1.2 + bws CLI
|   \-- secrets/                 # (gitignored) secret files on disk
+-- runners/                     # GitHub Actions runners stack
|   +-- compose.yaml             # repo-scoped runners (no separate llm-agents repo)
|   +-- compose.env.example      # Template for non-secret config
|   \-- entrypoint-wrapper.sh    # Reads secrets from /run/secrets into env
+-- llm/                         # llm-manager agent (native Ollama + agent container)
|   +-- compose.yaml
|   \-- pre-deploy.sh            # BWS -> llm/.env for Komodo
+-- resource-sync/               # Komodo GitOps definitions
|   +-- stacks.toml              # Stack definitions + pre_deploy scripts
|   \-- sync.toml                # ResourceSync self-definition
+-- scripts/
|   +-- inject-secrets.sh        # BWS -> disk + Komodo API (boot, ansible, manual)
|   +-- sync-stacks.sh           # Host-side git sync (OrbStack VirtFS workaround)
|   +-- backup.sh                # Backup HA, pihole, bind9 data
|   +-- healthcheck.sh           # Verify services are running
|   \-- dns-udp-proxy.py         # UDP DNS proxy with EDNS Client Subnet
+-- launchd/
|   +-- com.local.inject-secrets.plist          # Boot-time secret injection
|   +-- com.local.komodo-stack-sync.plist       # Host-side git sync (every 60s)
|   +-- com.local.pf-dns-redirect.plist         # pf DNS redirect for Technitium
|   \-- com.local.dns-udp-proxy.plist           # UDP DNS proxy daemon
+-- zigbee2mqtt/                 # Zigbee2MQTT config + smart-lighting extension
+-- mosquitto/                   # Legacy - removed; active instance runs in automation stack (automation/config/mosquitto.conf)
+-- bind9/                       # BIND9 config + zone files (disabled)
+-- pihole/                      # Pihole config (disabled)
+-- mongo/                       # MongoDB init scripts
+-- postgres/                    # Postgres init scripts (todo, agent_kb databases)
\-- whisper/                     # Whisper model cache
```

## Zigbee (Zigbee2MQTT)

Zigbee2MQTT connects to the SMLIGHT coordinator on the local network. The
smart-lighting Z2M extension (`zigbee2mqtt/external_extensions/smart-lighting.js`)
manages scene storage and wall switch behavior.

## Known Issues

### OrbStack host networking broken after reboot (v2.0.5)

OrbStack's `network_mode: host` does not correctly bridge containers to the
LAN after a macOS reboot. Containers can reach the host but not other LAN
devices (e.g., Hue Bridge, cameras). This breaks Home Assistant device
integrations.

**Workaround:** A LaunchAgent (`com.local.orbstack-lan-fix`) is installed by
the Ansible playbook. It waits for OrbStack to start, tests LAN connectivity
from a container, and restarts OrbStack if broken. No-op if networking is
already working.

### OrbStack VirtFS directory cache staleness

OrbStack's VirtFS does not reliably propagate new directory entries created by
`git pull` inside containers to the host (and vice versa). This can cause
Komodo Periphery's git operations to fail silently. The same limitation applies
to **new files under existing folders** and **edits to existing files**: bind
mounts (for example Grafana dashboard JSON under `mac-mini-m4/monitoring/grafana/`) can
stay stale until the **Grafana** container is restarted, so the UI may not show
new or updated dashboards even after Komodo deploys and you `docker compose
restart` other services.

**Workaround:** A LaunchAgent (`com.local.komodo-stack-sync.plist`) runs
`mac-mini-m4/scripts/sync-stacks.sh` every 60 seconds on the host. It does `git fetch &&
reset --hard` on the Komodo checkout (`~/komodo/stacks/...`), restarts
Periphery when the **directory tree** changes, and restarts **Grafana and
Prometheus** when any path under `mac-mini-m4/monitoring/` changed so dashboard and scrape
config updates always take effect. **Home Assistant** and **Zigbee2MQTT** use the
same `mac-mini-m4/...` prefix for `homeassistant/` and `zigbee2mqtt/` file changes.

### Komodo ResourceSync webhook does not auto-execute

The ResourceSync `/sync` webhook endpoint authenticates but does not trigger
execution. This is tracked upstream at
[moghtech/komodo#1120](https://github.com/moghtech/komodo/issues/1120).
Stack deploy webhooks work correctly. ResourceSync falls back to 5-minute polling.

### Grafana dashboards missing or never updating

Komodo `pre_deploy` writes `MONITORING_DIR=<repo>/mac-mini-m4/monitoring` into
`mac-mini-m4/monitoring/.env` so Grafana and Prometheus always bind-mount the **checked-out
tree**, not an ambiguous relative path. If dashboards still never change after
`docker compose restart`:

1. On the Mac Mini, from the GitOps repo root, confirm the files exist:
   `ls mac-mini-m4/monitoring/grafana/dashboards/Apps/app-mycroft.json` (or
   `grep Mycroft mac-mini-m4/monitoring/grafana/dashboards/_General/home.json`).
2. Recreate Grafana so bind mounts and provisioning reload cleanly (run from repo root):
   `docker compose -f mac-mini-m4/monitoring/compose.yaml up -d --force-recreate grafana`
3. Last resort (drops Grafana UI state, not Prometheus data):  
   `docker compose -f mac-mini-m4/monitoring/compose.yaml stop grafana && docker volume rm monitoring_grafana-data && docker compose -f mac-mini-m4/monitoring/compose.yaml up -d grafana`

## Health Check

```bash
./scripts/healthcheck.sh
```

## Backups

```bash
./scripts/backup.sh
# Or via cron:
# 0 3 * * * /Users/alex/komodo-dean-gitops/mac-mini-m4/scripts/backup.sh
```
