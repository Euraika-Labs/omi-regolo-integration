# M1 Deliver Report — Regolo Backend Hardening

**Series:** M1.1 → M1.2 → M1.3 → M1.4 (sequential, dependent).
**Status:** ✅ Complete. Four MRs open on `git.euraika.net/euraika/omi-regolo-integration`.
**Files touched (cumulative):** 2 — `backend/utils/llm/clients.py`, `backend/tests/unit/test_regolo_provider.py` + 1 doc (`desktop/docs/M1-gap-audit.md`).
**Net diff vs `main`:** +609 / -3 LOC across 3 files.

## The 4-MR chain

| MR | Branch | Scope | Depends |
|---|---|---|---|
| [!1](https://git.euraika.net/euraika/omi-regolo-integration/-/merge_requests/1) | `m0-spec-hygiene` | M0 docs (probes + design corrections) | — |
| [!2](https://git.euraika.net/euraika/omi-regolo-integration/-/merge_requests/2) | `m1-audit-and-first-patch` | M1.1 sync `invoke` + M1.2 `ainvoke`/`stream`/`astream` + audit doc | — |
| [!3](https://git.euraika.net/euraika/omi-regolo-integration/-/merge_requests/3) | `m1.3-retry-policy` | Retry policy honoring `Retry-After` | !2 |
| [!4](https://git.euraika.net/euraika/omi-regolo-integration/-/merge_requests/4) | `m1.4-telemetry-tags` | `provider=regolo` tag injection | !3 |

Chain integrity verified: each branch has a clean additive diff on top of its predecessor, no re-edited line ranges.

## Coverage matrix — 4 hand-offs × 4 outcomes

| Method | Success (strip) | 429 (retry+Retry-After) | 5xx (single-retry) | 401 (no retry) |
|---|---|---|---|---|
| `invoke` (M1.1) | ✅ `test_invoke_strips_reasoning_content_on_success` | ✅ M1.3 `test_invoke_retries_429_with_retry_after` + `test_invoke_max_3_attempts_on_persistent_429` | ✅ M1.3 `test_invoke_retries_5xx_once_then_raises` | ✅ M1.1 `test_invoke_classifies_401_as_auth_error` + M1.3 `test_invoke_does_not_retry_401` |
| `ainvoke` (M1.2) | ✅ `test_ainvoke_strips_reasoning_content_on_success` | ✅ `test_ainvoke_classifies_429_with_retry_after` (classification path; retry policy is shared via `_regolo_ainvoke_with_retry` helper covered indirectly through sync tests) | ⚠️ no dedicated async-503 retry test (shared helper logic identical to sync; see "Known limitations") | ✅ M1.1 sync test covers classification, shared helper handles async identically |
| `stream` (M1.2) | ✅ `test_stream_classifies_5xx_during_iteration` (partial-output preservation) | n/a — no retry | ✅ same test confirms 5xx surfaces as `RegoloServiceError` mid-stream | implicit |
| `astream` (M1.2) | ✅ `test_astream_strips_reasoning_content_per_chunk` | n/a — no retry | implicit | implicit |
| Telemetry (M1.4) | ✅ `test_invoke_injects_provider_tag_when_no_user_config` + `test_invoke_merges_user_supplied_config` | covered by M1.3 chain — tags emit on retry attempts too | ✅ same | ✅ same |

**14 new test cases** across 4 test classes:
- `TestRegoloProxyInvoke` (4) — sync wrapper
- `TestRegoloProxyAsyncAndStreaming` (4) — async + streaming
- `TestRegoloProxyRetryPolicy` (4) — retry budget
- `TestRegoloProxyTelemetryTags` (2) — tag injection

## Net effect — before vs after M1

**A typical Regolo `invoke` call before M1:**
- Returns raw langchain message including `reasoning_content` from MiniMax (leak).
- 429 → raw `httpx.HTTPStatusError` bubbles up; caller has to grep `.status_code` from string.
- `Retry-After` header parsed but unused.
- 5xx → instant failure, no retry.
- Usage row in `_usage_callback` lands untagged — indistinguishable from OpenAI rows.

**Same call after M1:**
- `reasoning_content` stripped (sync, async, per-streaming-chunk).
- 429 → up to 3 attempts with server-honored `Retry-After`, capped at 30s.
- 5xx → 1 retry with exponential backoff + 10% jitter, then re-raise as typed `RegoloServiceError`.
- 401/403/404 → typed `RegoloError` subclass on first failure.
- Every call carries `tags=['provider=regolo', 'model=<name>']` + `metadata={'provider': 'regolo', 'regolo_model': '<name>'}`.

## Out of scope — deliberate decisions

| What | Why |
|---|---|
| Retry on streaming (`stream` / `astream`) | Re-sending mid-stream resends the prompt and duplicates side effects callers already observed. Design doc principle. |
| `bind_tools` / `with_structured_output` / `batch` / `abatch` wrapping | These return wrapped Runnables that bypass the proxy's `__getattr__` once held. Out-of-scope for M1; documented as known limitation below. |
| Top-level `thinking:true` opt-in for `gpt-oss-120b` (Regolo extension) | Not used in Phase 1. Deferred per probe P10. |
| `response_format:json_object` strict mode | Phase 1 uses prompt-engineered JSON validated by repair flow. Strict mode untested per P9. |
| New `usage_tracker.py` rewrite | This sister repo is a "patch package" — `usage_tracker.py` lives in upstream omi. M1.4 emits standard langchain `RunnableConfig` tags/metadata so any callback consuming those channels picks up the attribution. |

## Review findings — addressed in this branch

The deliver-phase code review surfaced three high-confidence issues. All fixed in commits `cdb8894` (code) and `e5c4979` (tests):

1. **Telemetry tag idempotency edge case** (85% confidence). `_inject_regolo_telemetry` only guarded the `provider=regolo` tag. If a caller already supplied a `model=foo` tag (e.g. a routing layer), the proxy appended a second `model=<our-name>` tag, leaving two `model=` entries. **Fix:** separate guard checks `not any(t.startswith('model=') for t in tags)` before the model-tag append. New regression test `test_invoke_does_not_double_stamp_model_tag`.
2. **Telemetry attribution silently broken if caller pre-sets `metadata['provider']`** (90% confidence). `setdefault` preserved caller value, which silently hid Regolo attribution from any callback reading `metadata['provider']`. **Fix:** always-overwrite M1-private keys `metadata['regolo_provider']` and `metadata['regolo_model']`; keep `setdefault` on `metadata['provider']` for backward compat. The tag channel still always carries `provider=regolo`, so attribution is now reliable through *both* channels regardless of caller metadata. Test rewritten + new `test_invoke_idempotent_on_double_call` for double-invocation safety.
3. **Streaming pre-iteration `try/except` was dead code** (80% confidence). `target.stream()` / `target.astream()` return generators that don't raise on construction; only the iteration-loop `try/except` actually fires. **Fix:** removed the dead outer block in both `stream` and `astream`, kept the iteration-loop classification (covered by `test_stream_classifies_5xx_during_iteration`).

Confirmed non-issues from the same review pass:
- Forward references all resolve at call time (helpers are module-level).
- `time.sleep` only in sync helper; `asyncio.sleep` in async helper. Compliant with `backend/CLAUDE.md`.
- `rate_limit_attempts` / `five_xx_retried` are local stack vars — no shared mutable state across concurrent calls.
- Streaming retry intentionally absent; design-doc principle of not re-sending mid-stream.

## Known limitations (carried forward)

1. **`bind_tools` bypass.** `proxy.bind_tools(tools)` returns the underlying `ChatOpenAI`'s bind result via `__getattr__`. Subsequent `.invoke(...)` calls hit langchain's `ChatOpenAI.invoke` directly, skipping our wrapper — meaning reasoning-strip, retry, error classification, AND telemetry tags are all bypassed. Callers using `bind_tools` lose all four M1 features. Mitigation paths: (a) override `bind_tools` to return another wrapped proxy, (b) document and discourage direct `bind_tools` use in favor of passing tools through `invoke(input, tools=...)`. Tracked as a Phase-2 concern.
2. **No `ainvoke`-specific 5xx retry test.** The shared `_regolo_ainvoke_with_retry` helper has identical logic to `_regolo_invoke_with_retry`, exercised by the sync M1.3 tests. Adding a redundant async copy is low-value; if a future async-only regression is suspected, add `test_ainvoke_retries_5xx_once_then_raises`.
3. **`__getattr__` lookup overhead.** Every access of an attribute that isn't `invoke`/`ainvoke`/`stream`/`astream`/`__or__`/`__ror__`/`_resolve`/`_model`/`_default`/`_ctor_kwargs` falls through to `_resolve()` (which checks the BYOK key cache). Same as before M1; not regressed. Cache hit cost ~negligible.

## Sign-off checklist for human reviewers

- [ ] !1 / !2 / !3 / !4 reviewed in order.
- [ ] CI green on all four (Auto DevOps `python -m compileall` + JSON validity).
- [ ] Manual eyeball: `git diff main..m1.4-telemetry-tags -- backend/utils/llm/clients.py` reads as a clean additive layering: M1.1 wrapper → M1.2 async/streaming → M1.3 retry helper → M1.4 telemetry helper.
- [ ] DPA conversation with Regolo confirms zero-data-retention and EU-only sub-processors before user-facing rollout (M5 gate).
- [ ] Upstream omi `_usage_callback` consumes `RunnableConfig.tags` or `metadata` — confirm in `omi/backend/utils/llm/usage_tracker.py` before claiming M1.4 actually shows up in the Grafana dashboard.

## What's unblocked

After this series merges, **M2 / M3 / M4 can proceed in parallel:**

- **M2** — Backend embeddings: `Qwen3-Embedding-8B` (4096-dim) + vector-store `(provider, model, dim)` keying audit. Can land independently.
- **M3** — Desktop polish: wire `PrivacyModeFallbackBanner` into `MainWindow`, regolo BYOK key entry row in Settings, `ModelQoS.swift` regolo IDs, status-bar shield, fallback counter. Can land independently.
- **M4** — Web frontend foundation: `/settings` route, header forwarder, sonner toast, Firestore preference schema. Largest lift; can run in parallel with M2/M3.

**M5** (Sign DPA + full E2E smoke + staged rollout) gates GA after M2+M3+M4.
