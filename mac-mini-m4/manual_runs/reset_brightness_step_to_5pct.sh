#!/usr/bin/env bash
# One-shot: reset all brightness_step helpers from 20% → 5%.
# Run once after PR #30 is merged. Delete this file when done.
#
# Requires HA_TOKEN env var (set in ~/.bashrc).

set -euo pipefail

HA="https://ha.amer.dev"
HDR=(-H "Authorization: Bearer ${HA_TOKEN}" -H "Content-Type: application/json")

rooms=(living_room bedroom bathroom kitchen hallway hallway_s2)

for room in "${rooms[@]}"; do
  entity="input_number.sl_${room}_brightness_step"
  echo "Setting ${entity} → 5"
  curl -sf -X POST "${HDR[@]}" \
    -d '{"entity_id": "'"${entity}"'", "value": 5}' \
    "${HA}/api/services/input_number/set_value"
done

echo "Done — brightness step reset to 5% for all switches."
echo "Delete this file: mac-mini-m4/manual_runs/reset_brightness_step_to_5pct.sh"
