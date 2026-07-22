# GitOps Operating Policy

This repository is declarative infrastructure. If a state matters, it must be
described in git and applied through automation.

## Non-Negotiable Rules

1. **Bitwarden Secrets Manager (BWS) is the only secret source**
   - All secrets must live in BWS.
   - Secrets are fetched at deploy/runtime via approved automation (for example
     stack `pre-deploy.sh` or Ansible tasks).
   - No plaintext secrets in git, no ad-hoc local secret files, no manual
     secret injection, no parallel secret stores.

2. **No manual drift on managed hosts**
   - A freshly provisioned host must converge to the required state by running
     the documented Ansible playbook(s) and syncing this repo.
   - If you need a one-off shell command to "fix" production, that command is a
     bug in automation and must be codified immediately.
   - Any operational fix must be added to:
     - `ansible-playbooks` for host/system state, or
     - this repo for stack/resource configuration state.

3. **No "just this once" operations**
   - Do not rely on manual edits under `/etc/komodo`, manual `docker` surgery,
     or hand-tuned host config outside automation.
   - Emergency manual intervention is allowed only to restore service; it must
     be followed by a same-day PR that makes the fix reproducible.

4. **Komodo Periphery is the sole deployer of stacks it declares**
   - Any stack declared in `resource-sync/stacks.toml` may only be deployed by
     Komodo Periphery. Scripts on the host (e.g. `sync-stacks.sh`) must never
     run `docker compose up`/`down` against a Komodo-managed stack's compose
     file — two uncoordinated deployers racing on the same containers leaves
     zombie `Created` containers that never start (see 2026-07-22 runners
     incident).

## Scope Boundary: Where Changes Belong

- **Host-level concerns** (Docker daemon config, systemd units, package manager
  config, filesystem layout, firewall, kernel/runtime prerequisites) belong in
  **Ansible**.
- **Stack/app concerns** (compose files, pre-deploy behavior, ResourceSync
  definitions, stack env templates) belong in **this repo**.

## Change Acceptance Checklist

Before merging infra changes, verify all of the following:

- A new server can be provisioned from zero with Ansible and reaches the same
  operational state without manual commands.
- Required secrets are sourced from BWS and are not persisted in git.
- The runbook/docs reference automated commands, not imperative one-offs.
- Any incident-time manual command used during debugging has been converted into
  declarative automation.
