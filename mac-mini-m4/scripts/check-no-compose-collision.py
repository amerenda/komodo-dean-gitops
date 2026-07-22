#!/usr/bin/env python3
"""Fails if sync-stacks.sh runs `docker compose up/down` against a compose
file already declared in resource-sync/stacks.toml — i.e. a stack Komodo
Periphery owns. Catches the 2026-07-22 class of bug: two uncoordinated
deployers racing on the same containers, leaving zombie `Created` containers
that never start. See GITOPS_POLICY.md rule 4.

Komodo itself (mac-mini-m4/komodo/) is exempt — Komodo Core can't deploy
its own stack, so sync-stacks.sh legitimately owns that one.
"""
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
STACKS_TOML = REPO_ROOT / "resource-sync" / "stacks.toml"
SYNC_SCRIPT = REPO_ROOT / "mac-mini-m4" / "scripts" / "sync-stacks.sh"
EXEMPT_DIRS = {"komodo"}


def declared_stack_dirs() -> set[str]:
    text = STACKS_TOML.read_text()
    dirs = set()
    for path in re.findall(r'mac-mini-m4/([^/"]+)/compose\.yaml', text):
        dirs.add(path)
    return dirs - EXEMPT_DIRS


def compose_invocation_dirs() -> set[str]:
    text = SYNC_SCRIPT.read_text()
    dirs = set()
    for line in text.splitlines():
        if "compose" not in line or ("up" not in line and "down" not in line):
            continue
        for path in re.findall(r'mac-mini-m4/([^/"]+)/compose\.yaml', line):
            dirs.add(path)
    return dirs


def main() -> int:
    declared = declared_stack_dirs()
    invoked = compose_invocation_dirs()
    collisions = sorted(declared & invoked)
    if collisions:
        print(
            "GITOPS_POLICY.md rule 4 violation: sync-stacks.sh runs "
            "`docker compose up/down` against stack(s) already declared "
            f"in resource-sync/stacks.toml: {', '.join(collisions)}",
            file=sys.stderr,
        )
        print(
            "Komodo Periphery must be the sole deployer for these stacks "
            "(via GitHub stack-deploy webhooks). Remove the compose "
            "invocation from sync-stacks.sh instead.",
            file=sys.stderr,
        )
        return 1
    print(f"OK — no collisions. Komodo-declared stacks: {sorted(declared)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
