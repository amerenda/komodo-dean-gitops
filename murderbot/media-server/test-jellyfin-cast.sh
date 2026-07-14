#!/usr/bin/env bash
# Tests that Jellyfin is properly configured for Google Cast (Chromecast).
#
# Cast flow: phone app → Google Cast SDK → receiver app (runs on display, from gstatic.com)
#   → receiver makes API calls to Jellyfin. CORS must allow non-media.amer.dev origins.
#
# Run from murderbot: ./test-jellyfin-cast.sh
# Exit 0 = all checks pass, exit 1 = one or more failures.

set -euo pipefail

JELLYFIN_URL="${JELLYFIN_URL:-http://localhost:8096}"
PASS=0
FAIL=0

ok()   { echo "  PASS: $*"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $*"; FAIL=$((FAIL+1)); }

echo "=== Jellyfin Google Cast health checks ==="
echo "Server: $JELLYFIN_URL"
echo ""

# 1. Server reachable
echo "[1] Server reachable"
if curl -sf "$JELLYFIN_URL/System/Info/Public" >/dev/null; then
    ok "Jellyfin responds on $JELLYFIN_URL"
else
    fail "Jellyfin not reachable at $JELLYFIN_URL"
fi

# 2. CORS — Cast receiver origin (gstatic.com)
# Google Cast receiver apps are hosted on Google CDN; they send this Origin header.
echo ""
echo "[2] CORS — Cast receiver origin (gstatic.com)"
CORS_HEADER=$(curl -si "$JELLYFIN_URL/System/Info/Public" \
    -H "Origin: https://www.gstatic.com" \
    | grep -i "^access-control-allow-origin:" || true)
if echo "$CORS_HEADER" | grep -q "\*\|https://www.gstatic.com"; then
    ok "CORS allows gstatic.com origin: $CORS_HEADER"
else
    fail "CORS blocked for gstatic.com — no Access-Control-Allow-Origin header. Cast receiver calls will be blocked."
fi

# 3. CORS — null origin (Cast runtime sometimes sends this from receiver app context)
echo ""
echo "[3] CORS — null origin"
CORS_NULL=$(curl -si "$JELLYFIN_URL/System/Info/Public" \
    -H "Origin: null" \
    | grep -i "^access-control-allow-origin:" || true)
if echo "$CORS_NULL" | grep -q "\*"; then
    ok "CORS allows null origin: $CORS_NULL"
else
    fail "CORS blocked for null origin. Some Cast clients may fail."
fi

# 4. CORS preflight (OPTIONS) for Cast API calls
echo ""
echo "[4] CORS preflight (OPTIONS) — Cast receiver API calls"
PREFLIGHT_STATUS=$(curl -so /dev/null -w "%{http_code}" -X OPTIONS "$JELLYFIN_URL/System/Info/Public" \
    -H "Origin: https://www.gstatic.com" \
    -H "Access-Control-Request-Method: GET" \
    -H "Access-Control-Request-Headers: Authorization,Content-Type")
if [[ "$PREFLIGHT_STATUS" == "204" || "$PREFLIGHT_STATUS" == "200" ]]; then
    ok "CORS preflight returns $PREFLIGHT_STATUS"
else
    fail "CORS preflight returned $PREFLIGHT_STATUS (expected 204/200)"
fi

# 5. CorsHosts config is not restrictive (must be * or absent for Cast to work)
echo ""
echo "[5] CorsHosts config allows wildcard"
CORS_CONFIG=$(grep -A3 "<CorsHosts>" /mnt/storage/media/config/jellyfin/config/system.xml 2>/dev/null || true)
if echo "$CORS_CONFIG" | grep -q "<string>\*</string>"; then
    ok "CorsHosts set to wildcard (*)"
else
    fail "CorsHosts is restrictive — Cast will be broken. Current value: $(echo "$CORS_CONFIG" | tr -d '\n')"
fi

# 6. Cast receiver app IDs are configured (Jellyfin requires registered app IDs)
echo ""
echo "[6] Cast receiver app IDs configured"
STABLE_ID=$(grep "F007D354" /mnt/storage/media/config/jellyfin/config/system.xml 2>/dev/null || true)
if [[ -n "$STABLE_ID" ]]; then
    ok "Stable Cast receiver app ID (F007D354) present"
else
    fail "Stable Cast receiver app ID missing from system.xml"
fi

# 7. Local network server URI — Cast device needs a reachable stream URL
echo ""
echo "[7] Jellyfin reports a reachable local address"
LOCAL_ADDR=$(curl -sf "$JELLYFIN_URL/System/Info/Public" | python3 -c "import sys,json; print(json.load(sys.stdin).get('LocalAddress',''))" 2>/dev/null || true)
if [[ -n "$LOCAL_ADDR" ]]; then
    ok "LocalAddress: $LOCAL_ADDR"
    # Verify that address is actually reachable
    LOCAL_HOST=$(echo "$LOCAL_ADDR" | sed 's|http://||;s|https://||;s|/.*||')
    LOCAL_IP="${LOCAL_HOST%%:*}"
    LOCAL_PORT="${LOCAL_HOST##*:}"
    if timeout 3 bash -c ">/dev/tcp/$LOCAL_IP/$LOCAL_PORT" 2>/dev/null; then
        ok "LocalAddress $LOCAL_ADDR is reachable (TCP connect ok)"
    else
        fail "LocalAddress $LOCAL_ADDR is NOT reachable — Cast device won't be able to stream"
    fi
else
    fail "Could not determine LocalAddress from Jellyfin API"
fi

# 8. Port 8096 is accessible on the host's LAN IP (Cast device connects directly)
# Use TCP connect rather than ss — ss -tlnp can produce false negatives when
# Docker's userland proxy isn't used (iptables-only mode) or when called without
# sufficient privileges to enumerate processes.
echo ""
echo "[8] Jellyfin port 8096 accessible on LAN IP"
HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if timeout 3 bash -c ">/dev/tcp/${HOST_IP}/8096" 2>/dev/null; then
    ok "Port 8096 is accessible on LAN IP ${HOST_IP} (TCP connect ok)"
else
    fail "Port 8096 not reachable on ${HOST_IP} — Cast device won't be able to connect directly"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
