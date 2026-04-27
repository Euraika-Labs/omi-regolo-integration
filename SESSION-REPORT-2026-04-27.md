# Session Report — 2026-04-27

**Goal:** "analyse this codebase, I want to setup a backend, a web frontend and the desktop client using api.regolo.ai as ai provider."

**Result:** Full Double-Diamond cycle (Discover → Define → Develop → Deliver) for the Regolo.ai EU Privacy Mode integration shipped across the Euraika sister repo on GitLab + GitHub mirror.

## Final state — both surfaces

### GitLab `git.euraika.net/euraika/omi-regolo-integration`

| MR | Branch | Scope | State |
|---|---|---|---|
| !1 | `m0-spec-hygiene` | M0 probes doc + design corrections | ✅ merged |
| !2 | `m1-audit-and-first-patch` | M1.1 sync + M1.2 async/streaming wrappers | ✅ merged |
| !3 | `m1.3-retry-policy` | retry policy honoring Retry-After | ✅ merged |
| !4 | `m1.4-telemetry-tags` | provider=regolo telemetry tags | ✅ merged |
| !5 | `m2-embedding-audit` | M2 audit (HARD STOP, M2.5 plan, write-path privacy-gap disclosure) | ✅ merged |
| !6 | `m2.5-embedding-migration` | M2.5 code half (proxy + EU index gate) | 🟡 open |
| !7 | `m2.5-vector-store-patches` | M2.5 §1-4 vector-store patches (depends !6) | 🟡 open |

### GitHub mirror `github.com/Euraika-Labs/omi-regolo-integration`

Mirror of the GitLab repo with parallel PRs for visibility:

| PR | Mirror of | Title |
|---|---|---|
| #1 | GitLab !7 | M2.5 vector-store §1-4 patches |
| #2 | GitLab !6 | M2.5 code half — Regolo embeddings + EU index gate |

## Material findings surfaced today

1. **M0 design-doc corrections.** Original spec said `chat default = minimax-m2.5`. Empirical P6 latency probe found MiniMax timed out on **3/5 calls at 60s**. Default now `mistral-small-4-119b` (p50 0.43s, p90 0.44s, ±2% spread). Per-model `enable_thinking:false` matrix replaces the original blanket claim.
2. **M1.4 review fix** caught by deliver-phase reviewer: `_inject_regolo_telemetry` could double-stamp `model=` tag when caller already had one. Fixed + regression test added.
3. **M2 HARD STOP.** Pinecone single index at fixed 3072-dim. Vector keys are `{uid}-{conversation_id}` with no provider/model/dim component. Adding `Qwen3-Embedding-8B` (4096-dim) requires a parallel Pinecone index — addressed in MR !6 + !7.
4. **Privacy-write gap.** `generate_embedding()` was called from conversation processing without any privacy-mode check. Even with EU Privacy Mode on, new conversation embeddings phoned home to OpenAI. The Settings UI marketed "All AI runs on regolo.ai" — gap. MR !7's `save_structured_vector` refactor closes it.
5. **M4 OpenAI-from-browser correction.** Earlier framing was imprecise. `chat-with-memory.ts` is a Server Action (`'use server'` directive) — key never reaches the browser bundle. Real concern was **routing**, not secret exposure.
6. **M4 KMS decision locked.** App-side AES-GCM with HKDF-SHA256-derived per-user key from a single `BYOK_MASTER_PEPPER` env-var. Threat-model parity with desktop's macOS Keychain. Rejected: GCP KMS (latency/cost), user passphrase (UX), plaintext (risk).

## What's left on the GA roadmap

| Item | Blocker | Owner |
|---|---|---|
| MR !6 + !7 review and merge | reviewer SLA | Backend reviewer |
| Provision 4096-dim Pinecone index (`omi-eu-prod-4096`) + cost approval | infra + finance | Infra + finance |
| M3 desktop polish — Mac build verification | macOS host | Mac maintainer |
| Sign Regolo DPA + GA rollout | legal turnaround | Legal |

## Where to pick up tomorrow

1. **Reviewer triage** of MR !6 (and !7 once !6 lands) on GitLab. Mirror PRs on GitHub track the same content for stakeholders who prefer the GitHub UI.
2. **Privacy-write gap decision** flagged in MR !5: pick (a) ship M2.5 fast via !6 + !7, (b) update Settings copy to disclose, or (c) hard-block conversation embedding while Privacy Mode is on (degrades RAG until M2.5).
3. **Infra request** for `omi-eu-prod-4096` Pinecone index + finance sign-off on the recurring cost.
4. **DPA conversation with Regolo** — start in parallel; takes calendar weeks regardless of code state.

## Key files

- `desktop/docs/REGOLO_INTEGRATION.md` — corrected design doc.
- `desktop/docs/regolo-probes.md` — empirical probe record (P1–P11).
- `desktop/docs/M2-embedding-audit.md` — M2 HARD STOP rationale + M2.5 plan.
- `desktop/docs/M2.5-implementation-runbook.md` — operator deployment playbook (env vars, migration order, mid-account toggle policy, cost notes).
- `desktop/docs/M4-decisions.md` — KMS + endpoint contract decisions.
- `desktop/docs/M4-M2.5-security-verification.md` — TypeScript strict + Semgrep + manual security review (0 findings, 35 unit tests green).

## Session metadata

- Duration: extended single-session work spanning multiple loop iterations of `/octo:embrace`.
- API spend: zero new Regolo probes (sourced from prior fixture + earlier same-day probe data); GitLab + GitHub free-tier API calls only.
- Auth: GitHub `anubissbe` (mirror push), GitLab `bert@euraika.net` (full sister-repo write).
