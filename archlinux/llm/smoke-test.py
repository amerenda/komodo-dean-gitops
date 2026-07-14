#!/usr/bin/env python3
"""
Smoke test for llm-archlinux (Ollama on AMD RX 9070 XT / Vulkan backend).
Runs once after Komodo deploy (restart: "no"). Exit 0 = all critical checks passed.

Tests:
  1. Ollama server health
  2. Expected model loaded (qwen3:14b)
  3. Tool calling returns JSON format (not XML)  [loads model into VRAM]
  4. Real web search via SearXNG (tool execution)
  5. Synthesis after tool turn (no tools on synthesis — qwen3:14b ignores tool_choice=none)
  6. AMD GPU active via sysfs (VRAM usage — checked after inference warms up the model)
  7. Token throughput benchmark (tokens/s)
"""
import glob
import json
import os
import sys
import time
import urllib.request
import urllib.parse
import urllib.error

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434")
SEARXNG_URL = os.environ.get("SEARXNG_URL", "https://searxng.amer.dev")
EXPECTED_MODEL = os.environ.get("EXPECTED_MODEL", "qwen3:14b")
GPU_SYSFS = os.environ.get("GPU_SYSFS", "/sys/class/drm")

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


def post_json(url: str, data: dict, timeout: int = 120) -> dict:
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


print("=" * 60)
print("llm-archlinux smoke test (AMD RX 9070 XT / Vulkan)")
print(f"  Ollama URL : {OLLAMA_URL}")
print(f"  Model      : {EXPECTED_MODEL}")
print(f"  SearXNG    : {SEARXNG_URL}")
print("=" * 60)

# ── 1. Ollama health ──────────────────────────────────────────────────────────
print("\n[1] Ollama server health")
try:
    data = get_json(f"{OLLAMA_URL}/api/version", timeout=10)
    check("ollama_health", True, f"version={data.get('version','?')}")
    print(f"         Ollama version: {data.get('version', '?')}")
except Exception as e:
    check("ollama_health", False, str(e))

# ── 2. Expected model loaded ──────────────────────────────────────────────────
print("\n[2] Model loaded")
try:
    data = get_json(f"{OLLAMA_URL}/api/tags", timeout=10)
    models = [m["name"] for m in data.get("models", [])]
    expected_base = EXPECTED_MODEL.split(":")[0]
    found = any(m.startswith(expected_base) for m in models)
    check("model_loaded", found, f"expected {EXPECTED_MODEL!r}, got {models}")
    if models:
        print(f"         Available: {models}")
except Exception as e:
    check("model_loaded", False, str(e))

# ── 3. Tool calling — JSON format ─────────────────────────────────────────────
# NOTE: tool calling runs before the GPU VRAM check (test 6) so the model is loaded
# into VRAM by the time we sample sysfs. On a cold Komodo deploy, Ollama has not yet
# served any requests so VRAM is near-zero even though the model is on disk.
print("\n[3] Tool calling format")
MOCK_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_web",
            "description": "Search the web for information.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "Search query"}},
                "required": ["query"],
            },
        },
    }
]

tool_name_called = "search_web"
tool_args_called = {"query": "Python programming language"}

try:
    resp = post_json(
        f"{OLLAMA_URL}/api/chat",
        {
            "model": EXPECTED_MODEL,
            "messages": [
                {"role": "user", "content": "Search for information about Python programming language."},
            ],
            "tools": MOCK_TOOLS,
            "stream": False,
            # think: false must be top-level (not inside options) per Ollama API spec
            "think": False,
            "options": {"num_ctx": 4096},
        },
        timeout=120,
    )
    msg = resp.get("message", {})
    tc = msg.get("tool_calls") or []
    content = msg.get("content") or ""

    check("tool_call_has_tool_calls", len(tc) > 0, f"no tool_calls; content={content[:80]}")
    check("tool_call_no_xml", "<function=" not in content, f"XML in content: {content[:80]}")

    if tc:
        fn = tc[0].get("function", {})
        tool_name_called = fn.get("name", "search_web")
        args = fn.get("arguments", {})
        if isinstance(args, str):
            try:
                tool_args_called = json.loads(args)
            except Exception:
                tool_args_called = {"query": "Python"}
        elif isinstance(args, dict):
            tool_args_called = args
        check(
            "tool_call_args_valid",
            isinstance(args, (dict, str)),
            f"unexpected args type: {type(args).__name__}",
        )
    else:
        check("tool_call_args_valid", False, "no tool calls to validate")
except Exception as e:
    check("tool_call_has_tool_calls", False, str(e))
    check("tool_call_no_xml", False, "skipped")
    check("tool_call_args_valid", False, "skipped")

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
    # warn_only: SearXNG depends on upstream search engines that can rate-limit or time out
    # transiently. A 0-result response does not indicate a deployment problem.
    check("searxng_returns_results", len(results) > 0, f"got {len(results)} results", warn_only=True)
    check("searxng_result_content", len(search_result) > 50, f"short: {search_result[:60]}", warn_only=True)
    check("searxng_result_relevant", "python" in search_result.lower(), "no 'python' in results", warn_only=True)
except urllib.error.URLError as e:
    check("searxng_returns_results", False, str(e), warn_only=True)
    check("searxng_result_content", False, "skipped", warn_only=True)
    check("searxng_result_relevant", False, "skipped", warn_only=True)
    search_result = "Python is a high-level interpreted programming language created in 1991."
except Exception as e:
    check("searxng_returns_results", False, str(e), warn_only=True)
    search_result = "Python is a high-level interpreted programming language."

# ── 5. Synthesis after tool turn ─────────────────────────────────────────────
print("\n[5] Synthesis after tool turn")
# qwen3:14b via Ollama ignores tool_choice=none and hallucinates tool calls.
# Strip tools entirely on the synthesis turn to force text output.
try:
    synthesis_messages = [
        {"role": "user", "content": "Search for information about Python programming language."},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "function": {
                        "name": tool_name_called,
                        "arguments": tool_args_called,
                    }
                }
            ],
        },
        {"role": "tool", "content": search_result},
    ]
    t0 = time.monotonic()
    resp = post_json(
        f"{OLLAMA_URL}/api/chat",
        {
            "model": EXPECTED_MODEL,
            "messages": synthesis_messages,
            "stream": False,
            # think: false must be top-level (not inside options) per Ollama API spec
            "think": False,
            "options": {"num_ctx": 4096},
            # No "tools" — strips tools entirely so model must write prose
        },
        timeout=120,
    )
    elapsed = time.monotonic() - t0
    content = resp.get("message", {}).get("content") or ""

    # Timing from Ollama response
    eval_count = resp.get("eval_count", 0)
    eval_duration_ns = resp.get("eval_duration", 0)
    if eval_count > 0 and eval_duration_ns > 0:
        tok_per_sec = eval_count / (eval_duration_ns / 1e9)
        print(f"         Throughput: {tok_per_sec:.1f} tok/s ({eval_count} tokens in {elapsed:.1f}s)")
        check(
            "throughput_acceptable",
            tok_per_sec >= 5.0,
            f"{tok_per_sec:.1f} tok/s — GPU acceleration may be broken (expected ≥5)",
            warn_only=True,
        )

    check("synthesis_non_empty", len(content) >= 50, f"{len(content)} chars: {content[:80]}")
    check(
        "synthesis_mentions_python",
        "python" in content.lower(),
        f"no 'python' in synthesis: {content[:150]}",
    )
except Exception as e:
    check("synthesis_non_empty", False, str(e))
    check("synthesis_mentions_python", False, "skipped")

# ── 6. AMD GPU via sysfs ──────────────────────────────────────────────────────
# Runs after tool calling and synthesis so the model is already in VRAM.
# On a cold deploy, Ollama hasn't served any requests, so VRAM is near-zero
# even though the model is on disk — checking too early would always fail.
print("\n[6] AMD GPU (sysfs)")
try:
    gpu_paths = sorted(glob.glob(f"{GPU_SYSFS}/card*/device/gpu_busy_percent"))
    if gpu_paths:
        busy = int(open(gpu_paths[0]).read().strip())
        d = os.path.dirname(gpu_paths[0])
        vram_used_bytes = int(open(f"{d}/mem_info_vram_used").read().strip())
        vram_total_bytes = int(open(f"{d}/mem_info_vram_total").read().strip())
        vram_used_mb = vram_used_bytes // (1024 * 1024)
        vram_total_mb = vram_total_bytes // (1024 * 1024)
        check("amd_gpu_visible", True)
        print(f"         GPU util : {busy}%")
        print(f"         VRAM     : {vram_used_mb:,}/{vram_total_mb:,} MB")
        # qwen3:14b in Q4 occupies ~8GB; expect at least 5GB after inference warm-up
        check(
            "gpu_model_in_vram",
            vram_used_mb > 5000,
            f"{vram_used_mb} MB used — model may not be GPU-accelerated (expected >5000 MB)",
        )
    else:
        check("amd_gpu_visible", False, f"no card* entries under {GPU_SYSFS}")
        check("gpu_model_in_vram", False, "skipped — no GPU paths found")
except Exception as e:
    check("amd_gpu_visible", False, str(e), warn_only=True)
    check("gpu_model_in_vram", False, "skipped", warn_only=True)

# ── 7. Token throughput benchmark ────────────────────────────────────────────
print("\n[7] Token throughput benchmark")
try:
    bench_prompt = (
        "Explain how transformer attention works. Cover: "
        "query/key/value matrices, scaled dot-product attention, "
        "multi-head attention, and why softmax is applied."
    )
    t0 = time.monotonic()
    resp = post_json(
        f"{OLLAMA_URL}/api/chat",
        {
            "model": EXPECTED_MODEL,
            "messages": [{"role": "user", "content": bench_prompt}],
            "stream": False,
            # think: false must be top-level (not inside options) per Ollama API spec
            "think": False,
            # num_predict intentionally omitted: qwen3:14b thinking tokens count toward
            # num_predict budget; on a cold model, thinking can exhaust 512 tokens leaving
            # no room for visible content. Let the model run to EOS within num_ctx.
            "options": {"num_ctx": 4096},
        },
        timeout=180,
    )
    elapsed = time.monotonic() - t0
    content = resp.get("message", {}).get("content") or ""
    eval_count = resp.get("eval_count", 0)
    eval_duration_ns = resp.get("eval_duration", 0)

    if eval_count > 0 and eval_duration_ns > 0:
        tok_per_sec = eval_count / (eval_duration_ns / 1e9)
        print(f"         Benchmark: {tok_per_sec:.1f} tok/s ({eval_count} tokens / {elapsed:.1f}s)")
        check(
            "benchmark_throughput_min",
            tok_per_sec >= 5.0,
            f"{tok_per_sec:.1f} tok/s < 5 tok/s — AMD Vulkan GPU acceleration may not be active",
            warn_only=True,
        )
    check(
        "benchmark_response_coherent",
        len(content) >= 100 and "attention" in content.lower(),
        f"incoherent or too short ({len(content)} chars)",
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
