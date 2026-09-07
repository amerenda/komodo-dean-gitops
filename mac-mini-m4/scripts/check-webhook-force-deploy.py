#!/usr/bin/env python3
"""Fails if a deploy=true stack in resource-sync/stacks.toml is missing
webhook_force_deploy = true. Without it, a stack's GitHub deploy webhook can
fire on push and still no-op instead of actually redeploying -- see
GITOPS_POLICY.md rule 5. Catches the 2026-09-07 class of bug: 9 of 13 stacks
had no registered webhook at all, and the one that did have a webhook but
lacked this flag (monitoring, before it was fixed) silently no-op'd for
days, breaking Pushover alerting with no visible error anywhere.

This only checks the flag is present and true for stacks that opt into
push-triggered deploys (deploy = true). Stacks with deploy = false (e.g.
img-murderbot, controlled exclusively via the gpu-switcher API) are exempt
by design -- they intentionally never deploy on push.
"""
import re
import sys
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
STACKS_TOML = REPO_ROOT / "resource-sync" / "stacks.toml"


def main() -> int:
    data = tomllib.loads(STACKS_TOML.read_text())
    violations = []
    for stack in data.get("stack", []):
        name = stack.get("name", "<unnamed>")
        if not stack.get("deploy", False):
            continue
        config = stack.get("config", {})
        if not config.get("webhook_force_deploy", False):
            violations.append(name)

    if violations:
        print(
            "GITOPS_POLICY.md rule 5 violation: deploy=true stack(s) missing "
            f"webhook_force_deploy = true: {', '.join(sorted(violations))}",
            file=sys.stderr,
        )
        print(
            "Add `webhook_force_deploy = true` to [stack.config] for each -- "
            "without it, a push can fire the deploy webhook and still no-op "
            "instead of redeploying.",
            file=sys.stderr,
        )
        return 1

    deploy_true = sorted(s.get("name") for s in data.get("stack", []) if s.get("deploy", False))
    print(f"OK — webhook_force_deploy set on every deploy=true stack: {deploy_true}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
