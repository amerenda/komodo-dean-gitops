#!/usr/bin/env python3
"""
Smoke test for llm-murderbot (vLLM on NVIDIA RTX PRO 4000 Blackwell, SM_120a).
Runs once after Komodo deploy (restart: "no"). Exit 0 = all critical checks passed.

Tests:
  1. vLLM server health endpoint
  2. Expected model loaded and named correctly
  3. GPU KV cache loaded (vLLM Prometheus metrics)
  4. Tool calling returns JSON format (not XML)
  5. Real web search via SearXNG (tool execution)
  6. Synthesis after tool turn (non-empty response)
  7. Uncensored model available in HF cache (AEON benchmark model)
  8. Token throughput benchmark (tokens/s)
"""
import json
import os
import sys
import time
import urllib.request
import urllib.parse
import urllib.error

VLLM_URL = os.environ.get("VLLM_URL", "http://vllm-server:8088")
SEARXNG_URL = os.environ.get("SEARXNG_URL", "https://searxng.amer.dev")
EXPECTED_MODEL = os.environ.get("EXPECTED_MODEL", "qwen36-27b")
# Uncensored benchmark model — downloaded by uncensored-model-init service
UNCENSORED_MODEL_ID = os.environ.get(
    "UNCENSORED_MODEL_ID",
    "AEON-7/Qwen3.6-27B-AEON-Ultimate-Uncensored-Multimodal-NVFP4-MTP",
)
HF_HOME = os.environ.get("HF_HOME", "/mnt/models/hf-cache")

PASS: list[str] = []
WARN: list[str] = []
FAIL: list[str] = []


def check(name: str, ok: bool, msg: str = "", warn_only: bool = False) -> bool:
    if ok:
        PASS.append(name)
        print(f"  PASS  {name}")
    elif warn_only:
        WARN.append(name)
        print(f"  WARN  {name}: {msg}")
    else:
        FAIL.append(name)
        print(f"  FAIL  {name}: {msg}")
    return ok


def post_json(url: str, data: dict, timeout: int = 60) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def get_json(url: str, timeout: int = 10) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read())


def get_text(url: str, timeout: int = 10) -> str:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read().decode()


print("=" * 60)
print("llm-murderbot smoke test")
print(f"  vLLM URL : {VLLM_URL}")
print(f"  Model    : {EXPECTED_MODEL}")
print(f"  SearXNG  : {SEARXNG_URL}")
print("=" * 60)

# ── 1. vLLM health ────────────────────────────────────────────────────────────
print("\n[1] vLLM server health")
try:
    get_text(f"{VLLM_URL}/health", timeout=10)
    check("vllm_health", True)
except Exception as e:
    check("vllm_health", False, str(e))

# ── 2. Model loaded with correct served name ───────────────────────────────────
print("\n[2] Model loaded")
try:
    models_data = get_json(f"{VLLM_URL}/v1/models", timeout=10)
    model_ids = [m["id"] for m in models_data.get("data", [])]
    check(
        "model_loaded",
        EXPECTED_MODEL in model_ids,
        f"expected {EXPECTED_MODEL!r}, got {model_ids}",
    )
except Exception as e:
    check("model_loaded", False, str(e))

# ── 3. GPU KV cache loaded (via vLLM Prometheus metrics) ─────────────────────
print("\n[3] GPU KV cache")
try:
    metrics_text = get_text(f"{VLLM_URL}/metrics", timeout=10)
    gpu_cache = None
    for line in metrics_text.splitlines():
        if line.startswith("vllm:gpu_cache_usage_perc") and not line.startswith("#"):
            try:
                gpu_cache = float(line.split()[-1])
                break
            except (ValueError, IndexError):
                pass
    check(
        "gpu_kv_cache_loaded",
        gpu_cache is not None and gpu_cache > 0.5,
        f"gpu_cache_usage={gpu_cache} (expected >0.5 — model loaded in VRAM)",
    )
    if gpu_cache is not None:
        print(f"         GPU KV cache usage: {gpu_cache:.1%}")
except Exception as e:
    check("gpu_kv_cache_loaded", False, str(e), warn_only=True)

# ── 4. Tool calling — JSON format, not XML ────────────────────────────────────
print("\n[4] Tool calling format")
MOCK_TOOL = [
    {
        "type": "function",
        "function": {
            "name": "search_web",
            "description": "Search the web for current information.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "Search query"}},
                "required": ["query"],
            },
        },
    }
]

tool_call_id = "call_smoke_0"
try:
    resp = post_json(
        f"{VLLM_URL}/v1/chat/completions",
        {
            "model": EXPECTED_MODEL,
            "messages": [
                {"role": "user", "content": "Search for information about Python programming language."},
            ],
            "tools": MOCK_TOOL,
            "tool_choice": "required",
            "max_tokens": 256,
        },
        timeout=120,
    )
    choice = resp["choices"][0]
    finish = choice["finish_reason"]
    msg = choice["message"]
    tc = msg.get("tool_calls") or []
    content = msg.get("content") or ""

    check("tool_call_finish_reason", finish == "tool_calls", f"finish={finish!r}")
    check("tool_call_json_not_xml", "<function=" not in content, f"XML in content: {content[:80]}")
    check("tool_call_has_tool_calls", len(tc) > 0, f"tool_calls empty, content={content[:80]}")

    if tc:
        args_raw = tc[0]["function"].get("arguments", "")
        check(
            "tool_call_args_json_string",
            isinstance(args_raw, str) and not args_raw.strip().startswith("<"),
            f"args look like XML or wrong type: {args_raw[:60]}",
        )
        tool_call_id = tc[0]["id"]
except Exception as e:
    check("tool_call_finish_reason", False, str(e))
    check("tool_call_json_not_xml", False, "skipped")
    check("tool_call_has_tool_calls", False, "skipped")
    check("tool_call_args_json_string", False, "skipped")

# ── 5. Real web search via SearXNG ────────────────────────────────────────────
print("\n[5] SearXNG web search (tool execution)")
search_result = ""
try:
    params = urllib.parse.urlencode({"q": "Python programming language", "format": "json"})
    data = get_json(f"{SEARXNG_URL}/search?{params}", timeout=20)
    results = data.get("results", [])
    if results:
        parts = []
        for r in results[:3]:
            title = r.get("title", "")
            snippet = r.get("content", "")
            if title or snippet:
                parts.append(f"{title}: {snippet}")
        search_result = " | ".join(parts)
    check("searxng_returns_results", len(results) > 0, f"got {len(results)} results")
    check("searxng_result_content", len(search_result) > 50, f"short: {search_result[:60]}")
    check("searxng_result_relevant", "python" in search_result.lower(), f"no 'python' in results")
except urllib.error.URLError as e:
    check("searxng_returns_results", False, str(e), warn_only=True)
    check("searxng_result_content", False, "skipped", warn_only=True)
    check("searxng_result_relevant", False, "skipped", warn_only=True)
    search_result = "Python is a high-level interpreted programming language created in 1991."
except Exception as e:
    check("searxng_returns_results", False, str(e), warn_only=True)
    search_result = "Python is a high-level interpreted programming language."

# ── 6. Synthesis after tool call ─────────────────────────────────────────────
print("\n[6] Synthesis after tool turn")
try:
    synthesis_messages = [
        {"role": "user", "content": "Search for information about Python programming language."},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": tool_call_id,
                    "type": "function",
                    "function": {
                        "name": "search_web",
                        "arguments": '{"query": "Python programming language"}',
                    },
                }
            ],
        },
        {"role": "tool", "tool_call_id": tool_call_id, "content": search_result},
    ]
    t0 = time.monotonic()
    resp = post_json(
        f"{VLLM_URL}/v1/chat/completions",
        {
            "model": EXPECTED_MODEL,
            "messages": synthesis_messages,
            "max_tokens": 256,
        },
        timeout=120,
    )
    elapsed = time.monotonic() - t0

    content = resp["choices"][0]["message"].get("content") or ""
    finish = resp["choices"][0]["finish_reason"]
    tokens_out = resp.get("usage", {}).get("completion_tokens", 0)

    check("synthesis_non_empty", len(content) >= 50, f"{len(content)} chars; finish={finish!r}: {content[:80]}")
    check(
        "synthesis_mentions_python",
        "python" in content.lower(),
        f"no 'python' in synthesis: {content[:150]}",
    )

    if tokens_out > 0 and elapsed > 0:
        tok_per_sec = tokens_out / elapsed
        print(f"         Throughput: {tok_per_sec:.1f} tok/s ({tokens_out} tokens in {elapsed:.1f}s)")
        check(
            "throughput_acceptable",
            tok_per_sec >= 5.0,
            f"{tok_per_sec:.1f} tok/s — GPU may not be active (expected ≥5 tok/s)",
            warn_only=True,
        )
except Exception as e:
    check("synthesis_non_empty", False, str(e))
    check("synthesis_mentions_python", False, "skipped")

# ── 7. Uncensored benchmark model in HF cache ─────────────────────────────────
print("\n[7] Uncensored benchmark model cache")
# Derive expected cache directory from HF hub layout
# HF Hub stores models at: HF_HOME/hub/models--<org>--<name>/snapshots/
hf_model_dir = UNCENSORED_MODEL_ID.replace("/", "--")
hf_cache_path = os.path.join(HF_HOME, "hub", f"models--{hf_model_dir}")
try:
    check(
        "uncensored_model_cached",
        os.path.isdir(hf_cache_path),
        f"not found at {hf_cache_path} — run uncensored-model-init service to download",
        warn_only=True,
    )
except Exception as e:
    check("uncensored_model_cached", False, str(e), warn_only=True)

# ── 8. Token throughput benchmark ────────────────────────────────────────────
print("\n[8] Token throughput benchmark")
try:
    bench_prompt = (
        "Write a concise technical explanation of how transformer attention works. "
        "Cover: (1) query/key/value matrices, (2) scaled dot-product attention, "
        "(3) multi-head attention, (4) why softmax is applied. Be thorough."
    )
    t0 = time.monotonic()
    resp = post_json(
        f"{VLLM_URL}/v1/chat/completions",
        {
            "model": EXPECTED_MODEL,
            "messages": [{"role": "user", "content": bench_prompt}],
            "max_tokens": 512,
        },
        timeout=180,
    )
    elapsed = time.monotonic() - t0
    tokens_out = resp.get("usage", {}).get("completion_tokens", 0)
    tokens_in = resp.get("usage", {}).get("prompt_tokens", 0)
    content = resp["choices"][0]["message"].get("content") or ""

    if tokens_out > 0 and elapsed > 0:
        tok_per_sec = tokens_out / elapsed
        print(f"         Benchmark: {tok_per_sec:.1f} tok/s")
        print(f"         Tokens: {tokens_in} in / {tokens_out} out / {elapsed:.1f}s")
        check(
            "benchmark_throughput_min",
            tok_per_sec >= 5.0,
            f"{tok_per_sec:.1f} tok/s is below minimum (5 tok/s) — GPU acceleration may be broken",
            warn_only=True,
        )
    check(
        "benchmark_response_coherent",
        len(content) >= 100 and "attention" in content.lower(),
        f"response too short or incoherent ({len(content)} chars)",
    )
except Exception as e:
    check("benchmark_throughput_min", False, str(e), warn_only=True)
    check("benchmark_response_coherent", False, "skipped")

# ── Summary ───────────────────────────────────────────────────────────────────
print()
print("=" * 60)
print(f"SMOKE TEST RESULTS: {len(PASS)} passed, {len(WARN)} warned, {len(FAIL)} failed")
if WARN:
    print(f"  WARNINGS : {', '.join(WARN)}")
if FAIL:
    print(f"  FAILURES : {', '.join(FAIL)}")
    print()
    print("SMOKE TEST FAILED")
    sys.exit(1)
else:
    print()
    print("SMOKE TEST PASSED")
    sys.exit(0)
