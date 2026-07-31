# Home Assistant Configuration

All Home Assistant configuration is managed via GitOps through the `komodo-dean-gitops` repo (`mac-mini-m4/homeassistant/`). Files in `configuration/` are bind-mounted read-only into the HA container (see `../automation/compose.yaml`). That includes `python_scripts/` for Smart Lighting persistence — commit and deploy like any other config; no manual copy. Changes go through git, not the HA UI.

**Scenes:** `scenes.yaml` is **not** bind-mounted. `configuration.yaml` still uses `scene: !include scenes.yaml`, but the real file lives on the `ha-config` Docker volume. `hacs-init` seeds an empty `[]` if the file is missing so HA starts cleanly. Create and edit scenes in the HA UI; they persist on the volume, not in git. The copy under `configuration/scenes.yaml` in the repo is reference-only.

**Smart Lighting → Zigbee2MQTT:** `script.sl_push_config` publishes over MQTT. If Mosquitto restarts or HA loses the MQTT connection, Force Sync can fail silently until MQTT reconnects — check **Settings → Devices & services → MQTT** and HA logs.

Config pushes are triggered automatically by these automations (all in `automations/`):

| Automation | Trigger | Why |
|---|---|---|
| `sl_push_config_on_sl_enabled` | `sl_enabled` toggles | Z2M only reads `sl_enabled` from retained MQTT config |
| `sl_push_config_on_smart_power` | `sl_*_smart_power_on` helpers change | Smart wall switch flag needs to reach Z2M |
| `sl_push_config_on_schedule_change` | Any window start time or day-profile helper changes | Keeps Z2M window schedule in sync when edited in dashboard |
| `sl_push_config_on_ha_start` | HA starts (45 s delay) | Pushes fresh config after restart; Z2M disk cache may be stale |

## Smart Lighting v2

A fully UI-configurable lighting system that automatically applies the correct Hue scene based on the time of day, regardless of how lights are triggered (voice, physical switch, Hue dimmer, motion sensor, automation, or timer).

### Dashboard

The **Smart Lighting** dashboard in the HA sidebar provides full control over the system. No YAML editing is needed for day-to-day configuration.

### How It Works

```
Any trigger (voice, switch, motion, timer)
  → light turns on
  → state-change automation fires
  → determines current time window (morning/day/evening/night)
  → checks weekday vs weekend schedule
  → activates scene.<room>_<window>
```

Scenes follow the naming convention `scene.<room>_<window>` (e.g., `scene.living_room_evening`). These are Hue scenes created on the Hue Bridge and discovered by HA automatically.

### Settings Reference

#### Global Settings (Top Bar)

| Setting | What It Does |
|---------|-------------|
| **Smart Lighting** (`sl_enabled`) | Master toggle for the entire v2 system. When OFF, all v2 automations are disabled and the v1 lighting system takes over. Turn OFF to instantly revert to the previous lighting behavior without any other changes. |
| **Current Window** (`sensor.sl_current_window`) | Read-only indicator showing which time window is currently active (morning, day, evening, or night). Derived from the current time, the weekday/weekend schedule, and which days are configured as weekend days. Updates automatically. |
| **House Mode** (`sl_house_mode`) | Controls how the system behaves globally. Options: **Home** — normal operation, all automations active, scenes applied based on time window. **Away** — lights are turned off when triggered (intended for when nobody is home; future: security-only behavior). **Sleep** — only rooms with night motion enabled will activate; all other rooms stay off. **Guest** — same as Home (future: guest-specific scene preferences). |

#### Schedule

The schedule defines when each time window starts. There are separate schedules for weekday and weekend days.

| Setting | What It Does |
|---------|-------------|
| **Morning Start** | The time the "morning" window begins. Before this time, the "night" window is active. Default: 06:00 weekday, 08:00 weekend. |
| **Day Start** | The time the "day" window begins. Default: 09:00 weekday, 10:00 weekend. |
| **Evening Start** | The time the "evening" window begins. Default: 17:00 weekday, 18:00 weekend. |
| **Night Start** | The time the "night" window begins. Runs until the next morning start. Default: 22:00 weekday, 23:00 weekend. |

The weekend schedule is used on days marked as weekend days. This lets you have later morning/night times on weekends without affecting your weekday routine.

#### Weekend Days

By default, Saturday and Sunday use the weekend schedule. Toggle any day on to make it use the weekend schedule instead of the weekday schedule. Use cases:

- You work a non-standard schedule (e.g., Tuesday–Saturday) — set Sunday and Monday as weekend days
- You have a day off mid-week — temporarily toggle that day to weekend
- Holiday week — toggle all days to weekend

#### Per-Room Settings

Select a room from the dropdown to configure its behavior.

| Setting | What It Does |
|---------|-------------|
| **Motion Triggers (Morning/Day/Evening/Night)** | Controls whether a motion sensor in this room will trigger the lights during each time window. Each window can be independently enabled or disabled. For example, enable night motion in the bathroom (so lights come on when you walk in at 2am) but disable it in the bedroom (so motion doesn't wake your partner). Motion sensors are not yet installed — these toggles are ready for when they are. |
| **Motion Timeout (min)** | How many minutes after motion stops before the lights automatically turn off. Only applies to motion-triggered activations. Range: 1–60 minutes. Default: 5 minutes. |
| **Auto Transition** | When enabled, if the lights in this room are already on when a time window boundary is reached (e.g., 5pm weekday = evening starts), the scene automatically transitions to the new window's scene. When disabled, lights stay on their current scene until manually changed or turned off and back on. |
| **Smooth Transition** | When enabled, scene transitions at window boundaries will gradually fade from the current scene to the new scene instead of switching instantly. **Not yet implemented** — the toggle exists and is saved, but the gradual transition logic will be added in a future update. Currently behaves the same as Auto Transition (instant switch). |
| **Transition Duration (min)** | How long a smooth transition takes, in minutes. Only applies when Smooth Transition is enabled. Range: 1–30 minutes. Default: 10 minutes. For example, at 10 minutes, the lights will gradually shift from the current scene to the new scene over a 10-minute period at each window boundary. **Not yet implemented** — saved for when smooth transition logic is added. |
| **Override Active** | Shows whether a manual override is currently active for this room. An override is set when someone explicitly requests specific lighting parameters (e.g., "set lights to full brightness" via voice). While override is active, the system will not apply time-based scenes to this room. **Override automatically clears at the next time window transition.** You can also manually toggle this off to resume normal scene behavior immediately. |

### Adding a New Room

1. Add scene brightness/CT helpers: `helpers/generated/input_number/sl_<room>.yaml` — four windows × (brightness, color_temp, color_x, color_y)
2. Add toggle helpers: `helpers/generated/input_boolean/sl_<room>.yaml` — motion per window, auto/smooth transition, override, smart_power_on, multi-room flags
3. Add motion timeout: `helpers/generated/input_number/sl_<room>.yaml` (if not combined above)
4. Add scene-name helpers: `helpers/generated/input_text/sl_<room>.yaml`
5. Add button-action helpers: `helpers/generated/input_select/sl_<room>.yaml` (b1_short, b1_long … b4_short, b4_long)
6. Add the room to `input_select/sl_global.yaml` → `sl_room_selector` options
7. Add the room's light entity mapping in `scripts/set_bulb_defaults.yaml` → `room_lights`
8. Add the room's switch config to `scripts/sl_push_config.yaml` (switches section)
9. Add conditional cards to `dashboards/smart_lighting.yaml` (Controls, Scene Editor, Custom Scenes, Switches tabs)
10. Commit, push, deploy — `sl_push_config_on_ha_start` will sync Z2M on next HA restart, or use Force Sync

### Switching Between v1 and v2

Toggle `input_boolean.sl_enabled` (the "Smart Lighting" toggle on the dashboard):

- **ON**: v2 automations are active. Lights trigger scenes based on time window, schedule, and house mode.
- **OFF**: v2 automations are completely disabled. The existing v1 scripts (`scheduled_light_on`, `room_toggle`, etc.) continue to work as before. No v2 logic runs.

Both systems coexist — all v2 helpers use the `sl_` prefix and do not conflict with v1 helpers. You can switch back and forth at any time.

### Runtime split (HA = config, Z2M = runtime)

Smart Lighting is intentionally split:

- **Home Assistant** stores scene values in helpers and pushes the full config to Z2M (retained on `zigbee2mqtt/sl/config`). It also fires a small `zigbee2mqtt/sl/snap` event after a per-room save. HA is **not** in the runtime path.
- **`zigbee2mqtt/external_extensions/smart-lighting.js`** is the runtime: it stores all 4 window scenes on each Hue group, dispatches Hue dimmer button actions, runs window transitions (recalling scenes on rooms whose lights are already on), and snap-recalls when HA edits a current-window scene.
- **Bulb firmware defaults** (`hue_power_on_*`) are managed exclusively by the dashboard "Save as Firmware Default" button (`script.set_bulb_defaults`). The Z2M extension never writes them.

#### Power-on flow

| How you turn it on | Runtime owner | What happens |
|--------------------|---------------|--------------|
| Hue dimmer Button 1 | Z2M extension | `_handleSwitchAction` → `_roomOn` does `scene_recall` of the current window scene (brightness + xy color, or color_temp). Works with HA down. |
| Wall switch / mains restored | Bulb firmware | Bulb boots to whatever was last captured by the dashboard **"Save as Firmware Default (Wall Switch)"** button (`script.set_bulb_defaults`). Hue's factory default if you've never pressed it. Z2M **never** touches `hue_power_on_*`. Tap the Hue dimmer afterward to recall the current window scene. |
| HA dashboard light card | HA → Zigbee | `light.turn_on` over Zigbee restores the bulb's last RAM state. **Will not** apply the window scene. Use the dimmer for scenes. |
| HA down | — | Hue dimmer + wall switch both still work. Only saving scenes / pressing "Save as Firmware Default" needs HA. |

> **Firmware Default semantics:** The "Save as Firmware Default (Wall Switch)" button in the Scene Editor is *only* for wall-switch / mains-power-on behavior. It has no effect on Hue dimmer button-1 (Z2M scene recall), window transitions, or any other control path. Window transitions never rewrite firmware defaults.

#### Scene model

Per room/window the helpers are:

- `input_number.sl_<room>_<window>_brightness` — 1..255
- `input_number.sl_<room>_<window>_color_temp` — 153..500 mireds (color-capable rooms)
- `input_number.sl_<room>_<window>_color_x` / `_color_y` — 0..1 (color-capable rooms; both > 0 means xy is in use)

`sl_push_config` prefers xy when `color_x > 0 and color_y > 0`, falls back to `color_temp`, falls back to brightness only. `sl_save_current_as_scene` captures whichever the bulb is currently in (`color_mode == 'color_temp'` writes ct + zeros xy; xy mode writes xy and leaves ct in place — macro precedence handles the rest).

The `sl_<room>_smart_power_on` helpers exist but are no-ops; the device-announce scene-apply path was removed when wall-switch behavior moved to `set_bulb_defaults`.

#### Scene edit flow (snap-on-edit)

Saving a scene from the dashboard:

1. HA writes the brightness + (xy or ct) helpers for that room/window.
2. HA calls `script.sl_push_config` → publishes the full config on `zigbee2mqtt/sl/config` (retained). Z2M re-stores all 4 scenes on every group via `scene_add` (carrying `color: {x,y}` when present).
3. HA publishes `zigbee2mqtt/sl/snap` `{room_key, window}`. If `window == currentWindow`, Z2M calls `_recallSceneIfOn(room)` for **only that room** (gated by the room's `auto_transition`). Edits for non-current windows take effect on the next window transition or dimmer-on.

### Architecture

```
homeassistant/configuration/
├── automations/                    — Config-side automations only (no runtime)
├── scripts/
│   ├── sl_push_config.yaml         — Builds + publishes the full Z2M config
│   ├── sl_scene_editor.yaml        — sl_save_current_as_scene + snap publish
│   ├── sl_room_on.yaml             — Used by motion + dashboard helpers (legacy v2 callers)
│   ├── sl_room_off.yaml            — Turn off room + clear HA override flag
│   └── sl_apply_custom_scene_all_rooms.yaml — Whole-house custom scene apply
├── python_scripts/
│   └── sl_custom_scenes_persist.py — Persistent “All Rooms” custom scene packs
├── helpers/generated/
│   ├── input_boolean/sl_*.yaml     — Toggles (motion, transition, override, UI)
│   ├── input_datetime/sl_*.yaml    — Schedule times (weekday + weekend)
│   ├── input_number/sl_*.yaml      — Scene brightness/CT, motion timeout
│   ├── input_select/sl_*.yaml      — House mode, room selector, switch actions
│   ├── input_text/sl_*.yaml        — Custom scene name, last window tracker
│   └── timer/sl_*.yaml             — Motion auto-off timers
└── dashboards/
    └── smart_lighting.yaml         — Dashboard YAML

zigbee2mqtt/external_extensions/
└── smart-lighting.js               — Runtime: scenes, window transitions, dimmer dispatch, snap-on-edit
```

### Frontend Cards (installed by ha-init)

The Smart Lighting dashboard uses custom frontend cards, all installed automatically by the `hacs-init` container with pinned versions:

| Card | Version | Purpose |
|------|---------|---------|
| Mushroom Cards | v5.1.1 | Clean entity card styling |
| Bubble Card | v3.1.4 | Pop-up overlays (future use) |
| card-mod | v4.2.1 | CSS customization |
| Vertical Stack In Card | v1.0.1 | Seamless card grouping |
| Streamline Card | v0.2.0 | Template reuse for DRY YAML (future use) |

To update a card version, edit `homeassistant/scripts/ha-init.sh` and push. Changes sync automatically within 60 seconds.

## Voice Assist Pipeline (Jellyfin play-by-voice)

Wyoming services (`whisper`, `piper`, `openwakeword`) in `../automation/compose.yaml`
provide local speech-to-text/text-to-speech/wake-word for HA's built-in
**Assist** voice pipeline, wake word "Hey Nabu" (`ok_nabu`). This is separate
from Google Assistant — it's what powers the "play `<title>`" Jellyfin
command from the kitchen's HA Voice PE satellite, since Google Assistant has
no supported path for free-text playback against a self-hosted media server.

These pieces are UI/`.storage`-managed config-entry integrations (same
category as the `person`/UniFi setup noted above) and can't be expressed in
git-managed YAML, so they're one-time manual steps:

1. **Settings → Devices & services → Add integration → Wyoming Protocol** —
   add three times, pointing at:
   - `localhost:10300` (Whisper, STT)
   - `localhost:10200` (Piper, TTS)
   - `localhost:10400` (openWakeWord)

   (HA runs on host network, so `localhost` reaches these directly.)

2. **Settings → Voice assistants → Add assistant** — create a pipeline named
   e.g. "Local Assist", conversation agent "Home Assistant", STT = Whisper,
   TTS = Piper, wake word = the `ok_nabu` entity from openWakeWord.

3. **Pair the HA Voice PE** (Settings → Devices & services → it should
   auto-discover) and assign it to the "Local Assist" pipeline.

4. **Areas** — assign both the Kitchen HA Voice PE device *and* the Kitchen
   smart display's `media_player` entity to the same HA **Area** ("Kitchen").
   The Jellyfin play-by-voice automation (`automations/jellyfin_play_by_voice.yaml`,
   once added) resolves "the media player in this room" from
   `area_id(trigger.device_id)` — no hardcoded room mapping — so this Area
   assignment is what makes room-aware routing work, including for future
   rooms/satellites.
