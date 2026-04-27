# omi-regolo-integration

Phase 1 integration package adding [regolo.ai](https://regolo.ai) as an LLM provider to [Omi](https://github.com/BasedHardware/omi), with an opt-in **EU Privacy Mode** that re-routes supported workloads to Italy-hosted, GDPR-compliant infrastructure and HARD-BLOCKS unsupported ones (no silent fallback to non-EU providers).

This repo contains the Omi-side patches as a standalone integration package — drop the files into the matching paths in an Omi checkout and they merge cleanly on top of the upstream.

## What's in here

```
backend/
  utils/byok.py                        + 'regolo' header
  utils/llm/clients.py                 regolo classifier + _RegoloChatProxy
                                       + thinking-knob + reasoning_content stripper
  utils/llm/regolo_errors.py           NEW — auth/rate-limit/service taxonomy
  utils/llm/eu_privacy.py              NEW — request-scoped dispatcher,
                                       fail-CLOSED on Firestore outage
  database/users.py                    + get/set_eu_privacy_mode
  routers/users.py                     + POST/GET /v1/users/me/eu-privacy-mode
                                       + optional 'regolo' BYOK fingerprint
  tests/unit/test_byok_security.py     header-set assertion updated
  tests/unit/test_regolo_provider.py   NEW — 21 cases covering the new code paths
  tests/fixtures/                      live capture script + captured tool-call stream
  test.sh                              + new pytest invocation

desktop/
  Desktop/Sources/APIKeyService.swift  + .regolo enum case + requiredProviders split
  Desktop/Sources/BYOKValidator.swift  + .regolo ping at /v1/models
  CHANGELOG.json                       user-facing entry
  docs/REGOLO_INTEGRATION.md           authoritative scoping doc (Apr 2026 probes)

docs/
  01-discover-synthesis.md             6-LLM probe synthesis
  02-define-plan.md                    file-by-file Phase 1 plan
  03-deliver-report.md                 delivery report incl. debate-gate fixes
```

## Provider basics

- **Endpoint**: `https://api.regolo.ai/v1` (OpenAI-compatible — drop-in `langchain_openai.ChatOpenAI`)
- **Auth**: `Authorization: Bearer <key>` (BYOK header `X-BYOK-Regolo` per request)
- **Models tagged with `regolo/` prefix**: e.g. `regolo/Llama-3.3-70B-Instruct`. The classifier strips the prefix before sending to the API.
- **Thinking models**: `regolo/minimax-m2.5`, `regolo/qwen3.5-122b` automatically get `extra_body={"chat_template_kwargs":{"enable_thinking":False}}` injected; without it they return `content:null, finish_reason:length`.

## EU Privacy Mode

Toggle via `POST /v1/users/me/eu-privacy-mode {"enabled": true}`. When ON:

| Feature category | Behaviour |
|---|---|
| `chat_responses`, conversation post-processing, memory extraction, daily summaries | Routed to a `regolo/*` model |
| `chat_agent` (Anthropic), `web_search` (Perplexity), `vision` (qwen3-vl-32b absent on PAYG) | **HARD-BLOCKED** — backend returns 4xx + banner |
| Embedding-dependent features (`memory_search`, `knowledge_graph`, `screen_activity_search`) | **HARD-BLOCKED** until Phase 2 ships the Qwen3-Embedding-8B 4096-dim adapter |
| Anything we forgot to categorize | **HARD-BLOCKED** by default with a "not yet certified" banner |

**Fail-closed default**: if Firestore is unreachable while reading the toggle, the dispatcher defaults to ON (privacy-first). Operators trading strict residency for availability can set `REGOLO_EU_FAIL_OPEN=1`.

## Streaming tool-call validation

`backend/tests/fixtures/regolo_tool_call_stream.json` is a live-captured SSE stream from `Llama-3.3-70B-Instruct` with `stream=true` + `tool_choice:auto`. Verified shape-equivalent to OpenAI:

- `chat.completion.chunk` object type
- Per-index `tool_calls.function.arguments` chunks concatenate to valid JSON (`"" + '{"city": "' + 'Paris"}' + ""` → `{"city": "Paris"}`)
- Final chunk: `finish_reason: "tool_calls"`

Conclusion: LangChain's native OpenAI accumulator handles Regolo's tool-call deltas — **no custom accumulator needed**.

Re-run the capture after a Regolo upgrade:

```bash
REGOLO_API_KEY=<your-key> bash backend/tests/fixtures/capture_regolo_tool_call_stream.sh
```

## Acceptance gates

| # | Gate | Status |
|---|---|---|
| 1 | EU mode toggle persists in Firestore | ✅ |
| 2 | EU mode + `chat_responses` routes to `regolo/minimax-m2.5` | ⏳ staging |
| 3 | minimax-m2.5 returns content (thinking-knob works) | ⏳ live |
| 4 | Vision/web-search/memory-search HARD-BLOCK with banner | ✅ unit-tested |
| 5 | Network capture confirms zero non-EU traffic for blocked features | ⏳ staging |
| 6 | Desktop key entry validates against `/v1/models` | ✅ ping wired |
| 7 | Tests in `test.sh`; existing BYOK tests still green | ✅ |
| 8 | `lint_async_blockers.py` clean | ✅ |
| 9 | Streaming tool-call fixture committed; replay test passes | ✅ |

## What's NOT in Phase 1

- **Embeddings adapter** (Qwen3-Embedding-8B 4096-dim) → Phase 2. Hard-blocked in EU mode meanwhile.
- **Desktop Privacy Mode toggle UI** — the BYOK key entry is wired; the standalone Settings › Privacy panel is a follow-up PR.
- **Custom streaming accumulator** — captured fixture confirmed it's not needed.

## Provenance

Built via the [`/octo:embrace`](https://github.com/nyldn/claude-octopus) full-Diamond workflow (Discover → Define → Develop → Deliver) with two adversarial debate gates (Define→Develop, Develop→Deliver). Multi-LLM input from Claude Sonnet, Codex, Gemini, and Copilot; debate-gate critique by Gemini-2.5-pro. See `docs/01-discover-synthesis.md` for the cross-provider synthesis and `docs/03-deliver-report.md` for the debate-gate corrections.
