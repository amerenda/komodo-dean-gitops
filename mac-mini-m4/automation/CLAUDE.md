# automation stack

Contains: Home Assistant, Mosquitto, Zigbee2MQTT.

## Version pinning — DO NOT UPDATE without explicit instruction

| Service | Pinned version | Reason |
|---------|---------------|--------|
| `homeassistant` | `2026.7.0` | Stable; test before bumping |
| `mosquitto` | digest-pinned | Stable |
| `zigbee2mqtt` | **`2.9.1`** | **HARD LOCK — see below** |

### zigbee2mqtt — DO NOT upgrade past 2.9.1

Z2M 2.9.2+ (herdsman 10.x) triggers `RESET_SOFTWARE` on the SLZB-06MG24
EFR32 coordinator (firmware 8.0.2 b397) during `SET_CONFIGURATION_VALUE`,
crashing Z2M on every startup. Upgrading caused a multi-day crash loop
requiring firmware investigation and SLZB-OS downgrade.

**Before upgrading Z2M, the EFR32 coordinator firmware must be updated first:**
http://10.100.20.179 → Settings → Firmware update → Flash latest Zigbee coordinator firmware

After that, Z2M can be upgraded to 2.10.x+.

See `../zigbee2mqtt/CRASH_LOOP_INVESTIGATION.md` for full details.
