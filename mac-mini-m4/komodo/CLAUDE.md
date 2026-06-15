# komodo stack

Contains: Komodo Core, FerretDB, PostgreSQL DocumentDB.

## CRITICAL: Stack management rules

**NEVER manipulate individual komodo containers with `docker rm`, `docker stop`, or `docker kill`.**
Always use `docker compose down` / `docker compose up` for any stack lifecycle operation.

Force-removing a container that is part of a bridge network leaves a stale libnetwork endpoint in
Docker's bolt DB (`/var/lib/docker/network/files/local-kv.db`). The bolt DB is locked while
Docker runs, so the stale endpoint cannot be removed without a Docker daemon restart. Symptoms:
subsequent `docker compose up` fails with "endpoint with name <container> already exists in network".

Recovery if stale endpoint exists:
1. Rename the network in `compose.yaml` (e.g. `komodo-net` → `komodo-net-2`) so a fresh bridge is created
2. Commit and push — sync script will redeploy on the new network
3. Restart the Docker daemon (≈30s downtime, all `restart: unless-stopped` containers come back)
4. Run `docker network rm <old-network>` to clean up the stale bridge
5. Rename back to `komodo-net` in `compose.yaml` and push

## Known stale network artifact (2026-06-15)

`komodo_komodo-net` has a permanently stuck stale endpoint from a force-removed container.
The stack is currently running on `komodo_komodo-net-2`. To clean up:
- Restart the Docker daemon on mac-mini-m4 (brief service disruption, all containers auto-restart)
- Run: `docker network rm komodo_komodo-net`
- Rename `komodo-net-2` → `komodo-net` in `compose.yaml` and push

## Version pinning — DO NOT UPDATE without explicit instruction

| Service | Tag | Notes |
|---------|-----|-------|
| `komodo-core` | `${COMPOSE_KOMODO_IMAGE_TAG:-latest}` | Driven by env; "latest" is intentional for Komodo itself |
| `ferretdb` | tag-pinned | Do not bump without testing |
| `postgres-documentdb` | digest-pinned | Do not bump without testing |

Komodo Core uses `latest` by default because Komodo manages its own upgrades.
All other images in this stack are pinned — do not update them without explicit instruction.
