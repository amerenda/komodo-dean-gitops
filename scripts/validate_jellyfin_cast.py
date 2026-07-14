#!/usr/bin/env python3
"""
Static validator for Jellyfin Google Cast configuration.

Checks that the gitops repo maintains the settings required for Cast
streaming to Google Home / Chromecast devices. Catches regressions
before they reach the deployed stack.

Exits 0 if all checks pass, 1 if any fail.
"""
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
MEDIA = REPO_ROOT / "murderbot" / "media-server"

PASS = 0
FAIL = 0


def ok(msg: str) -> None:
    global PASS
    print(f"  PASS: {msg}")
    PASS += 1


def fail(msg: str) -> None:
    global FAIL
    print(f"  FAIL: {msg}", file=sys.stderr)
    FAIL += 1


# ── 1. compose.yaml: mem_swappiness=0 on jellyfin ────────────────────────────
print("[1] compose.yaml — jellyfin mem_swappiness=0")
compose = MEDIA / "compose.yaml"
if not compose.exists():
    fail(f"{compose} not found")
else:
    text = compose.read_text()
    # Find the jellyfin service block and confirm mem_swappiness: 0
    # Strategy: locate the jellyfin: stanza and scan until the next top-level service
    in_jellyfin = False
    found_swappiness = False
    for line in text.splitlines():
        if re.match(r"^  jellyfin:", line):
            in_jellyfin = True
        elif re.match(r"^  \w+:", line) and "jellyfin" not in line:
            in_jellyfin = False
        if in_jellyfin and re.match(r"\s+mem_swappiness:\s*0", line):
            found_swappiness = True
            break
    if found_swappiness:
        ok("jellyfin service has mem_swappiness: 0")
    else:
        fail(
            "jellyfin service is missing mem_swappiness: 0 — "
            "Jellyfin will swap under memory pressure, causing HLS segment stalls "
            "that break Chromecast streaming"
        )

# ── 2. compose.yaml: JELLYFIN_PublishedServerUrl present ──────────────────────
print("")
print("[2] compose.yaml — JELLYFIN_PublishedServerUrl is set")
if compose.exists():
    if "JELLYFIN_PublishedServerUrl" in compose.read_text():
        ok("JELLYFIN_PublishedServerUrl env var is present in compose.yaml")
    else:
        fail(
            "JELLYFIN_PublishedServerUrl missing from compose.yaml — "
            "Jellyfin will advertise 'localhost' as its address to Cast devices"
        )

# ── 3. pre-deploy.sh: JELLYFIN_URL has http(s):// prefix ─────────────────────
print("")
print("[3] pre-deploy.sh — JELLYFIN_URL has a valid http(s):// prefix")
predeploy = MEDIA / "pre-deploy.sh"
if not predeploy.exists():
    fail(f"{predeploy} not found")
else:
    text = predeploy.read_text()
    match = re.search(r'JELLYFIN_URL=([^\n"\']+)', text)
    if not match:
        fail("JELLYFIN_URL not found in pre-deploy.sh")
    else:
        url = match.group(1).strip().strip('"\'')
        if url.startswith("http://") or url.startswith("https://"):
            ok(f"JELLYFIN_URL={url!r} has valid protocol prefix")
        else:
            fail(
                f"JELLYFIN_URL={url!r} has no http(s):// prefix — "
                "Jellyfin will ignore it and fall back to advertising 'localhost', "
                "breaking Cast device stream URLs"
            )

# ── 4. network.xml: KnownProxies does NOT include LAN subnet ─────────────────
print("")
print("[4] network.xml — KnownProxies does not include 10.100.20.0/24 (LAN)")
net_xml = MEDIA / "config" / "jellyfin-config" / "network.xml"
if not net_xml.exists():
    fail(f"{net_xml} not found — network.xml must be committed so pre-deploy.sh can enforce it")
else:
    try:
        tree = ET.parse(net_xml)
        root = tree.getroot()
        proxies = [e.text for e in root.findall("KnownProxies/string") if e.text]
        lan_in_proxies = any("10.100.20" in p for p in proxies)
        if lan_in_proxies:
            fail(
                f"KnownProxies contains LAN subnet: {proxies} — "
                "Jellyfin treats Google Home Display as a reverse proxy, breaking "
                "PublishedServerUri selection for Cast connections"
            )
        else:
            ok(f"KnownProxies={proxies} (LAN subnet not listed as proxy)")
    except ET.ParseError as e:
        fail(f"network.xml is not valid XML: {e}")

# ── 5. network.xml: PublishedServerUriBySubnet maps LAN to a valid URL ────────
print("")
print("[5] network.xml — PublishedServerUriBySubnet maps LAN to a valid URL")
if net_xml.exists():
    try:
        tree = ET.parse(net_xml)
        root = tree.getroot()
        entries = [e.text for e in root.findall("PublishedServerUriBySubnet/string") if e.text]
        lan_entry = next((e for e in entries if "10.100.20" in e), None)
        if not lan_entry:
            fail(
                "No PublishedServerUriBySubnet entry for 10.100.20.0/24 — "
                "Cast devices on the LAN won't get the correct stream URL"
            )
        else:
            # Expect format: subnet=http(s)://address:port
            parts = lan_entry.split("=", 1)
            if len(parts) == 2 and (parts[1].startswith("http://") or parts[1].startswith("https://")):
                ok(f"LAN subnet maps to {parts[1]!r}")
            else:
                fail(
                    f"LAN PublishedServerUri {lan_entry!r} has no http(s):// prefix — "
                    "Cast devices will receive a malformed stream URL"
                )
    except ET.ParseError:
        pass  # already failed above

# ── 6. network.xml: Cast receiver app IDs present in system.xml path note ─────
# system.xml is not checked into gitops (it's too dynamic), but we can check
# that the gitops-managed files don't accidentally delete Cast config.
# Cast IDs (F007D354, 6F511C87) must not be stripped by any pre-deploy action.
print("")
print("[6] pre-deploy.sh — does not overwrite system.xml")
if predeploy.exists():
    text = predeploy.read_text()
    if "system.xml" in text:
        fail(
            "pre-deploy.sh references system.xml — verify it does not overwrite "
            "Cast receiver app IDs (F007D354, 6F511C87)"
        )
    else:
        ok("pre-deploy.sh does not touch system.xml (Cast IDs preserved)")

# ── Summary ───────────────────────────────────────────────────────────────────
total = PASS + FAIL
print("")
print(f"=== Results: {PASS} passed, {FAIL} failed ===")
sys.exit(0 if FAIL == 0 else 1)
