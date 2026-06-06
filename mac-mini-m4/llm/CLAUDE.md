# llm stack

Contains: Ollama, LLM Manager agent.

## Version pinning — DO NOT UPDATE without explicit instruction

| Service | Tag | Notes |
|---------|-----|-------|
| `ollama` | `${OLLAMA_IMAGE_TAG:-0.21.0}` | Env-driven; default pinned to 0.21.0 |
| `llm-manager` | `agent-${AGENT_IMAGE_TAG:-latest}` | CI-managed; latest is intentional |

Do not change the default version in the env variable fallback without explicit instruction.

## Always-on model: Qwen2.5-7B-Instruct (Q4_K_M)

**Primary model:** `qwen2.5:7b-instruct-q4_K_M` (~5 GB, ~30-40 tok/s on M4)
- Excellent tool/function calling (~86% benchmark score)
- Good general quality — competitive with Llama 3.1 8B
- Fits comfortably in available VRAM headroom alongside macOS + other services

**Ollama config (`ollama.env`):**
- `OLLAMA_NUM_PARALLEL=1` — single request at a time for lowest latency
- `OLLAMA_MAX_LOADED_MODELS=1` — only one model in memory
- `OLLAMA_FLASH_ATTENTION=1` — ~20-30% speedup on Apple Silicon

**Model pull:** The ollama-init container pulls qwen2.5:7b-instruct-q4_K_M on first deploy. Subsequent deploys are fast (model already cached).

**API access:** `http://<mac-mini-m4-ip>:11434` — OpenAI-compatible endpoint (`/v1/chat/completions`, `/api/generate`, etc.)
