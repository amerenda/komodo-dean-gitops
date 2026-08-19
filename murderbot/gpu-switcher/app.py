"""
gpu-switcher: switches murderbot's single GPU between mutually-exclusive
"known configurations" -- currently two llm-murderbot model profiles
(qwen36, qwen38) and the img-murderbot image-generation stack.

Drives Komodo's own API to do the actual work (DestroyStack/DeployStack,
UpdateVariableValue) rather than touching docker directly, so Komodo never
loses track of what's running. Switching a config is a runtime action via
this service's HTTP API -- never a git commit. See murderbot/llm/compose.yaml
and resource-sync/stacks.toml for how the qwen36/qwen38 profile selection
(the MURDERBOT_LLM_PROFILE Komodo Variable) actually reaches docker compose.

CONFIGS is the git-tracked source of truth for what configurations exist.
Adding a new switchable config (e.g. a third LLM profile) is a data change
here, not a rearchitecture.
"""

import asyncio
import os
import time
from typing import Optional

import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

KOMODO_URL = "https://komodo.amer.dev"
KOMODO_API_KEY = os.environ["KOMODO_API_KEY"]
KOMODO_API_SECRET = os.environ["KOMODO_API_SECRET"]
SWITCHER_TOKEN = os.environ["SWITCHER_TOKEN"]

# The mutually-exclusive GPU-owning stacks on murderbot. Exactly one of these
# should ever be "running" at a time -- switching always tears down whichever
# of these is currently up before starting the target.
GPU_STACKS = ["llm-murderbot", "img-murderbot"]

# Known switchable configurations. `stack` is the Komodo stack to deploy.
# `variable`/`value` (if set) is a Komodo Variable to set before deploying --
# this is how llm-murderbot's model profile is selected without a git commit
# (see murderbot/llm/pre-deploy.sh, which turns this Variable into
# COMPOSE_PROFILES).
CONFIGS = {
    "qwen36": {
        "stack": "llm-murderbot",
        "variable": "MURDERBOT_LLM_PROFILE",
        "value": "qwen36",
        "description": "Qwen3.6-35B-A3B-MTP-GGUF, ~120-140 tok/s, 98,304 ctx, true weight-level abliteration",
    },
    "qwen38": {
        "stack": "llm-murderbot",
        "variable": "MURDERBOT_LLM_PROFILE",
        "value": "qwen38",
        "description": "Qwen3.8-27B-GGUF+MTP, ~40 tok/s, 49,152 ctx, no abliterated quant available yet",
    },
    "imagegen": {
        "stack": "img-murderbot",
        "variable": None,
        "value": None,
        "description": "ComfyUI + FLUX image generation",
    },
}

# In-memory switch state. Single-process, single-GPU host -- no need for
# anything heavier than a module-level dict guarded by a lock.
_lock = asyncio.Lock()
state = {"status": "idle", "target": None, "error": None, "started_at": None, "finished_at": None}

app = FastAPI(title="murderbot gpu-switcher")


def check_auth(authorization: Optional[str]) -> None:
    if authorization != f"Bearer {SWITCHER_TOKEN}":
        raise HTTPException(401, "unauthorized")


async def komodo_call(kind: str, type_: str, params: dict) -> dict | list:
    async with httpx.AsyncClient(verify=False, timeout=60) as client:
        r = await client.post(
            f"{KOMODO_URL}/{kind}",
            json={"type": type_, "params": params},
            headers={"X-Api-Key": KOMODO_API_KEY, "X-Api-Secret": KOMODO_API_SECRET},
        )
        r.raise_for_status()
        return r.json()


async def get_running_gpu_stacks() -> list[str]:
    stacks = await komodo_call("read", "ListStacks", {})
    return [s["name"] for s in stacks if s["name"] in GPU_STACKS and s["info"].get("state") == "running"]


async def get_active_llm_profile() -> Optional[str]:
    variables = await komodo_call("read", "ListVariables", {})
    v = next((v for v in variables if v["name"] == "MURDERBOT_LLM_PROFILE"), None)
    return v["value"] if v else None


async def get_active_config() -> Optional[str]:
    """Best-effort: which known config is currently active, if any."""
    running = await get_running_gpu_stacks()
    if "img-murderbot" in running:
        return "imagegen"
    if "llm-murderbot" in running:
        profile = await get_active_llm_profile()
        if profile in ("qwen36", "qwen38"):
            return profile
    return None


@app.get("/status")
async def status():
    running = await get_running_gpu_stacks()
    active_profile = await get_active_llm_profile() if "llm-murderbot" in running else None
    active_config = await get_active_config()
    return {
        "running_stacks": running,
        "active_llm_profile": active_profile,
        "active_config": active_config,
        "configs": {name: cfg["description"] for name, cfg in CONFIGS.items()},
        "switch": state,
    }


@app.post("/switch/{config_name}")
async def switch(config_name: str, authorization: Optional[str] = Header(None)):
    check_auth(authorization)
    if config_name not in CONFIGS:
        raise HTTPException(404, f"unknown config {config_name!r}, known: {list(CONFIGS)}")

    if _lock.locked():
        raise HTTPException(409, "a switch is already in progress")

    active = await get_active_config()
    if active == config_name:
        return {"status": "already_active", "config": config_name}

    asyncio.create_task(_do_switch(config_name))
    return {"status": "switching", "target": config_name}


async def wait_for_stack_idle(stack: str, timeout_s: float = 120, poll_s: float = 2) -> None:
    """Poll GetStackActionState until Komodo/Periphery is done with a prior
    operation on this stack. Required before issuing another action --
    firing DeployStack immediately after DestroyStack races Periphery's own
    teardown and fails with "Resource is busy" (observed directly)."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        s = await komodo_call("read", "GetStackActionState", {"stack": stack})
        if not any(s.values()):
            return
        await asyncio.sleep(poll_s)
    raise RuntimeError(f"timed out waiting for {stack} to go idle")


async def wait_for_update_result(stack: str, after_ts: float, timeout_s: float = 600, poll_s: float = 3) -> dict:
    """DeployStack/DestroyStack return success=true as soon as Komodo *accepts*
    the request -- the actual outcome (container built/started, or a failure
    like "Resource is busy") only shows up later in the stack's update
    history. Poll for the update record created by this specific call and
    return it, so callers can check its real `success` field."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        updates = await komodo_call(
            "read", "ListUpdates", {"query": {"target": {"type": "Stack", "id": await get_stack_id(stack)}}}
        )
        candidates = [u for u in updates if u.get("start_ts", 0) >= after_ts * 1000 and u.get("status") == "Complete"]
        if candidates:
            return max(candidates, key=lambda u: u["start_ts"])
        await asyncio.sleep(poll_s)
    raise RuntimeError(f"timed out waiting for an update result on {stack}")


_stack_id_cache: dict[str, str] = {}


async def get_stack_id(stack_name: str) -> str:
    if stack_name not in _stack_id_cache:
        stacks = await komodo_call("read", "ListStacks", {})
        for s in stacks:
            _stack_id_cache[s["name"]] = s["id"]
    return _stack_id_cache[stack_name]


async def run_stack_action(kind: str, action: str, stack: str) -> None:
    """Issue a Stack action and wait for its *real* outcome, not just
    Komodo's immediate accept response."""
    t0 = time.time()
    await komodo_call(kind, action, {"stack": stack})
    result = await wait_for_update_result(stack, t0)
    if not result.get("success"):
        raise RuntimeError(f"{action} on {stack} failed -- see Komodo update history for logs")
    await wait_for_stack_idle(stack)


async def _do_switch(config_name: str) -> None:
    async with _lock:
        cfg = CONFIGS[config_name]
        state.update(status="switching", target=config_name, error=None, started_at=time.time(), finished_at=None)
        try:
            running = await get_running_gpu_stacks()
            for stack in running:
                await run_stack_action("execute", "DestroyStack", stack)

            if cfg["variable"]:
                await komodo_call("write", "UpdateVariableValue", {"name": cfg["variable"], "value": cfg["value"]})

            await run_stack_action("execute", "DeployStack", cfg["stack"])

            state.update(status="idle", finished_at=time.time())
        except Exception as e:
            state.update(status="error", error=str(e), finished_at=time.time())


@app.get("/health")
async def health():
    return {"ok": True}
