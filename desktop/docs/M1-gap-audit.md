# M1 Gap Audit — Regolo Backend Hardening

**Branch:** `m1-audit-and-first-patch`.
**Scope:** grade each M1 acceptance criterion against the sister repo's current state. Identify the smallest valuable patch for an immediate follow-up.
**Method:** static inspection only — no code execution. Cited file:line everywhere.

## Summary verdict

The error-classification, reasoning-content-stripping, and Retry-After-extraction **helpers are written and well-tested** — but they are **not wired into the request hand-off**. `_RegoloChatProxy.__getattr__` (`backend/utils/llm/clients.py:142`) is a thin transparent forwarder that delegates straight to `langchain_openai.ChatOpenAI`, bypassing every custom helper. The M1 work is to interpose at that hand-off.

Telemetry tagging is the largest gap — there is no `provider=regolo` tag on the usage callback path.

| # | Criterion | Verdict | Cited evidence |
|---|---|---|---|
| 1 | Streaming tool-call accumulator | ✅ DONE — no code | P2 probe + `langchain_openai.ChatOpenAI` native; replay tests at `backend/tests/unit/test_regolo_provider.py:448,465` |
| 2 | `reasoning_content` stripper applied before persistence | 🟡 PARTIAL | Helper at `backend/utils/llm/clients.py:536–559`; 4 unit tests at `test_regolo_provider.py:199–231`. **Zero production callers** — `grep -rn strip_reasoning_content backend/utils/` returns only the definition. |
| 3 | Regolo error envelope → `LLMProviderError` family mapping | 🟡 PARTIAL | `backend/utils/llm/regolo_errors.py` (170 LOC): `RegoloError`, `RegoloAuthError`, `RegoloForbiddenError`, `RegoloModelNotFoundError`, `RegoloRateLimitError`, `RegoloServiceError`, `classify_regolo_error()`. 5 unit tests at `test_regolo_provider.py:240–285`. **Zero production callers** — proxy's `__getattr__` lets raw langchain exceptions bubble up. |
| 4 | `Retry-After` honored, bounded exp backoff, max 3 attempts on 429, 1 retry on transient 5xx, no retry on other 4xx | 🟡 PARTIAL | `_extract_retry_after()` at `regolo_errors.py:142–156` parses the header; `RegoloRateLimitError.retry_after_s` carries it. **No retry policy implemented anywhere** — `_RegoloChatProxy._resolve()` returns a `ChatOpenAI` instance with no retry decorator. langchain's default retries (3 attempts, exp backoff) apply but ignore Regolo's `Retry-After`. |
| 5 | Telemetry: `provider=regolo` + workload/model/status/latency_ms/retry_count/fallback_used/finish_reason | 🔴 MISSING | `_usage_callback` at `clients.py:19` is attached to every Regolo `ChatOpenAI` (`clients.py:520`). No `provider=regolo` tag is set; `usage_tracker.py` itself is upstream-omi-only and not patched. No `set_usage_context(provider=...)` calls in this repo. |
| 6 | `python scripts/lint_async_blockers.py` clean | ⚪ N/A | Script doesn't exist in sister repo (it's an upstream-omi script). The patch package's CI runs `python -m compileall` per `.gitlab-ci.yml`. |
| 7 | Existing test suite passes | ⚪ NOT RUN | Audit constraint forbade running code. `backend/test.sh` lists 20+ pytest invocations; sister repo's CI runs equivalents. |

## What's wired correctly already (verify by inspection)

- ✅ `_REGOLO_THINKING_MODELS` frozenset at `clients.py:490`. Used at `clients.py:524` to inject `extra_body={"chat_template_kwargs":{"enable_thinking":False}}` only for thinking models.
- ✅ `_REGOLO_BASE_URL = "https://api.regolo.ai/v1"` constant at `clients.py:481`. SSRF defense — never sourced from headers.
- ✅ `regolo/` model-name prefix is stripped before sending to the API (`test_factory_strips_regolo_prefix_from_api_model`).
- ✅ BYOK Regolo key takes precedence over env `REGOLO_API_KEY` (`_RegoloChatProxy._resolve()` at `clients.py:135`).
- ✅ EU Privacy Mode dispatcher with HARD_BLOCK fail-closed semantics (`backend/utils/llm/eu_privacy.py:281–310` `resolve_feature_model()`).
- ✅ 32 unit tests in `test_regolo_provider.py` covering: prefix routing (3), thinking-knob injection (4), reasoning stripper (4), error classification (5), feature dispatch (16+).

## The M1 wiring patch — out of scope for this audit pass

The natural fix for criteria 2/3/4 is to replace `_RegoloChatProxy.__getattr__` (transparent forwarder) with a wrapping layer that:

1. Intercepts `invoke` / `ainvoke` / streaming methods.
2. On success: applies `strip_reasoning_content` to every message before returning.
3. On exception: routes through `classify_regolo_error()`, then either retries (with `retry_after_s` honored) or re-raises a typed Regolo error.
4. Tags the usage callback with `provider=regolo` + the resolved model.

This is non-trivial — it touches sync, async, and streaming paths, and must preserve langchain's `Runnable` protocol (`__or__`, `__ror__` are already implemented for chain composition). Estimated **120–180 LOC** + **6–8 tests**.

Splitting this work makes sense: one PR for sync `invoke` + error classification, one PR for streaming/`astream`, one PR for telemetry tags. Each is independently shippable.

## First-patch decision

**No patch shipped in this audit pass.** Reasons:
- The natural first patch (wrapping the proxy) is the meat of M1, not a "smallest valuable" improvement.
- Smaller alternatives (adding a known-failing `xfail` test, or wiring just the strip helper at one specific call site) would be cosmetic without the proxy-level wrapping.
- Better to scope the wrapping deliberately in a follow-up develop pass than ship a half-measure now.

## Recommended next steps (in order)

1. **M1.1 — proxy wrapping (sync path):** replace `_RegoloChatProxy.__getattr__` with explicit `invoke`/`__call__` wrappers that catch exceptions → `classify_regolo_error()` → typed re-raise; apply `strip_reasoning_content` on success. ~50 LOC + 4 tests. Land first because every other layer depends on it.
2. **M1.2 — streaming path:** add `astream`/`stream` wrappers with the same error classification; keep `strip_reasoning_content` as per-chunk filter. ~70 LOC + 3 tests.
3. **M1.3 — retry policy with `Retry-After`:** wrap the proxy methods with a `tenacity` retry decorator (or hand-rolled — match upstream omi convention) that honors `RegoloRateLimitError.retry_after_s`, max 3 attempts, jittered backoff. ~30 LOC + 3 tests.
4. **M1.4 — telemetry tagging:** add `provider=regolo` + resolved-model tags to the usage callback context for every Regolo-routed call. Coordinate with upstream omi's `usage_tracker.py` schema. ~25 LOC + 2 tests.

Total M1 estimate: **~190 LOC + ~12 tests**, deliverable in 4 short PRs over ~1.5 days.

## Open questions

- Where does upstream omi's `_usage_callback` actually emit telemetry rows? The sister repo can't answer this — needs a peek at `omi/backend/utils/llm/usage_tracker.py` to confirm the callback's tag-attachment API before M1.4.
- Is `tenacity` already a dependency on upstream omi, or do we hand-roll the retry decorator? Audit-pass constraint forbade running `pip list`; `requirements.txt` inspection deferred.
- The HARD_BLOCK path in `eu_privacy.py:295` raises before the proxy is ever called — so HARD_BLOCK errors don't flow through `classify_regolo_error()`. That's correct (no live request), but the dispatcher's banner message format should be confirmed to match desktop's `PrivacyModeFallbackBanner` reason enum.
