# docker-maintenance stack

Scheduled Docker housekeeping jobs for mac-mini-m4.

## Services

| Service | Schedule | What it does |
|---------|----------|-------------|
| `docker-prune` | Weekly Sun 03:00 | `docker builder prune -a -f` — removes all unused build cache |

## Why this exists

Docker build cache grew to 12.45 GB from CI runner image builds and caused a disk-full incident
that crashed Home Assistant, Prometheus, and Komodo simultaneously (2026-07-12). The prune runs
weekly to keep build cache from accumulating between CI runs.

## Version pinning

`docker:27-cli` — do not bump without explicit instruction.
