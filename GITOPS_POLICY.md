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

5. **A merge to main must deploy on its own — no manual `RunSync`/`DeployStack`**
   - Every `deploy = true` stack must have (a) a GitHub deploy webhook
     registered against its Komodo stack UUID
     (`pubhooks.amer.dev/listener/github/stack/<uuid>/deploy`) and (b)
     `webhook_force_deploy = true` in `[stack.config]`. Without (a) no push
     event ever reaches Komodo for that stack; without (b) a push can reach
     Komodo and still no-op instead of redeploying.
   - CI (`webhook-force-deploy` job) enforces (b) automatically. (a) has no
     automated check yet — a stack provisioned outside `infra-mcp`'s
     `provision_stateful`/`register_webhook` tools (which register the
     webhook as part of provisioning) must have its webhook added by hand
     and verified with `gh api repos/amerenda/komodo-dean-gitops/hooks`.
   - Found 2026-09-07: 9 of 13 stacks had never had a webhook registered at
     all, and the one exception with a webhook (`monitoring`) was missing
     `webhook_force_deploy` for weeks, silently breaking Pushover alerting
     with no error anywhere. This is why the checklist below calls it out
     explicitly — "the deploy webhook exists" is not sufficient evidence
     that a stack actually redeploys on merge.

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
- A new `deploy = true` stack has both a registered GitHub deploy webhook and
  `webhook_force_deploy = true` — verify with
  `gh api repos/amerenda/komodo-dean-gitops/hooks` before considering the
  stack's onboarding done.
