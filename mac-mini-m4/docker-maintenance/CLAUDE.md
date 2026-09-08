# docker-maintenance stack

Scheduled Docker housekeeping jobs for mac-mini-m4.

## Services

| Service | Schedule | What it does |
|---------|----------|-------------|
| `docker-prune` | Weekly Sun 03:00 | `docker builder prune -a -f` — removes all unused build cache |
| `docker-prune` | Weekly Sun 03:15 | `docker image prune -f` — removes dangling/untagged images |

## Why this exists

Docker build cache grew to 12.45 GB from CI runner image builds and caused a disk-full incident
that crashed Home Assistant, Prometheus, and Komodo simultaneously (2026-07-12). The prune runs
weekly to keep build cache from accumulating between CI runs.

The image prune was added 2026-09-08 after a disk-space audit found 2.35GB of dangling `<none>`
images (old build/pull layers superseded by newer ones) that the build-cache prune never touched —
build cache and images are separate `docker system df` buckets.

## Version pinning

`docker:27-cli` — do not bump without explicit instruction.
