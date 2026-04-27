# Define Phase Consensus — Regolo Phase 1 Implementation Plan
## 2026-04-27 — Synthesized from probe-synthesis-1777280081.md (6 LLM probes)

## Scope (Phase 1 only)

In: P0 + P1 + P2 from priority matrix.
Out: P3 (embeddings adapter — defer to Phase 2). Phase 1 EU Privacy Mode keeps embeddings on OpenAI with a UI banner explaining the carve-out.

## File-by-file plan

### 1. `backend/utils/llm/clients.py` — _RegoloChatProxy enhancements

**Goals:**
- Inject `chat_template_kwargs:{enable_thinking:false}` for thinking models.
- Strip `reasoning_content` from streaming + non-streaming responses.
- Hard-code `_REGOLO_BASE_URL` (already done) and document the SSRF defense.

**Approach:**
- Maintain a module-level set `_REGOLO_THINKING_MODELS = {"minimax-m2.5", "qwen3.5-122b"}`.
- In `_get_or_create_regolo_llm()`, when the stripped api_model is in `_REGOLO_THINKING_MODELS`, pass `extra_body={"chat_template_kwargs": {"enable_thinking": False}}` to `ChatOpenAI(...)` ctor (LangChain forwards `extra_body` into the OpenAI SDK request body, which Regolo accepts as part of the OpenAI-compat surface).
- Provide a helper `strip_reasoning_content(message)` that removes `reasoning_content` from `additional_kwargs` and from streamed delta dicts. Wrap `_resolve()` results with a tiny adapter when the model is a thinking model so persistence-bound code never sees `reasoning_content`. Optional: keep the field on a separate `thinking_text` attribute for future UI use, gated behind a `regolo_expose_thinking` env flag (off by default).

**Why `extra_body` over `model_kwargs` or per-call `.bind`:** probe consensus says `model_kwargs` is unreliable on streaming nested dicts; `.bind(extra_body=...)` is reliable but spreads the concern across every call site. Putting `extra_body` on the cached `ChatOpenAI` ctor centralizes it in the proxy where Regolo quirks already live.

**Risks addressed:**
- SSRF: base_url is a private module constant, never derived from headers/user input. Add a comment + a test asserting `_REGOLO_BASE_URL.startswith("https://api.regolo.ai/v1")`.

### 2. `backend/utils/llm/regolo_errors.py` (NEW) — Auth error taxonomy

**Goal:** map Regolo HTTP responses (401/403/404/429/5xx) to distinct internal categories before they bubble up to chat/synthesis routers.

**Approach:**
- Define `RegoloError(Exception)` base + subclasses:
  - `RegoloAuthError` (401)
  - `RegoloForbiddenError` (403, model not allowed on plan tier)
  - `RegoloModelNotFoundError` (404)
  - `RegoloRateLimitError` (429, with `retry_after_s` attribute)
  - `RegoloServiceError` (5xx, treated as fallback-eligible)
- Export `classify_regolo_error(exc)` that consumes a langchain/openai client exception, inspects status_code, and returns the appropriate subclass.
- Used by the dispatcher (next file) to decide fallback behavior.

### 3. `backend/utils/llm/eu_privacy.py` (NEW) — EU Privacy Mode dispatcher

**Goal:** global toggle that re-routes supported workloads to `regolo/*` and HARD-BLOCKS unsupported workloads (no silent OpenAI fallback that would leak EU user data).

**Approach (REVISED after debate gate):**
- Toggle source: `database.users.get_eu_privacy_mode(uid) -> bool` (Firestore `users/{uid}.eu_privacy_mode`).
- **No long TTL cache.** A 60s TTL would create a 60s data-spillage window if a toggle-OFF→ON failed to invalidate. Instead: per-request Firestore read into a request-scoped contextvar `_eu_privacy_ctx`, set once by middleware, used by all downstream `resolve_feature_model` calls. One Firestore read per request — fine for the affected user population (privacy-conscious EU users are not the hot path).
- Whitelist of regolo-supported features (Phase 1):
  ```python
  REGOLO_SUPPORTED_FEATURES = {
      'chat_responses', 'conv_action_items', 'conv_structure',
      'memories', 'memory_conflict', 'goals_advice', 'app_generator',
  }
  REGOLO_HARD_BLOCKED_FEATURES = {
      'chat_agent',     # Anthropic-only
      'web_search',     # Perplexity
      'vision',         # qwen3-vl-32b not on PAYG
      # Embedding features handled separately — see below.
  }
  ```
- **Embeddings hard-block:** when EU mode is ON, ANY feature that depends on embedding generation (memory semantic search, knowledge graph entity search) returns a hard-block error with banner `"Memory search is disabled in EU Privacy Mode. Disable it to use this feature."`. NO fallback request to OpenAI. This is the difference between "disclosed leak" and "no leak."
- New helper `resolve_feature_model(uid, feature) -> tuple[str, FeatureRouteOutcome]`. Outcomes: `regolo_route(model)`, `primary_route(model, banner=None)`, `hard_block(banner)`. Callers must handle all three.
- When EU mode is on AND feature is in the whitelist: returns `regolo_route('regolo/<chosen_model>')`. The chosen model comes from a new `MODEL_QOS_PROFILES['eu']` profile entry.
- When EU mode is on AND feature in HARD_BLOCKED: returns `hard_block(banner)` — backend route MUST 4xx with banner detail, never silently fall back.

**Banner emission:**
- New `BannerInfo(BaseModel)`: `{type: 'eu_carveout' | 'eu_outage', message: str, request_id: str}`.
- Backend chat/synthesis endpoints attach the banner to the response payload so the client can show it. Banner is per-request, never silenced server-side.

### 4. `backend/routers/users.py` — Settings endpoint

Add `POST /v1/users/me/eu-privacy-mode` with `{enabled: bool}` body. Updates Firestore user doc and busts the TTL cache via `eu_privacy.invalidate_cache(uid)`. No auth changes needed (re-uses `get_current_user_uid`).

### 5. `backend/database/users.py` — Firestore field

Add `get_eu_privacy_mode(uid) -> bool` and `set_eu_privacy_mode(uid, value: bool)`. Reads `users/{uid}.eu_privacy_mode` (default False).

### 6. Streaming tool-call accumulator (Gap 3) — LIVE PROBE then decide (REVISED)

**Decision:** the stubbed-test approach was optimistic — assumes Regolo deltas exactly match OpenAI. Instead:
- **Phase 1 prerequisite step:** run a live one-shot probe against `https://api.regolo.ai/v1/chat/completions` with `stream=true` + `tools=[…]` against `regolo/Llama-3.3-70B-Instruct`, capture the raw SSE delta sequence to a fixture file.
- **If deltas exactly match OpenAI shape:** ship without a custom accumulator. The fixture replay test in `test_regolo_provider.py` doubles as the regression guard.
- **If deltas diverge:** write the accumulator NOW (in `_RegoloChatProxy`'s stream wrapper), and the fixture becomes the test input. Do not defer.
- The live-probe fixture commits to `backend/tests/fixtures/regolo_tool_call_stream.json` so future Regolo upgrades can be diffed against it.

### 7. Desktop `BYOKProvider.regolo` (Gap 5) — Phase 1 minimum

**Files:**
- `desktop/Desktop/Sources/APIKeyService.swift` — add `.regolo` case to `BYOKProvider`, with `dev_regolo_api_key` storage key, `X-BYOK-Regolo` header, display name "Regolo (EU Privacy)".
- `desktop/Desktop/Sources/BYOKValidator.swift` — add `pingRegolo(key:)` that does `GET https://api.regolo.ai/v1/models` with `Authorization: Bearer <key>` and returns ok/auth-failed/network-error.
- `desktop/Desktop/Sources/APIClient.swift` — include `X-BYOK-Regolo` in the standard BYOK header propagation (already routes other BYOK headers; just add the new key).
- `desktop/Desktop/Sources/SettingsKeysView.swift` — add a row for the Regolo key with a "Test connection" button that calls `BYOKValidator.pingRegolo`.

**Out of scope for Phase 1 desktop work:** the standalone "EU Privacy Mode" toggle UI (red banner, status-bar shield icon). Phase 1 only enables BYOK key entry and validation; the toggle is server-side via the `/v1/users/me/eu-privacy-mode` endpoint, exposed in a follow-up desktop PR.

### 8. Tests (Gap 7) — `backend/tests/unit/test_regolo_provider.py` (NEW)

Test cases:
1. `test_classifier_recognizes_regolo_prefix` — covers existing branch.
2. `test_classifier_does_not_misroute_openrouter` — `google/gemini-...` and `anthropic/claude-...` still map to openrouter.
3. `test_get_or_create_regolo_llm_strips_prefix` — the cached `ChatOpenAI` is instantiated with the bare model name.
4. `test_get_or_create_regolo_llm_uses_byok_when_set` — `_RegoloChatProxy._resolve()` returns BYOK-keyed client when contextvar is populated.
5. `test_thinking_models_get_enable_thinking_false` — `extra_body` contains `chat_template_kwargs:{enable_thinking:False}` for `regolo/minimax-m2.5` but NOT for `regolo/Llama-3.3-70B-Instruct`.
6. `test_strip_reasoning_content_removes_field` — both single-message and streaming-delta variants.
7. `test_regolo_error_classifier` — 401 -> RegoloAuthError, 429 with Retry-After -> RegoloRateLimitError(retry_after_s=N), etc.
8. `test_eu_privacy_mode_routes_supported_feature` — when toggle on + feature in whitelist, returns regolo model.
9. `test_eu_privacy_mode_falls_back_for_unsupported` — vision feature returns primary + banner.
10. `test_regolo_base_url_is_constant` — SSRF defense.

Add `pytest tests/unit/test_regolo_provider.py -v` to `backend/test.sh`.

## Cross-cutting concerns

- **Logging:** never log `reasoning_content`, BYOK keys, or full request bodies. Use `sanitize()` on Regolo error responses before they hit the logger. Status codes + model name + feature are the safe fields.
- **Async I/O:** all Regolo calls go through `langchain_openai.ChatOpenAI` which is httpx-backed under the hood. No new `requests.*` introduced. The Firestore `eu_privacy_mode` read is sync (matches existing `database.users` pattern).
- **Import hierarchy:** `eu_privacy.py` lives in `utils/llm/` so it can read from `database.users` (lower) and be imported by `routers/chat.py` (higher). No reverse imports.
- **Cache invalidation:** the 60s TTL cache for `eu_privacy_mode` means a tenant-wide flip propagates within a minute. The `invalidate_cache(uid)` hook from the settings endpoint provides instant per-user busting. No thundering herd because each user busts only their own entry.

## Estimated LOC and effort

| Item | New | Modified | LOC |
|---|---|---|---|
| `utils/llm/clients.py` enhancements | — | yes | ~60 |
| `utils/llm/regolo_errors.py` | yes | — | ~80 |
| `utils/llm/eu_privacy.py` | yes | — | ~150 |
| `routers/users.py` toggle endpoint | — | yes | ~30 |
| `database/users.py` getter/setter | — | yes | ~15 |
| `tests/unit/test_regolo_provider.py` | yes | — | ~250 |
| `desktop/.../APIKeyService.swift` | — | yes | ~20 |
| `desktop/.../BYOKValidator.swift` | — | yes | ~30 |
| `desktop/.../APIClient.swift` | — | yes | ~5 |
| `desktop/.../SettingsKeysView.swift` | — | yes | ~40 |
| `backend/test.sh` | — | yes | ~1 |
| **Total** | **3 new** | **8 modified** | **~680** |

Budget: 1.5 days backend + 0.5 day desktop + 0.5 day tests/integration = **2.5 days**.

## Critical risks (from probe gaps)

1. **Auth taxonomy leakage**: a generic 500 to the client when Regolo returns 401 hides credential compromise. Mitigation: `RegoloAuthError` maps to a 401 response from our backend with a distinct error code so the client can prompt re-auth.
2. **SSRF**: base_url constant + test assertion + no header-driven URL.
3. **Streaming nondeterminism**: shadow-test before writing custom accumulator; if accumulator is needed, it goes in a follow-up PR with full streaming integration tests.
4. **Toggle thrash**: 60s TTL + per-user bust prevents cache-invalidation thundering herd.
5. **Embedding lock-in**: explicitly carved out of Phase 1; banner tells users which features stay on OpenAI.

## Acceptance gate (when Phase 1 ships)

1. EU Privacy Mode toggle persists in Firestore and survives a backend restart.
2. With toggle ON for a test user, `chat_responses` requests show `provider=regolo, model=regolo/minimax-m2.5` in usage tracker.
3. Thinking-knob test passes — minimax-m2.5 returns content (not null).
4. Vision/web-search/memory-search requests are HARD-BLOCKED (4xx + banner), NOT silently fallen-back.
5. Network capture during EU mode shows ZERO requests to api.openai.com / generativelanguage.googleapis.com / api.perplexity.ai for blocked features.
6. BYOK Regolo key entry on desktop validates against `GET /v1/models`.
7. New unit tests in `test.sh` pass; existing `test_byok_security.py` still green.
8. `python scripts/lint_async_blockers.py` clean.
9. Live probe fixture for tool-call streaming committed and replay test passes.
