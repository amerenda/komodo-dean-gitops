"""Model switcher — HTTP endpoint that restarts llama-server with a different GGUF.

POST /switch {"model": "<name>"} with X-PSK header.
Called by the praetor webhook adapter so OWU users can switch models via chat.
"""
from __future__ import annotations

import logging
import os
import subprocess

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

    subprocess.run(["docker", "stop", "llama-server"], check=False, capture_output=True)
    subprocess.run(["docker", "rm", "llama-server"], check=False, capture_output=True)

    run_cmd = [
        "docker", "run", "-d",
        "--name", "llama-server",
        "--restart", "unless-stopped",
        "--gpus", "all",
        "-v", _MODEL_VOLUME,
        "-p", "8088:8088",
        "-e", f"MODEL={model_path}",
        "-e", "NGL=99",
        "-e", "CTX=131072",
        "-e", "PORT=8088",
        "-e", "NVIDIA_VISIBLE_DEVICES=all",
        "-e", "NVIDIA_DRIVER_CAPABILITIES=compute,utility",
        _LLAMA_IMAGE,
    ]
    result = subprocess.run(run_cmd, capture_output=True, text=True)
    if result.returncode != 0:
        logger.error("docker run failed: %s", result.stderr)
        raise HTTPException(status_code=500, detail=f"docker run failed: {result.stderr[:300]}")

    logger.info("llama-server restarted with model=%s", req.model)
    return {
        "status": "switching",
        "model": req.model,
        "path": model_path,
        "note": "Server loading — /health on :8088 confirms readiness (up to 5 min)",
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8091)
