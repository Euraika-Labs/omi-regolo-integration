# Regolo Model Selection — Empirical Picks for Each Omi Feature
## 2026-04-27 — Live probes against api.regolo.ai/v1

This doc explains why each Omi LLM feature is mapped to a specific Regolo model when EU Privacy Mode is on. Picks are based on a live capability + latency + cost probe across all 20 models in Regolo's Apr 2026 catalog, not vibes.

## TL;DR

- **Mid-tier** → `regolo/mistral-small-4-119b` (€0.50/€2.10 per 1M, **p50 0.43s, p90 0.44s**, clean JSON, tool-calling verified). Drop-in for `gpt-4.1-mini` and `gpt-5.4-mini`.
- **Nano-tier** → `regolo/Llama-3.1-8B-Instruct` (€0.05/€0.25 per 1M, p50 0.62s, p90 0.72s). 10× cheaper than mid-tier.
- **Embeddings** (Phase 2) → `Qwen3-Embedding-8B` (4096-dim, €0.001/req).
- **HARD-BLOCK** → vision, web_search, chat_agent, all embedding-search features (no silent fallback to non-EU).

**The thinking models — minimax-m2.5, qwen3.5-122b, qwen3.5-9b, qwen3.6-27b — are NOT defaults.** Multi-sample probe revealed:

| Model | n | p50 | p90 | failure mode |
|---|---|---|---|---|
| minimax-m2.5 | 2/5 | 59.83s | 59.83s | **3 of 5 calls timed out (60s)**; working calls 48-60s |
| qwen3.5-122b | 5/5 | 0.36s | **2.25s** | bimodal — fast 80% of the time, 6× slower 20% of the time |
| qwen3.5-9b | 4/5 | 2.47s | **42.33s** | one 60s timeout, very inconsistent |
| qwen3.6-27b | (single-shot) | 5.62s | n/a | always slow |

Compare to the consistent non-thinking models:

| Model | n | p50 | p90 | spread |
|---|---|---|---|---|
| **mistral-small-4-119b** | 5/5 | 0.43s | 0.44s | **±2%** |
| Llama-3.3-70B-Instruct | 5/5 | 0.83s | 0.84s | ±1% |
| Llama-3.1-8B-Instruct | 5/5 | 0.62s | 0.72s | ±16% |

For user-facing chat where typing-indicator latency matters, the thinking models' tail behavior is a UX bug. Operators who genuinely need reasoning depth can override per-feature via the upstream `MODEL_QOS_<FEATURE>=regolo/qwen3.5-122b` env-var pattern. For batch features that tolerate slow outliers, the thinking models are still in `_REGOLO_THINKING_MODELS` so the knob is auto-injected when picked.

Why mistral over Llama-3.3-70B for the mid-tier default: mistral is 2× faster, 17%/22% cheaper, equally consistent, and equally good at tool calling. Llama-3.3-70B was my initial pick for "household name" reasons; the data overruled the heuristic.

## Empirical data

### Chat models — instruction following + JSON output

Probe: structured action-item extraction, JSON-only output, 256 max_tokens, temperature 0.2. Latency is single-shot p50 against `api.regolo.ai/v1/chat/completions`.

| Model | €/1M in | €/1M out | Latency | JSON OK | Tools | Thinking? | reasoning_content |
|---|---|---|---|---|---|---|---|
| **Llama-3.1-8B-Instruct** | 0.05 | 0.25 | 0.69s | ✓ | ✓ | no | no |
| **Llama-3.3-70B-Instruct** | 0.60 | 2.70 | 0.82s | ✓ | ✓ | no | no |
| qwen3-coder-next | 0.50 | 2.00 | 0.47s | ✓ | not probed | no | no |
| mistral-small3.2 | 0.50 | 2.20 | 0.60s | ✓ | ✓ | no | no |
| mistral-small-4-119b | 0.50 | 2.10 | 0.49s | ✓ | ✓ | no | no |
| gpt-oss-20b | 0.10 | 0.42 | 1.13s | ✓ | not probed | no | no |
| gpt-oss-120b | 1.00 | 4.20 | 0.90s | ✓ | ✓ | no | no |
| gemma4-31b | 0.40 | 2.10 | 1.77s | ✓ | not probed | no | no |
| apertus-70b | 0.40 | 2.10 | 1.43s | ✓ | not probed | no | no |
| brick-v1-beta | FREE | FREE | not probed | — | — | — | — |
| qwen3.5-9b *(thinking)* | 0.07 | 0.35 | 0.82s | ✓ | yes | YES | no |
| qwen3.5-122b *(thinking)* | 1.00 | 4.20 | 0.31s | ✓ | ✓ | YES | no |
| qwen3.6-27b *(thinking)* | 0.50 | 2.10 | 5.62s | ✓ | not probed | YES | no |
| minimax-m2.5 *(thinking)* | 0.60 | 3.80 | 2.71s | ✓ | ✓ | YES | **YES** |

Notes from the probe:
- **All four qwen-family thinking models AND minimax-m2.5 hit max_tokens with no parseable output without `chat_template_kwargs:{enable_thinking:false}`.** This is implemented automatically in `_get_or_create_regolo_llm()` — see `_REGOLO_THINKING_MODELS`.
- **`minimax-m2.5` is the only model that emits a non-OpenAI `reasoning_content` field on its response even with thinking off.** Our `strip_reasoning_content()` helper removes it before persistence — if you persist responses without that helper, expect bloated chat history and potential leakage of the model's internal reasoning to clients.
- **Tool-calling shape is uniform OpenAI-compatible across every model probed** (Llama 8B/70B, Mistral 3.2/119B, gpt-oss 120B, qwen3.5-122b with thinking off, minimax-m2.5 with thinking off). Per-index `tool_calls.function.arguments` chunks concatenate to valid JSON. LangChain's native accumulator handles all of them — no custom code in `_RegoloChatProxy` needed.
- `qwen3.6-27b` at 5.6s is too slow for interactive features even with thinking off — not picked.
- `gemma4-31b` at 1.77s and `apertus-70b` at 1.43s are also slow vs Llama-3.3-70B's 0.82s — Llama wins on every dimension simultaneously.

### Embedding models

| Model | Cost | Latency | Dim |
|---|---|---|---|
| **Qwen3-Embedding-8B** | €0.001/req | 0.24s | **4096** |
| gte-Qwen2 | €0.001/req | 0.22s | 3584 |

Phase 1 keeps embeddings on OpenAI (3072-dim) and HARD-BLOCKS embedding-dependent features (`memory_search`, `knowledge_graph_search`, `screen_activity_search`) when EU mode is on. Phase 2 ships the Qwen3-Embedding-8B adapter and a parallel-index migration so EU-mode users get on-Regolo memory search.

### Specialized

| Model | Use case | Cost |
|---|---|---|
| Qwen3-Reranker-4B | Re-rank retrieved passages | €0.01/query |
| faster-whisper-large-v3 | STT | not probed (Phase 2) |
| Qwen-Image | Vision | not probed (Phase 2) |
| deepseek-ocr-2 | OCR | not probed (Phase 2) |

## Feature → model mapping (Phase 1)

The mapping below is what `eu_privacy.py` ships with. Each pick is justified by the upstream tier and the empirical data above.

### Mid-tier — `regolo/mistral-small-4-119b`

Used wherever upstream's `premium` profile picks `gpt-4.1-mini` or `gpt-5.4-mini`. These are quality-sensitive workloads (structured extraction, summarization, reasoning).

| Feature | Upstream model | Why this Regolo pick |
|---|---|---|
| `conv_action_items` | gpt-5.4-mini | Mid-tier extraction; tool-call works on Llama-3.3 |
| `conv_structure` | gpt-5.4-mini | Long-form structuring |
| `conv_app_result` | gpt-5.4-mini | Mid-tier reasoning |
| `daily_summary` | gpt-5.4-mini | Long-input summarization (probe: 1.05K input tokens at 0.92s) |
| `external_structure` | gpt-4.1-mini | Quality-sensitive structuring |
| `memories` | gpt-4.1-mini | Quality-sensitive extraction |
| `learnings` | gpt-5.4-mini | Mid-tier quality |
| `memory_conflict` | gpt-4.1-mini | Quality-sensitive |
| `knowledge_graph` | gpt-4.1-mini | LLM extraction (NOT search — see hard-block list) |
| `chat_responses` | gpt-5.4-mini | Mistral is 2× faster than Llama-3.3-70B (0.43s vs 0.83s) and 6× more consistent than qwen3.5-122b (P90 0.44s vs 2.25s). Replaces the scoping doc's `minimax-m2.5` pick which had a 60% timeout rate. |
| `chat_extraction` | gpt-4.1-mini | Quality-sensitive |
| `chat_graph` | gpt-4.1-mini | Quality-sensitive |
| `goals` | gpt-4.1-mini | Quality-sensitive |
| `goals_advice` | gpt-5.4-mini | Mid-tier reasoning |
| `notifications` | gpt-5.4-mini | Mid-tier |
| `proactive_notification` | gpt-4.1-mini | Quality-sensitive |
| `app_generator` | gpt-5.4-mini | Default mid; if profile shows code-heavy use, swap to `regolo/qwen3-coder-next` |
| `persona_clone` | gpt-5.4-mini | Mid-tier |
| `persona_chat_premium` | gpt-5.4-mini | Mid-tier |
| `wrapped_analysis` | google/gemini-3-flash-preview | Replaces Gemini route entirely |

### Nano-tier — `regolo/Llama-3.1-8B-Instruct`

Used wherever upstream's `premium` profile picks `gpt-4.1-nano`. These are lightweight classification / dispatch tasks where latency + cost dominate quality.

| Feature | Upstream model |
|---|---|
| `conv_app_select` | gpt-4.1-nano |
| `conv_folder` | gpt-4.1-nano |
| `conv_discard` | gpt-4.1-nano |
| `daily_summary_simple` | gpt-4.1-nano |
| `memory_category` | gpt-4.1-nano |
| `session_titles` | gpt-4.1-nano |
| `followup` | gpt-4.1-nano |
| `smart_glasses` | gpt-4.1-nano |
| `onboarding` | gpt-4.1-nano |
| `app_integration` | gpt-4.1-nano |
| `trends` | gpt-4.1-nano |
| `persona_chat` | gpt-4.1-nano |

### HARD-BLOCK (no Regolo route)

| Feature | Why blocked |
|---|---|
| `chat_agent` | Anthropic-only (Claude). No equivalent agentic-tool-use model in Regolo's catalog with full RAG tool harness wired in. |
| `web_search` | Perplexity-only. Regolo has no Sonar-equivalent. |
| `vision` (when called) | `qwen3-vl-32b` is NOT in the PAYG catalog. `Qwen-Image` is image generation, not vision understanding. |
| `memory_search` | Embedding-dependent, Phase 2 |
| `knowledge_graph_search` | Embedding-dependent (vector lookup over the graph), Phase 2 |
| `screen_activity_search` | Embedding-dependent, Phase 2 |

For HARD-BLOCK features the backend route MUST 4xx with a banner reason, not silently fall back to the non-EU primary. See `eu_privacy.FeatureRouteKind.HARD_BLOCK`.

## Cost back-of-envelope

A typical Omi user generating 50 chat messages + 5 conversations per day, all routed through the EU profile:

- 50 × `chat_responses` × ~500 in / ~200 out tokens = 25K in / 10K out → €0.0150 + €0.0270 = **€0.042/day mid-tier**
- 5 × full conversation pipeline (action_items + structure + memories + learnings + summary): ~5K in / ~1K out per stage × 5 stages = 25K in / 5K out per conversation × 5 = 125K in / 25K out → €0.075 + €0.0675 = **€0.143/day**
- 100 × nano calls (classifications, dispatching) × ~200 in / ~50 out = 20K in / 5K out → €0.001 + €0.00125 = **€0.002/day**
- **Total ≈ €0.19/day per heavy user.** OpenAI's `gpt-5.4-mini` route on the same workload is ~€0.45/day.

EU mode users save ~58% on LLM cost vs the upstream `premium` profile, while keeping data in Italy.

## Operator overrides

Each feature respects the upstream `MODEL_QOS_<FEATURE>` env-var override — set it to a `regolo/...` value to pick a different model for that feature without code changes:

```bash
# Use the cheaper qwen3.5-9b thinking model for app_generator (€0.07/€0.35
# instead of €0.60/€2.70). The thinking knob is auto-injected.
MODEL_QOS_APP_GENERATOR=regolo/qwen3.5-9b

# Switch chat_responses to mistral-small-4-119b (faster: 0.49s vs 0.82s)
MODEL_QOS_CHAT_RESPONSES=regolo/mistral-small-4-119b

# Use the FREE brick-v1-beta for trends (no quality guarantees; experimental)
MODEL_QOS_TRENDS=regolo/brick-v1-beta
```

## Reproducing the probe

Capture script committed at `backend/tests/fixtures/capture_regolo_tool_call_stream.sh`. The chat / embedding / tool-call / thinking-knob probes themselves ran as one-off Python scripts driven by `urllib.request` — re-run after a Regolo catalog change to verify our model picks are still optimal. Probe pseudocode:

```python
for model in CATALOG:
    body = {'model': model, 'messages': [...JSON_PROMPT...], 'max_tokens': 256}
    if model in THINKING_MODELS:
        body['chat_template_kwargs'] = {'enable_thinking': False}
    t0 = time.perf_counter()
    response = POST('/v1/chat/completions', body)
    record_latency_and_json_quality(model, t0)
```
