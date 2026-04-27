# M2 Embedding Audit — Backend Vector Storage

**Branch:** `m2-embedding-audit`.
**Decision:** 🛑 **HARD STOP.** M2 as scoped (`Qwen3-Embedding-8B` 4096-dim adapter alongside existing 3072-dim path) cannot ship without infrastructure work first. This doc records why and proposes M2.5.

## What was audited

Backend vector-storage call sites in upstream omi monorepo (`/opt/projects/omi/backend/`) — the sister "patch package" doesn't host any of these. Three production code paths and one storage layer scanned.

## Storage layer — Pinecone, single index, three namespaces

`backend/database/vector_db.py` — 389 LOC, all of omi's persistent vector storage. Configuration:

```
PINECONE_INDEX_NAME=<env>     # ONE index for the whole app
ns1                           # conversation embeddings  (text-embedding-3-large, 3072-dim)
ns2 (MEMORIES_NAMESPACE)      # memory embeddings        (text-embedding-3-large, 3072-dim)
ns3 (SCREEN_ACTIVITY_NAMESPACE)  # screen activity        (gemini embedding-001, 3072-dim)
```

**Critical Pinecone constraint:** dimensionality is set at index creation time and is fixed for the lifetime of the index. **Upserting a vector of a different dimension hard-fails server-side**. There is no per-namespace dimensionality.

## Vector schema — no provider / model / dim tagging

Every namespace uses the same shape (`vector_db.py:21–32`, `155–177`, `298–340`):

```python
{
    "id":     f'{uid}-{conversation_id}',         # composite of user + entity only
    "values": vector,                              # float[3072]
    "metadata": {
        "uid": uid,
        "conversation_id"|"memory_id"|"screenshot_id": ...,
        "created_at": <int>,
        # NO provider field
        # NO model field
        # NO dim field
    },
}
```

The keying does not encode `(provider, model, dim)`. There is no way to ask "give me only the OpenAI 3072-dim vectors for user X" — the index is implicitly homogeneous.

## Read-path — Privacy Mode HARD_BLOCK is correct

Sister repo's `eu_privacy.py:104–110` already lists embedding-dependent read features:

```python
EMBEDDING_DEPENDENT_FEATURES = frozenset({
    'memory_search',
    'knowledge_graph_search',
    'screen_activity_search',
})
```

`resolve_feature_model()` (line 295) returns `FeatureRoute(kind=HARD_BLOCK, ...)` for these when EU Privacy Mode is on, with a banner reason. **This is the right defensive policy** for Phase 1 — it prevents the 4096-dim Qwen3 vector from ever being written to or queried against the 3072-dim Pinecone index.

## Write-path — undisclosed privacy gap

`generate_embedding()` (`backend/utils/llm/clients.py:685`) is called from:

| Site | Purpose | Privacy-Mode-aware? |
|---|---|---|
| `utils/conversations/process_conversation.py:580` | Save conversation summary embedding | ❌ No |
| `utils/app_integrations.py:206` | App question vector | ❌ No |
| `utils/app_integrations.py:338` | App conversation context vector | ❌ No |

**These call sites do not consult `eu_privacy.resolve_feature_model()`.** When EU Privacy Mode is ON, new conversation embeddings still go through the default `_OpenAIEmbeddingsProxy` → OpenAI's `text-embedding-3-large`, leaking conversation content to OpenAI servers.

This is a privacy-promise violation distinct from the search-side block. M1 fixed chat/synthesis routing; embedding writes were not in M1's scope but are in conflict with the marketing claim that "All AI runs on regolo.ai (Italy, zero retention)" (per `desktop/docs/REGOLO_INTEGRATION.md` Settings UX, line 224).

## Why M2 (as scoped) cannot ship

Adding `_RegoloEmbeddingProxy(model='Qwen3-Embedding-8B')` (4096-dim) and routing the write path through it when Privacy Mode is on would:

1. **Hard-fail every Pinecone upsert** — the index expects 3072-dim values; 4096-dim values are rejected with `dimension mismatch`.
2. **Or, if a migration silently re-embedded existing vectors at 4096-dim**, lose all historical search recall the moment a user toggles Privacy Mode.
3. **Or, if mixed within one index somehow**, return broken cosine-similarity results because the dim mismatch silently degrades the math.

None of these outcomes is acceptable. Per the prompt's HARD STOP clause: indexes keyed only by user_id (no provider/model/dim component) means migration-project, not M2 scope.

## What M2 looked like in scoping vs reality

| Original M2 acceptance criterion | Reality |
|---|---|
| 1. `_RegoloEmbeddingProxy` analogous to `_OpenAIEmbeddingsProxy` | Trivially possible (~30 LOC). But pointless until #2 lands — the proxy would have nowhere safe to write to. |
| 2. Vector store keyed by `(provider, model, dim)` | Not implemented. Requires a NEW Pinecone index dimensioned at 4096, plus schema changes to add provider/model/dim metadata fields, plus a routing layer that selects index by user's current Privacy Mode setting. |
| 3. Dispatcher routes embedding workload | Currently three direct `generate_embedding(...)` call sites bypass `eu_privacy.py`. Routing requires either funneling all writes through `eu_privacy.resolve_feature_model('embedding')` (not currently supported) or wrapping `generate_embedding` itself. |
| 4. Test coverage for `(provider, model, dim)` key path | Pre-requires #2. |

## What the misleading `EMBEDDING_MIGRATION.md` actually covers

`/opt/projects/omi/.claude/worktrees/omi-regolo-integration/desktop/docs/EMBEDDING_MIGRATION.md` describes the **macOS desktop app's local SQLite-stored screenshot embeddings** (Gemini 3072-dim, single-table `screenshots.embedding` column, GRDB migrations). It is NOT about the backend's Pinecone-based conversation/memory/activity vectors. The two systems are disjoint. The earlier M1 deliver report's reference to it was wrong — the cross-reference should be removed when this doc lands on `main`.

## Proposed M2.5 — the migration project

Required infrastructure work before M2 code can ship:

1. **Provision a second Pinecone index** at 4096 dimensionality (e.g. `PINECONE_INDEX_NAME_EU`).
2. **Extend `vector_db.py`** with provider-aware index selection: `_get_index(provider)` returns the right `pc.Index` handle.
3. **Add `provider` + `model` + `dim` to vector metadata** (additive — backfill existing vectors with `provider=openai, model=text-embedding-3-large, dim=3072` once at deploy time).
4. **Wrap `generate_embedding`** so it consults the request's Privacy Mode flag (similar to how M1 wraps `invoke`/`ainvoke`):
   - Privacy ON → `_RegoloEmbeddingProxy.embed_documents([content])` → write to `ns1_eu` / `ns2_eu` / `ns3_eu` on the 4096-dim index.
   - Privacy OFF → existing OpenAI path → write to `ns1` / `ns2` / `ns3` on the 3072-dim index.
5. **Read-path migration**: lift `EMBEDDING_DEPENDENT_FEATURES` from HARD_BLOCK to REGOLO when Privacy Mode is on AND a 4096-dim namespace exists for that workload. Keep HARD_BLOCK as the fallback if the EU index isn't provisioned.
6. **Mid-account toggle policy** (decision needed):
   - Option A: User's old (3072-dim OpenAI) vectors stay queryable when they later turn Privacy Mode OFF; new (4096-dim Regolo) vectors are queryable while it's ON. Two parallel histories per account.
   - Option B: When Privacy Mode toggles ON, schedule a background re-embed of all the user's data using Regolo, then delete the old OpenAI vectors. Heavy, network-bounded, 4-hour-class job for active users.
   - Option C: Privacy Mode ON forces all historical data to be re-embedded synchronously before search returns results — slow first-search-after-toggle but consistent.

Recommended: **Option A** for v1 (simplest, no destructive migration); revisit if user reports surface inconsistency.

## What CAN ship safely in M2 (scope-reduced)

A minimal, dormant patch that lays groundwork without touching write paths:

1. Add `_RegoloEmbeddingProxy` class (+ ~30 LOC).
2. Add module-level `regolo_embeddings = _RegoloEmbeddingProxy(model='Qwen3-Embedding-8B', ...)` factory but DO NOT replace any existing `embeddings` reference.
3. Confirm `_classify_provider('regolo/Qwen3-Embedding-8B')` returns `'regolo'` (it should — already covered by existing classifier tests).
4. Tests: proxy constructs with right base_url + model + 4096-dim assertion. ~30 LOC test.

This change ships nothing user-visible — the proxy is reachable via `MODEL_QOS_<feature>=regolo/Qwen3-Embedding-8B` operator override only, and even then it fails on Pinecone upsert because the index is 3072. Operators who deliberately enable that override see a clear `dimension mismatch` Pinecone error rather than silent corruption.

**Recommendation:** SKIP even this minimal patch. The proxy without the surrounding infrastructure is dead code, and it tempts a future engineer into thinking M2 is "started." Better to ship M2.5 as one whole when the infra is provisioned.

## Decision matrix

| Path | Effort | Risk | Recommendation |
|---|---|---|---|
| Ship `_RegoloEmbeddingProxy` only (dormant) | 30 LOC + 30 LOC test | Tempts misuse; index still 3072-dim | ⚠️ NOT recommended |
| Ship M2.5 in full (new Pinecone index + write-path wrap + migration) | ~600 LOC + infrastructure provisioning + 1-time backfill | High — production index changes, 4-hour-class user re-embed jobs | Plan for next sprint; coordinate with infra/ops |
| Defer M2 entirely; leave EMBEDDING_DEPENDENT_FEATURES in HARD_BLOCK | 0 LOC | None — but EU Privacy Mode users get degraded RAG forever | ⚠️ This is the current state; explicit acknowledgment is the only delta |
| **HARD STOP** — write this audit doc, do not patch code, plan M2.5 explicitly | this doc | None | ✅ This is what was shipped |

## Sign-off checklist for M2.5 planning

- [ ] Provision new 4096-dim Pinecone index in staging; confirm cost delta with finance.
- [ ] Decide mid-account toggle policy (A / B / C above).
- [ ] Decide whether `gemini_embed_query` (screen activity, 3072-dim Gemini) also needs an EU path or stays HARD_BLOCKED forever.
- [ ] Add `provider/model/dim` schema migration (additive Pinecone metadata fields — non-breaking for existing readers since they don't filter on these).
- [ ] Wrap `generate_embedding` with Privacy Mode awareness — same shape as M1's `_RegoloChatProxy.invoke` wrapper.
- [ ] Document the privacy-promise gap fix in user-facing release notes — current Privacy Mode users have an undisclosed embedding write to OpenAI.

## Files touched

| File | Change |
|---|---|
| `desktop/docs/M2-embedding-audit.md` | NEW (this doc) |

No code changes. No test changes. The audit is the deliverable.
