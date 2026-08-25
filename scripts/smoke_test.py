#!/usr/bin/env python3
"""
Komodo cluster smoke test.

Checks that every server is Ok and every deployed stack is running.
Exits 1 if any check fails; prints one line per item.

Usage:
    KOMODO_API_KEY=... KOMODO_API_SECRET=... python3 scripts/smoke_test.py
    KOMODO_URL=http://localhost:9120 ...   (default)
"""
import json
import os
import sys
import urllib.error
import urllib.request

KOMODO_URL = os.environ.get("KOMODO_URL", "http://localhost:9120")
API_KEY = os.environ.get("KOMODO_API_KEY", "")
API_SECRET = os.environ.get("KOMODO_API_SECRET", "")

# Stack states that mean "something is wrong"
STACK_BAD_STATES = {"dead", "restarting", "paused", "unknown"}
# Stack states that mean "not yet deployed / intentionally stopped — skip"
STACK_SKIP_STATES = {"not_deployed", None}
# Stacks that are run on-demand and are not expected to be always-on — skip
# regardless of state. llm-archlinux is started manually for local inference
# on that GPU and is normally stopped; that's not a health problem.
EPHEMERAL_STACKS = {"llm-archlinux"}


def komodo(path: str, body: dict | None = None) -> object:
    req = urllib.request.Request(
        f"{KOMODO_URL}/read/{path}",
        data=json.dumps(body or {}).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Api-Key": API_KEY,
            "X-Api-Secret": API_SECRET,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def main() -> int:
    failures: list[str] = []

    # ── Servers ──────────────────────────────────────────────────────────────
    try:
        servers = komodo("ListServers")
    except urllib.error.URLError as e:
        print(f"FAIL  cannot reach Komodo at {KOMODO_URL}: {e}", file=sys.stderr)
        return 1

    for s in servers:
        name = s["name"]
        state = s.get("info", {}).get("state")
        if state == "Ok":
            print(f"ok    server/{name}")
        elif state == "Disabled":
            print(f"skip  server/{name}  (disabled)")
        else:
            msg = f"server/{name}: state={state!r}"
            failures.append(msg)
            print(f"FAIL  {msg}", file=sys.stderr)

    # ── Stacks ───────────────────────────────────────────────────────────────
    stacks = komodo("ListStacks")
    for st in stacks:
        name = st["name"]
        info = st.get("info", {})
        state = info.get("state")

        if name in EPHEMERAL_STACKS:
            print(f"skip  stack/{name}  (ephemeral, state={state!r})")
            continue

        if state in STACK_SKIP_STATES:
            print(f"skip  stack/{name}  (state={state!r})")
            continue

        if state in STACK_BAD_STATES:
            msg = f"stack/{name}: state={state!r}"
            failures.append(msg)
            print(f"FAIL  {msg}", file=sys.stderr)
        else:
            print(f"ok    stack/{name}  ({state})")

    # ── Summary ───────────────────────────────────────────────────────────────
    total = len(servers) + len(stacks)
    if failures:
        print(f"\n{len(failures)}/{total} checks FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  ✗ {f}", file=sys.stderr)
        return 1

    print(f"\nAll {total} checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
