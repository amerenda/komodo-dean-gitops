# couchdb stack

Single-node CouchDB. Sync backend for the Obsidian "Self-hosted LiveSync"
community plugin — each device keeps a full local vault copy and
replicates through this instance. Not part of `core/`; deployed and
versioned independently like `openwebui/`.

Exposed publicly at couchdb.amer.dev via a k3s Traefik ingress
(`k3s-dean-gitops/infra/ingresses/couchdb-mini-ingress-amer-dev.yaml`)
pointing at this host's LAN IP — no vault data lives on k3s.

`local.d/livesync.ini` enables CORS and raises document/request size
limits; required for the plugin's replication and attachment sync to work.

## Version pinning — DO NOT UPDATE without explicit instruction

Image is tag-pinned. Do not bump without being asked — CouchDB replication
protocol/version mismatches between server and the plugin's expectations
can break sync silently.
