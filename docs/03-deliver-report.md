# Delivery Report — Regolo Phase 1
## 2026-04-27 — Worktree: regolo-provider

## What shipped

### P0 (must-have for Phase 1)

- **Thinking-knob injection** — `_get_or_create_regolo_llm()` now passes `extra_body={"chat_template_kwargs":{"enable_thinking":False}}` for `regolo/minimax-m2.5` and `regolo/qwen3.5-122b`. These models otherwise return `content:null, finish_reason:length`.
- **Desktop BYOKProvider.regolo** — `.regolo` enum case with storage key `dev_regolo_api_key`, header `X-BYOK-Regolo`, display name "Regolo (EU Privacy)". `BYOKProvider.requiredProviders` split keeps the BYOK-free-plan gate at 4 (existing users not impacted). `BYOKValidator` pings `GET https://api.regolo.ai/v1/models` with Bearer auth.

### P1 (planned for Phase 1)

- **EU Privacy Mode dispatcher** (`backend/utils/llm/eu_privacy.py`) — request-scoped contextvar, `resolve_feature_model(uid, feature)` returns `FeatureRoute(REGOLO|PRIMARY|HARD_BLOCK)`. Embedding-dependent features (`memory_search`, `knowledge_graph`, `screen_activity_search`), `chat_agent`, `web_search`, and `vision` HARD-BLOCK in EU mode — no silent fallback.
- **Auth error taxonomy** (`backend/utils/llm/regolo_errors.py`) — `RegoloAuthError`/`RegoloForbiddenError`/`RegoloModelNotFoundError`/`RegoloRateLimitError`/`RegoloServiceError` with `fallback_eligible` flag and `retry_after_s` parsing for 429.
- **Settings endpoint** — `POST/GET /v1/users/me/eu-privacy-mode` persists/reads `users/{uid}.eu_privacy_mode`.

### P2 (tests + reasoning_content)

- **`reasoning_content` stripper** — `strip_reasoning_content(message)` mutates `additional_kwargs` and dict deltas to drop the field before persistence.
- **Behavioral test suite** — `backend/tests/unit/test_regolo_provider.py` (332 LOC, 21 cases) covering classifier ordering, factory prefix-strip, thinking-knob injection (positive + negative), reasoning_content strip variants, error classification, EU dispatcher (off/on/hard_block/unknown), and the new fail-closed Firestore default.

### P3 (deferred per plan + debate consensus)

- **Streaming tool-call accumulator** — deferred. Phase 1 prerequisite remaining: live probe + fixture capture against `regolo/Llama-3.3-70B-Instruct` + `tools=[…]` to verify LangChain's native OpenAI accumulator handles Regolo's deltas.
- **Embeddings adapter** — deferred to Phase 2. EU mode HARD-BLOCKS embedding-dependent features instead of silently falling back to OpenAI; users see an explicit banner.

## Debate-gate corrections applied

- **Define→Develop debate (Gemini)** flagged 4 risks:
  1. 60s TTL cache → data spillage window. **Fixed**: removed TTL cache, switched to per-request Firestore read into contextvar.
  2. Banner-only fallback for embeddings still leaks data. **Fixed**: hard-block embedding features instead.
  3. Stub-only streaming validation is optimistic. **Fixed in plan**: live probe is a Phase 1 prerequisite step.
  4. Cache key cross-pollination. Already addressed — `_llm_cache` keys include the full model name.

- **Develop→Deliver debate (Gemini)** flagged 4 risks:
  1. Sync Firestore in async path. **Documented as architectural follow-up** — matches existing `byok.py` pattern; not a regolo-specific bug.
  2. EU residency violated when Firestore down (default OFF). **Fixed**: now defaults to ON (fail-closed); operators can opt-out via `REGOLO_EU_FAIL_OPEN=1`.
  3. Per-request cache misses cross-request optimization. **Rejected** — deliberate trade-off after debate-1's data-spillage finding.
  4. Contextvar bleed into background tasks. **Fixed**: added `clear_eu_privacy_context()` helper with docstring guidance for background-task entry points.

## Verification

- ✅ AST syntax valid on all 8 modified Python files
- ✅ `python scripts/lint_async_blockers.py` clean
- ✅ Existing `test_byok_security.py` provider-set assertion updated to include `regolo`; production constants assertion kept (still passes — required set unchanged)
- ✅ New `test_regolo_provider.py` wired into `backend/test.sh`
- ✅ Desktop CHANGELOG entry added
- ✅ Background `feature-dev:code-reviewer` agent launched for additional review pass

## Files

| File | Status | LOC |
|---|---|---|
| `backend/utils/llm/clients.py` | Modified | +120 |
| `backend/utils/llm/regolo_errors.py` | New | 170 |
| `backend/utils/llm/eu_privacy.py` | New | 216 |
| `backend/utils/byok.py` | Modified | +1 |
| `backend/database/users.py` | Modified | +19 |
| `backend/routers/users.py` | Modified | +34 |
| `backend/tests/unit/test_byok_security.py` | Modified | +2/-2 |
| `backend/tests/unit/test_regolo_provider.py` | New | 332 |
| `backend/test.sh` | Modified | +1 |
| `desktop/Desktop/Sources/APIKeyService.swift` | Modified | +20/-4 |
| `desktop/Desktop/Sources/BYOKValidator.swift` | Modified | +6 |
| `desktop/CHANGELOG.json` | Modified | +1 |

**Total:** ~921 LOC (591 production + 332 tests). Plan budget was ~680 LOC — came in slightly over due to thorough error taxonomy module and test coverage.

## Acceptance gate status

1. ✅ EU Privacy Mode toggle persists in Firestore via `set_eu_privacy_mode`.
2. ⏳ Live verification: with toggle ON, `chat_responses` routes to `regolo/minimax-m2.5` — needs end-to-end run on staging.
3. ⏳ Thinking-knob test passes against live Regolo — covered by unit test, needs live confirmation.
4. ✅ Vision/web-search/memory-search HARD-BLOCK with banner (covered by `test_eu_on_*_hard_blocks` cases).
5. ⏳ Network capture during EU mode — needs staging deploy + tcpdump.
6. ⏳ Desktop BYOK Regolo key entry validates against `/v1/models` — needs UI smoke test (Settings pane work is in a follow-up PR per Phase 1 minimum).
7. ✅ New tests in `test.sh`, existing `test_byok_security.py` still green (header set assertion updated).
8. ✅ `lint_async_blockers.py` clean.
9. ⏸ Live probe fixture for tool-call streaming — Phase 1 prerequisite, not yet captured.

## Next-steps recommendation

1. **Run staging end-to-end** before merging — verify acceptance gates 2, 3, 5, 6 against a real Regolo key.
2. **Capture the streaming tool-call fixture** (gate 9) — one shell session with curl, commit to `backend/tests/fixtures/regolo_tool_call_stream.json`.
3. **Follow-up PR for desktop Settings UI** — Privacy Mode toggle, Regolo key entry, "Test connection" button. Out of Phase 1 scope per consensus.
4. **Phase 2**: Qwen3-Embedding-8B 4096-dim adapter + parallel vector index migration. Lifts the embedding hard-block.
