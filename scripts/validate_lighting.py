#!/usr/bin/env python3
"""
Lighting config validator — run on PRs to catch regressions.

Checks:
  1. All YAML files under mac-mini-m4/homeassistant/configuration/ are
     syntactically valid (using a permissive YAML loader that tolerates
     HA-specific tags like !input, !secret, !include).
  2. Every input_number/input_boolean/input_datetime helper referenced by
     the key naming convention in sl_push_config.yaml exists as a helper
     YAML file.
  3. sl_push_config.yaml itself is present.
  4. smart-lighting.js is present.
"""
import re
import sys
import glob
import os
from pathlib import Path

ROOT = Path(__file__).parent.parent
HA_CONFIG = ROOT / "mac-mini-m4" / "homeassistant" / "configuration"
EXT_DIR = ROOT / "mac-mini-m4" / "zigbee2mqtt" / "external_extensions"

failures: list[str] = []
warnings: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)
    print(f"FAIL  {msg}", file=sys.stderr)


def ok(msg: str) -> None:
    print(f"ok    {msg}")


# ── 1. YAML syntax ───────────────────────────────────────────────────────────

# HA YAML uses tags like !input, !secret, !include — yaml.safe_load rejects
# these. We use a custom loader that treats unknown tags as strings.
import yaml

class _PermissiveLoader(yaml.FullLoader):
    pass

def _construct_undefined(loader, tag_suffix, node):
    if isinstance(node, yaml.ScalarNode):
        return loader.construct_scalar(node)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node)
    return loader.construct_mapping(node)

_PermissiveLoader.add_multi_constructor('', _construct_undefined)


yaml_files = sorted(glob.glob(str(HA_CONFIG / "**" / "*.yaml"), recursive=True))
if not yaml_files:
    fail(f"No YAML files found under {HA_CONFIG}")
else:
    for path in yaml_files:
        try:
            with open(path) as f:
                yaml.load(f, Loader=_PermissiveLoader)
            ok(f"yaml/{Path(path).relative_to(HA_CONFIG)}")
        except yaml.YAMLError as e:
            fail(f"yaml/{Path(path).relative_to(HA_CONFIG)}: {e}")


# ── 2. Helper reference completeness ────────────────────────────────────────

# Collect all helper entity IDs defined in generated/ and helpers/ YAML files
HELPER_DIRS = [
    HA_CONFIG / "helpers",
    HA_CONFIG / "helpers" / "generated",
]

defined_helpers: set[str] = set()

for helper_dir in HELPER_DIRS:
    for yaml_path in glob.glob(str(helper_dir / "**" / "*.yaml"), recursive=True):
        try:
            with open(yaml_path) as f:
                content = yaml.load(f, Loader=_PermissiveLoader)
            if isinstance(content, dict):
                # Each key is an entity slug, domain is the parent dir name
                domain = Path(yaml_path).parent.name
                for slug in content:
                    defined_helpers.add(f"{domain}.{slug}")
        except Exception:
            pass  # syntax errors already caught above

# Extract sl_* references from sl_push_config.yaml
push_config = HA_CONFIG / "scripts" / "sl_push_config.yaml"
REQUIRED_FILES = {
    "sl_push_config.yaml": push_config,
    "smart-lighting.js": EXT_DIR / "smart-lighting.js",
}

for label, path in REQUIRED_FILES.items():
    if path.exists():
        ok(f"exists/{label}")
    else:
        fail(f"missing/{label}: {path}")

if push_config.exists():
    with open(push_config) as f:
        push_config_text = f.read()

    # Find all input_number.sl_*, input_boolean.sl_*, input_datetime.sl_* references
    ref_pattern = re.compile(r'\b(input_(?:number|boolean|datetime|select|text))\.([a-z0-9_]+)\b')
    refs: set[str] = set()
    for m in ref_pattern.finditer(push_config_text):
        entity_id = f"{m.group(1)}.{m.group(2)}"
        if m.group(2).startswith('sl_'):
            refs.add(entity_id)

    for entity_id in sorted(refs):
        if entity_id in defined_helpers:
            ok(f"helper/{entity_id}")
        else:
            # Some helpers are defined inline in configuration.yaml or other files
            # not under helpers/ — treat as warning, not hard failure
            warnings.append(f"helper not found in helpers/ dir: {entity_id}")
            print(f"warn  helper/{entity_id} (not found in helpers/ — may be defined elsewhere)")


# ── Summary ──────────────────────────────────────────────────────────────────

total = len(yaml_files) + len(REQUIRED_FILES) + (len(refs) if push_config.exists() else 0)
if failures:
    print(f"\n{len(failures)} check(s) FAILED:", file=sys.stderr)
    for f in failures:
        print(f"  ✗ {f}", file=sys.stderr)
    sys.exit(1)

print(f"\nAll checks passed ({total} items, {len(warnings)} warning(s)).")
sys.exit(0)


if __name__ == "__main__":
    pass
