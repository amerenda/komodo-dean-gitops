#!/usr/bin/env python3
"""
Smoke test for llm-murderbot (llama.cpp on NVIDIA RTX PRO 4000 Blackwell, SM_120a).
Runs once after Komodo deploy (restart: "no"). Exit 0 = all critical checks passed.

Tests:
  1. llama-server health endpoint
  2. Expected model loaded
  3. Tool calling returns JSON format (not XML)
  4. Real web search via SearXNG (tool execution)
  5. Synthesis after tool turn (non-empty response)
  6. Token throughput benchmark (tokens/s) -- MTP speculative decoding should land
     well above the old vLLM baseline (~25-32 tok/s); this checks a floor, not the
     ceiling, since draft-acceptance rate varies by content.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.parse
import urllib.error

LLAMA_URL = os.environ.get("LLAMA_URL", "http://llama-server:8088")
SEARXNG_URL = os.environ.get("SEARXNG_URL", "https://searxng.amer.dev")
# llama-server reports whatever --alias was set to as its "id" in /v1/models
# (murderbot/llm/compose.yaml sets --alias qwen36-35b-a3b) rather than the raw GGUF path.
EXPECTED_MODEL_SUBSTR = os.environ.get("EXPECTED_MODEL_SUBSTR", "murderbot-primary")

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
print("llm-murderbot smoke test (llama.cpp)")
print(f"  llama.cpp URL : {LLAMA_URL}")
print(f"  Model         : *{EXPECTED_MODEL_SUBSTR}*")
print(f"  SearXNG       : {SEARXNG_URL}")
print("=" * 60)

# ── 0. Wait for llama-server to be ready ──────────────────────────────────────
# depends_on is service_started (not service_healthy) so the compose dependency
# wait can never block on/interfere with llama-server's own startup — this test
# does its own readiness polling instead. Cold start (20GB GGUF load + full GPU
# upload + KV cache alloc) took ~1m28s-2m15s in testing; poll well past that.
print("\n[0] Waiting for llama-server readiness")
READY_TIMEOUT_S = 600
t_wait_start = time.monotonic()
ready = False
while time.monotonic() - t_wait_start < READY_TIMEOUT_S:
    try:
        get_text(f"{LLAMA_URL}/health", timeout=10)
        ready = True
        break
    except Exception:
        time.sleep(5)
print(f"  {'ready' if ready else 'TIMED OUT'} after {time.monotonic() - t_wait_start:.0f}s")

# ── 1. llama-server health ────────────────────────────────────────────────────
print("\n[1] llama-server health")
try:
    get_text(f"{LLAMA_URL}/health", timeout=10)
    check("llama_health", True)
except Exception as e:
    check("llama_health", False, str(e))

# ── 2. Model loaded ────────────────────────────────────────────────────────────
print("\n[2] Model loaded")
try:
    models_data = get_json(f"{LLAMA_URL}/v1/models", timeout=10)
    # llama-server's /v1/models returns both an OpenAI-style "data" array (keyed "id")
    # and an Ollama-style "models" array (keyed "name") -- prefer "data" since that's
    # the key this check actually reads.
    model_ids = [m.get("id", "") for m in models_data.get("data", models_data.get("models", []))]
    check(
        "model_loaded",
        any(EXPECTED_MODEL_SUBSTR in m for m in model_ids),
        f"expected substring {EXPECTED_MODEL_SUBSTR!r}, got {model_ids}",
    )
except Exception as e:
    check("model_loaded", False, str(e))

# ── 3. Tool calling — JSON format, not XML ────────────────────────────────────
print("\n[3] Tool calling format")
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
        f"{LLAMA_URL}/v1/chat/completions",
        {
            "messages": [
                {"role": "user", "content": "Search for information about Python programming language."},
            ],
            "tools": MOCK_TOOL,
            "tool_choice": "required",
            "max_tokens": 512,
            # Disable extended thinking for this check — reasoning tokens would otherwise
            # consume the budget before a tool call is emitted. Production leaves thinking
            # on by default (froggeric template); this is a smoke-test speed/determinism choice.
            "chat_template_kwargs": {"enable_thinking": False},
        },
        timeout=120,
    )
    choice = resp["choices"][0]
    finish = choice["finish_reason"]
    msg = choice["message"]
    tc = msg.get("tool_calls") or []
    content = msg.get("content") or ""

    check("tool_call_finish_reason", finish == "tool_calls", f"finish={finish!r}")
    check("tool_call_json_not_xml", "<function=" not in content and "<tool_call>" not in content, f"XML in content: {content[:80]}")
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

# ── 4. Real web search via SearXNG ────────────────────────────────────────────
print("\n[4] SearXNG web search (tool execution)")
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
    check("searxng_result_relevant", "python" in search_result.lower(), "no 'python' in results")
except urllib.error.URLError as e:
    check("searxng_returns_results", False, str(e), warn_only=True)
    check("searxng_result_content", False, "skipped", warn_only=True)
    check("searxng_result_relevant", False, "skipped", warn_only=True)
    search_result = "Python is a high-level interpreted programming language created in 1991."
except Exception as e:
    check("searxng_returns_results", False, str(e), warn_only=True)
    search_result = "Python is a high-level interpreted programming language."

# ── 5. Synthesis after tool call ─────────────────────────────────────────────
print("\n[5] Synthesis after tool turn")
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
        f"{LLAMA_URL}/v1/chat/completions",
        {
            "messages": synthesis_messages,
            "max_tokens": 512,
            "chat_template_kwargs": {"enable_thinking": False},
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
            tok_per_sec >= 25.0,
            f"{tok_per_sec:.1f} tok/s — MTP speculative decoding may not be active "
            "(expected ~35-45 tok/s for this dense 27B model with MTP; floor set below "
            "that to avoid flaking on short responses)",
            warn_only=True,
        )
except Exception as e:
    check("synthesis_non_empty", False, str(e))
    check("synthesis_mentions_python", False, "skipped")

# ── 6. Token throughput benchmark + KV cache sanity (via metrics counters) ────
print("\n[6] Token throughput benchmark")
try:
    bench_prompt = (
        "Write a concise technical explanation of how transformer attention works. "
        "Cover: (1) query/key/value matrices, (2) scaled dot-product attention, "
        "(3) multi-head attention, (4) why softmax is applied. Be thorough."
    )
    t0 = time.monotonic()
    resp = post_json(
        f"{LLAMA_URL}/v1/chat/completions",
        {
            "messages": [{"role": "user", "content": bench_prompt}],
            "max_tokens": 700,
            "chat_template_kwargs": {"enable_thinking": False},
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
            tok_per_sec >= 25.0,
            f"{tok_per_sec:.1f} tok/s is below the MTP floor (25 tok/s) — speculative "
            "decoding may not be active, check --spec-type/--spec-draft-n-max",
            warn_only=True,
        )
    check(
        "benchmark_response_coherent",
        len(content) >= 100 and "attention" in content.lower(),
        f"response too short or incoherent ({len(content)} chars)",
    )

    # llama.cpp has no vLLM-style "kv_cache_usage_perc" gauge -- instead confirm the
    # server actually processed real prompt+generation tokens via its own counters
    # (proves the GPU/KV-cache path is functioning, not just that health returns ok).
    metrics_text = get_text(f"{LLAMA_URL}/metrics", timeout=10)
    prompt_total = predicted_total = 0
    for line in metrics_text.splitlines():
        if line.startswith("llamacpp:prompt_tokens_total "):
            prompt_total = float(line.split()[-1])
        elif line.startswith("llamacpp:tokens_predicted_total "):
            predicted_total = float(line.split()[-1])
    check(
        "gpu_processed_real_tokens",
        prompt_total > 0 and predicted_total > 0,
        f"prompt_tokens_total={prompt_total} tokens_predicted_total={predicted_total} "
        "(should be nonzero after the requests above — model may not be running on GPU)",
    )
except Exception as e:
    check("benchmark_throughput_min", False, str(e), warn_only=True)
    check("benchmark_response_coherent", False, "skipped")
    check("gpu_processed_real_tokens", False, "skipped")

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
