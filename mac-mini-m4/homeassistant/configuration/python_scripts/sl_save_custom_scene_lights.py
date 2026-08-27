"""Snapshot a room's live per-light state into one Custom Scene slot (Button 4 Cycle).

Unlike window scenes (one uniform brightness/color per room), a Custom Scene stores
a DIFFERENT value per light — captured live from each bulb's actual current state
so you can just adjust the lights (e.g. via the Hue-like card) and save the result,
the same way the Hue app's own "create scene" flow works.

Writes a compact JSON blob to input_text.sl_<room>_<slot>_lights, in the same
{state, brightness, color/color_temp} shape smart-lighting.js already uses for
window scenes, then triggers script.sl_push_config so it goes out over MQTT.

Called via service python_script.sl_save_custom_scene_lights with
data: { room: "<room_key>", slot: "custom1" | "custom2" | "custom3" }.

Keep this file in /config/python_scripts/ (same folder as configuration.yaml).
"""

import json

ROOM_LIGHTS = {
    "living_room": ["living_room_1"],
    "bedroom": ["bedroom_1", "bedroom_2", "lamp_1"],
    "bathroom": ["bathroom_1"],
    "kitchen": ["kitchen_1", "kitchen_2"],
    "hallway": ["hallway_1"],
}

CUSTOM_SLOTS = ("custom1", "custom2", "custom3")


def _snapshot_light(state_obj):
    if state_obj is None or state_obj.state in ("unknown", "unavailable"):
        return None
    if state_obj.state == "off":
        return {"state": "OFF"}

    entry = {"state": "ON", "brightness": int(state_obj.attributes.get("brightness") or 200)}
    xy = state_obj.attributes.get("xy_color")
    ct_mireds = state_obj.attributes.get("color_temp")
    ct_kelvin = state_obj.attributes.get("color_temp_kelvin")
    if xy and len(xy) == 2:
        entry["color"] = {"x": round(xy[0], 4), "y": round(xy[1], 4)}
    elif ct_mireds:
        entry["color_temp"] = int(ct_mireds)
    elif ct_kelvin:
        entry["color_temp"] = int(1000000 / ct_kelvin)
    return entry


room = data.get("room")
slot = data.get("slot")

if room not in ROOM_LIGHTS:
    logger.error("sl_save_custom_scene_lights: unknown room %r", room)
elif slot not in CUSTOM_SLOTS:
    logger.error("sl_save_custom_scene_lights: unknown slot %r", slot)
else:
    snapshot = {}
    for light_key in ROOM_LIGHTS[room]:
        snap = _snapshot_light(hass.states.get("light." + light_key))
        if snap is not None:
            snapshot[light_key] = snap

    value = json.dumps(snapshot, separators=(",", ":"))
    hass.services.call(
        "input_text",
        "set_value",
        {"entity_id": "input_text.sl_%s_%s_lights" % (room, slot), "value": value},
        blocking=True,
    )
    hass.services.call("script", "sl_push_config", {}, blocking=True)
    logger.info(
        "sl_save_custom_scene_lights: saved %s/%s (%d lights): %s",
        room, slot, len(snapshot), value,
    )
