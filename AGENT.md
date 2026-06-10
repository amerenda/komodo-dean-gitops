# komodo-dean-gitops — Agent Rules

## What this repo is

GitOps manifests for all **stateful** services running on Mac Mini via Komodo. If a service has no local state, it belongs in `k3s-dean-gitops` instead.

A LaunchDaemon on Mac Mini runs `git pull` every 60 seconds and restarts changed Komodo stacks. Push to main — the service is live within 60 seconds.

## When to use this repo

Use Komodo (this repo) for services that:
- Need persistent Docker volumes or local storage
- Access host hardware (GPU, USB, serial ports)
- Run on the Mac Mini specifically (network services, HA integrations, Ollama)

Everything else goes to k3s.

## How to add a new stateful service

1. Call `scaffold_app(name, description, app_type='stateful')` from infra-mcp — returns a compose service stub.
2. Add the stub to the appropriate `mac-mini-m4/<stack>/compose.yaml`.
3. If the service needs a database or generated secrets: call `provision_app(name)` first (creates DB + writes secrets to BWS).
4. Reference secrets in the compose file with `${SECRET_NAME}` syntax — Komodo injects them from BWS at deploy time.
5. Commit and push to main.

Use `resolve_secret_name` from infra-mcp to look up a BWS secret value by name — never hardcode BWS UUIDs in compose files.

## Secrets in compose files

Secrets use `${SECRET_NAME}` — never hardcoded values. Komodo syncs from BWS at deploy time and injects the env. Example:

```yaml
services:
  myservice:
    environment:
      - DB_PASSWORD=${MYSERVICE_DB_PASSWORD}
```

The corresponding BWS key name is what you pass to `resolve_secret_name` to verify the secret exists before deploying.

## Docker volumes

Named volumes declared in compose files are created automatically by Docker on first start. Do **not**:
- Mark them `external: true` unless the volume was created by a separate system
- Pre-create volumes with Ansible
- Use absolute host paths (use named volumes instead)

## Version pinning — critical

All image tags in every compose.yaml are pinned intentionally. Never update a version tag without being explicitly asked and confirming the target version. Unpinned bumps have caused production outages (e.g., Zigbee2MQTT 2.9.2 broke Zigbee requiring full recovery).

## Stacks (mac-mini-m4)

| Directory | Services |
|-----------|----------|
| `automation/` | Home Assistant, Mosquitto, Zigbee2MQTT |
| `core/` | DNS, pgvector, MongoDB |
| `komodo/` | Komodo Core |
| `llm/` | Ollama, LLM Manager |
| `monitoring/` | Prometheus, Grafana |

## Ports and network_mode

Check existing services before assigning ports — conflicts with `network_mode: host` services will silently fail. Run `grep -r "ports:" mac-mini-m4/` to see what's in use.

## Never

- SSH into mac-mini-m4 and edit files directly
- Run `docker compose` or `git pull` manually on the host
- Use Ansible to deploy services or create volumes
- Hardcode BWS secret UUIDs in compose files or Komodo stack configs
