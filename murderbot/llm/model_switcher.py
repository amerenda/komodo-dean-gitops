"""Model switcher — HTTP endpoint that restarts llama-server with a different GGUF.

POST /switch {"model": "<name>"} with X-PSK header.
Blocks until llama-server is healthy on the new model (up to 5 min), then returns.
Called by the praetor webhook adapter so OWU users can switch models via chat.
"""
from __future__ import annotations

import logging
import os
import time
import urllib.error
import urllib.request

import docker as docker_sdk
import uvicorn
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="model-switcher")

_PSK = os.environ.get("SWITCH_PSK", "")

# Model name → GGUF path on the host (mounted into llama-server as /mnt/models)
_MODELS: dict[str, str] = {
    "qwen3-35b": "/mnt/models/llms/qwen36/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf",
    "qwen36-unrestricted": "/mnt/models/llms/qwen36/Qwen3.6-35B-A3B-uncensored-Q4_K_M.gguf",
}

_LLAMA_IMAGE = os.environ.get("LLAMA_IMAGE", "amerenda/murderbot-llm:latest")
_MODEL_VOLUME = os.environ.get("MODEL_VOLUME", "/mnt/storage/models:/mnt/models:ro")


class SwitchRequest(BaseModel):
    model: str


def _wait_for_healthy(timeout: int = 300, interval: int = 5) -> bool:
    """Poll http://localhost:8088/health until {"status":"ok"} or timeout (seconds)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen("http://localhost:8088/health", timeout=3) as resp:
                import json
                if json.loads(resp.read()).get("status") == "ok":
                    return True
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(interval)
    return False


def _docker_client() -> docker_sdk.DockerClient:
    return docker_sdk.DockerClient(base_url="unix:///var/run/docker.sock")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/models")
def list_models() -> dict:
    return {"models": list(_MODELS)}


@app.post("/switch")
def switch_model(req: SwitchRequest, x_psk: str = Header(...)) -> dict:
    if not _PSK:
        raise HTTPException(status_code=500, detail="SWITCH_PSK not configured")
    if x_psk != _PSK:
        raise HTTPException(status_code=401, detail="Invalid PSK")

    model_path = _MODELS.get(req.model)
    if not model_path:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown model: {req.model!r}. Valid: {list(_MODELS)}",
        )

    logger.info("Switching llama-server to model=%s (%s)", req.model, model_path)

    # Parse volume spec "host_path:container_path:options"
    vol_parts = _MODEL_VOLUME.split(":")
    host_vol = vol_parts[0]
    container_vol = vol_parts[1] if len(vol_parts) > 1 else host_vol
    vol_mode = vol_parts[2] if len(vol_parts) > 2 else "rw"

    client = _docker_client()

    try:
        existing = client.containers.get("llama-server")
        logger.info("Stopping existing llama-server container")
        existing.stop(timeout=30)
        existing.remove()
    except docker_sdk.errors.NotFound:
        pass

    try:
        client.containers.run(
            _LLAMA_IMAGE,
            detach=True,
            name="llama-server",
            restart_policy={"Name": "unless-stopped"},
            device_requests=[docker_sdk.types.DeviceRequest(count=-1, capabilities=[["gpu"]])],
            volumes={host_vol: {"bind": container_vol, "mode": vol_mode}},
            ports={"8088/tcp": 8088},
            environment={
                "MODEL": model_path,
                "NGL": "99",
                "CTX": "131072",
                "PORT": "8088",
                "NVIDIA_VISIBLE_DEVICES": "all",
                "NVIDIA_DRIVER_CAPABILITIES": "compute,utility",
            },
            # Compose labels so `docker compose up` on next Komodo deploy can manage this
            # container rather than failing with a name conflict.
            labels={
                "com.docker.compose.project": "llm-murderbot",
                "com.docker.compose.service": "llama-server",
            },
        )
    except Exception as exc:
        logger.error("Failed to start llama-server: %s", exc)
        raise HTTPException(status_code=500, detail=f"Failed to start llama-server: {exc}") from exc

    logger.info("llama-server container started, waiting for healthy on :8088 ...")
    if _wait_for_healthy():
        logger.info("llama-server healthy on model=%s", req.model)
        return {"status": "ready", "model": req.model, "path": model_path}

    logger.warning("llama-server did not become healthy within 5 min for model=%s", req.model)
    return {"status": "timeout", "model": req.model, "path": model_path}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8091)
