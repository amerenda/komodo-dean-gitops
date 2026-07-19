# Z2M Crash Loop Investigation — 2026-05-25

## Summary

Z2M crashes every ~7-8 seconds (after "Zigbee2MQTT started!") due to EFR32
firmware 8.0.2 b397 triggering RESET_SOFTWARE when saving the APS frame counter
to NVM. This counter always increments with each session — there is no burn-in
path. **The only permanent fix is updating the EFR32 coordinator firmware.**

---

## Root Causes (in discovery order)

### Issue 1 — SLZB-OS 3.3.1 NVM wipe — MITIGATED ✅

**SLZB-OS 3.3.1** added: *"OS will now reboot the EFR32 radios at startup"*.
This hard-resets the EFR32 on each SLZB boot, wiping its NVM state and causing
Z2M 2.9.2 to see an uninitialized coordinator → instant crash loop.

**Fix:** SLZB-OS downgraded to **3.2.4** (2026-05-25). The EFR32 is no longer
force-rebooted on SLZB startup.

### Issue 2 — Corrupted coordinator_backup.json — MITIGATED ✅

Z2M 2.9.2 (herdsman 10.0.5) wrote `coordinator_backup.json` with
`"frame_counter": 18,161,670` and `"devices": []` during the crash loop.
Z2M 2.9.1 was restoring this corrupted backup to EFR32 on every startup,
which tried to write the large frame counter value to EFR32 NVM, triggering
RESET_SOFTWARE at T+7s.

**Fix (2026-05-25/26):** Deleted `coordinator_backup.json`. A new backup was
created during a brief stable session with `"frame_counter": 40,230,913`.
Reset the backup's `frame_counter` to **0** so herdsman never writes a
frame counter to EFR32 (EFR32's counter is always ≥ 0 → no write needed).

### Issue 3 — APS frame counter NVM save — REQUIRES EFR32 FIRMWARE UPDATE ⚠️

After Z2M completes startup ("Zigbee2MQTT started!"), it immediately sends APS
frames to reconnect with Zigbee devices (state retrieval, discovery). Each APS
frame increments EFR32's APS frame counter in RAM. EmberZNet defers saving the
counter to NVM flash for ~5-8 seconds (to batch writes and reduce flash wear).

In **EFR32 firmware 8.0.2 b397** (the stable build as of 2025-02-12), this
deferred NVM write triggers **RESET_SOFTWARE**, crashing Z2M.

Unlike configuration tokens (which are identical each session and can "burn in"
after a successful write), the APS frame counter **always changes** between
sessions — it's a monotonically increasing counter by design. There is no
convergence path. Z2M will always crash at T+7-8s with this firmware.

**Evidence:**
- Crash consistently at T+7-8s after "started!" across all sessions
- RESET_SOFTWARE arrives spontaneously — no EZSP command was sent in the 5s
  before the crash (confirmed in debug logs: last activity was a
  `MESSAGE_SENT_HANDLER` callback, then silence until RSTACK)
- The crash follows APS frame sends (state retrieval, SEND_UNICAST) at T+2-5s
- Setting `frame_counter: 0` in coordinator_backup.json (Issue 2 fix) did NOT
  stop the T+7-8s crash — confirms APS counter (not NWK backup counter) is the
  trigger

---

## Current Crash Timeline

```
T+0s   : Docker restarts Z2M
T+0-45s: slzb-proxy drain period (EFR32 NVM crash loop plays out in isolation)
T+45s  : Z2M connects to slzb-proxy
T+45-52s: herdsman init — ASH RST, SET_CONFIGURATION_VALUE, SET_POLICY,
          SET_MULTICAST_TABLE_ENTRY, FORM/JOIN network
T+~50s : Zero to three RESET_SOFTWARE events during init — herdsman handles
          each with a re-init retry (up to 5 retries)
T+~58s : "Zigbee2MQTT started!"
T+~65s : Z2M sends first APS frames (state retrieval for known devices)
T+~66s : EFR32's NVM save timer fires → tries to save incremented APS frame
          counter to flash → RESET_SOFTWARE (8.0.2 b397 bug)
T+~66s : "Adapter disconnected, stopping" → Z2M process exits
T+~67s : Docker restarts Z2M
… repeat …
```

---

## ⚠️ REQUIRED ACTION: Update EFR32 Coordinator Firmware

**Go to http://10.100.20.179 → Settings → Firmware update → Flash latest
Zigbee coordinator firmware**

- **Stable build (20250212):** EFR32 8.0.2 b397 — this is what's currently
  installed. **DO NOT reinstall — it has the bug.**
- **Dev builds:** Three dev builds are available. Any of these likely fix the
  NVM-write RESET_SOFTWARE bug. The risk of trying a dev build is low (Z2M is
  already fully broken with the stable build).

After updating EFR32 firmware:
1. Restart Z2M: `docker restart zigbee2mqtt`
2. Check that Z2M stays up past T+30s after "started!" in the log
3. If scenes didn't survive, delete `sl-pushed-hash.json` to trigger re-push:
   ```bash
   docker run --rm -v services_zigbee2mqtt-data:/data alpine \
     rm -f /data/sl-pushed-hash.json
   docker restart zigbee2mqtt
   ```

---

## Fixes Applied

### 1. Removed startup scene push (`smart-lighting.js`, commit 3de6e40)

Extension had `setTimeout(() => this._fullScenePush(), 5000)` on every start.
Each `scene_add` → `SET_MULTICAST_TABLE_ENTRY` → RESET_SOFTWARE → crash.

**Fix:** Startup push removed. Hash-based guard added. HA's periodic
`zigbee2mqtt/sl/config` push only triggers `_fullScenePush()` if config hash
changed since the last successful push.

### 2. Removed stray ingress (commit 553c3ca)

`infra/ingresses/z2m-ingress-amer-dev.yaml` had wrong IP and wrong repo. Deleted.

### 3. Cleared stale MQTT retained extension message

Z2M stores extension code as a retained MQTT message on
`zigbee2mqtt/bridge/extensions`. If Z2M crashes with new file code, the retained
message (old code) overrides it on restart:

```bash
docker stop zigbee2mqtt
docker exec mosquitto mosquitto_pub -h 127.0.0.1 -p 1883 \
  -t 'zigbee2mqtt/bridge/extensions' -n -r
docker start zigbee2mqtt
```

### 4. Downgraded SLZB-OS to 3.2.4

Via http://10.100.20.179 → Settings → Core firmware. Stops EFR32 being
force-rebooted on each SLZB startup (Issue 1 mitigated).

### 5. Deleted corrupted coordinator_backup.json (2026-05-25)

The corrupted backup (18M frame counter, empty devices) was deleted. A new clean
backup was created. Then reset `network_key.frame_counter` to 0 (Issue 2 mitigated):

```bash
# One-time: zero the frame counter in the backup so herdsman never tries to restore
# a high counter to EFR32 (which would trigger an unnecessary NVM write)
docker run --rm -v services_zigbee2mqtt-data:/data alpine \
  sh -c 'cat /data/coordinator_backup.json | sed "s/\"frame_counter\": [0-9]*/\"frame_counter\": 0/" > /tmp/tmp.json && mv /tmp/tmp.json /data/coordinator_backup.json'
```

Note: herdsman will overwrite this with the current counter on clean shutdown.
If the counter grows large again and crashes resume, repeat this step.

### 6. slzb-proxy.py — keep-alive proxy with drain cycle (2026-05-25)

`slzb-proxy.py` acts as a TCP proxy between Z2M and SLZB-06, providing:
- **Drain cycle:** After each Z2M disconnect, closes and reopens the SLZB TCP
  connection (20s quiet period for EFR32 NVM crash loop to play out), then holds
  the connection for 25s more, discarding stale RSTACK frames. Total: ~45s.
- **Stale connection detection:** Sessions < 5s are silently skipped — these are
  Z2M instances that crashed before the proxy accepted their connection.
- **Keep-alive:** The SLZB TCP connection stays alive across Z2M disconnects,
  preventing HOST_FATAL_ERROR from stale RSTACK data on reconnect.

Deployed: `~/docker/zigbee2mqtt/slzb-proxy.py` on mac-mini-m4.
Log: `~/docker/zigbee2mqtt/slzb-proxy.log`.
Autostart via launchd: `launchd/com.local.slzb-proxy.plist` (LaunchDaemon,
`RunAtLoad` + `KeepAlive`, installed 2026-07-19). Without this the proxy only
ran until the next host reboot, silently losing the crash-loop mitigation —
this happened at least once (2026-07-19) and the crash loop reappeared within
minutes of the coordinator reconnecting directly.

---

## Architecture

```
[Z2M container] → tcp://127.0.0.1:6639 → [slzb-proxy.py] → tcp://10.100.20.179:6638
                                                                → [SLZB-06MG24 (ESP32)]
                                                                    → [EFR32MG24 Zigbee]
```

**Scenes stored in bulb flash** — survive Z2M restarts, coordinator resets, and
power cycles. HA is NOT in the lighting critical path. Switches → scene_recall
ZCL → bulb applies stored scene directly.

---

## Upgrade Path

1. ✅ Downgrade SLZB-OS to 3.2.4
2. ✅ Delete / reset corrupted coordinator_backup.json
3. ✅ Pin Z2M at 2.9.1 (see `automation/CLAUDE.md`)
4. ⬜ **Update EFR32 coordinator firmware** — the only remaining required action
5. ⬜ After EFR32 update: optionally upgrade SLZB-OS back to 3.3.1+
6. ⬜ After EFR32 update: upgrade Z2M to 2.9.2+ (remove pin in `automation/CLAUDE.md`)

**DO NOT upgrade Z2M past 2.9.1 until EFR32 firmware is updated.** Herdsman 10.x
(Z2M 2.9.2+) also triggers RESET_SOFTWARE on EFR32 8.0.2 b397 via
SET_CONFIGURATION_VALUE, which causes an immediate crash loop even worse than 2.9.1.
