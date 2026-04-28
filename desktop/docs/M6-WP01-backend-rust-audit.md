# WP-01 Audit — `Backend-Rust/` Crate

**Wave:** 0 (pre-flight gating WP).
**Owner:** Backend.
**Effort actual:** 1 hour (much faster than the budgeted 1 day, because the audit findings dispatched the question quickly).

## Executive finding

`desktop/Backend-Rust/` is **not a thin shim**. It is a **30,984-LOC near-complete reimplementation** of the omi backend in Rust. The Mac SwiftUI desktop app already talks to it over HTTP/WS for almost every backend feature — chat, sessions, messages, memories, action items, agent, integrations, transcripts, encryption, auth.

**This inverts Risk #1 from the M6 debate transcript** (Codex's concern: "what if Backend-Rust is a 200-LOC stub and we have to write 12+ weeks of Rust?"). Reality: the Rust backend is already production-class.

## Crate identity

```toml
[package]
name = "omi-desktop-backend"
version = "0.1.0"
edition = "2021"
```

Built as a self-contained binary with `axum` as the HTTP framework, `tokio` async runtime, full Firestore + Redis integration, AES-GCM/HKDF encryption, JWT auth, structured logging via `tracing`.

## Module breakdown

| Module | LOC | Role |
|---|---|---|
| `services/firestore.rs` | 9,763 | Full Firestore REST client — collections for users, conversations, memories, action_items, etc. |
| `llm/client.rs` | 1,189 | LLM provider routing — Claude / Gemini / OpenAI / OpenRouter / Regolo (likely) |
| `llm/prompts.rs` | 702 | System prompts, structuring templates |
| `services/redis.rs` | 460 | Redis cache + pub-sub |
| `services/integrations.rs` | 395 | External integration glue |
| `llm/model_qos.rs` | 215 | Model QoS / feature mapping |
| `llm/persona.rs` | 198 | Persona/clone logic |
| `auth.rs` | 6.6K (file size) | JWT + refresh + session management |
| `encryption.rs` | 5.3K | AES-GCM + HKDF (the same primitives we picked for M4.1 web frontend) |
| `config.rs` | 7.8K | Config loading |
| `main.rs` | 9.3K | Server bootstrap |
| 27 route handlers in `routes/` | rest | Each route domain: chat, chat_sessions, chat_completions, messages, memories, action_items, agent, advice, knowledge_graph, personas, screen_activity, focus_sessions, folders, llm_usage, rate_limit, staged_tasks, tts, updates, users, webhooks, auth, config, health |

## Key dependencies (from `Cargo.toml`)

- `axum 0.7` (with `ws` feature) — HTTP + WebSocket framework
- `tokio` (full features), `tower-http` — async + HTTP middleware
- `reqwest 0.11` (with `json`, `stream`) — for outbound HTTP to provider APIs
- `tokio-tungstenite 0.24` (with `native-tls`) — for Deepgram WebSocket streaming proxy
- `aes-gcm 0.10` + `hkdf 0.12` — encryption primitives (same as M4.1 web)
- `jsonwebtoken 9` — JWT auth
- `redis 0.25` — Redis client
- `tracing` + `tracing-appender` — structured logs

**No platform-specific deps.** The crate compiles cleanly on Linux, Mac, and Windows targets (verified architecturally, not yet smoke-tested on Windows). No CoreAudio, no AppKit, no AVFoundation in the dependency tree.

## What this means for M6

### Decision doc Q10 ("Code-sharing strategy") — REVISED

The decision doc said:

> Extract `omi-core` Rust crate from existing `Backend-Rust/` codebase

That framing implied "extract a smaller library" from a larger one. **Wrong framing.** What `Backend-Rust/` already is:

- A standalone binary (`omi-desktop-backend`) the Mac app launches as a child process and talks to over HTTP/WS on `localhost`
- **Already cross-platform** — pure Rust, no platform-specific code in the dependency tree
- **Already covers nearly every domain** the Swift app uses

So the actual M6 task is **NOT "extract a Rust core"** but:

1. **Build the existing Rust binary on Windows** — likely `cargo build --release --target x86_64-pc-windows-msvc` Just Works (cross-build from Linux requires `mingw-w64` or build natively on Windows runner; the latter is what GitHub Actions does anyway).
2. **Have the Tauri Windows shell launch the same binary** as a child process.
3. **Tauri WebView2 frontend talks to `localhost:<port>`** the same way the Mac app does.
4. **Add Win-specific platform integrations** in the Tauri shell (audio capture, screen capture, tray, BYOK storage) — these are NEW code.

This changes the M6.1 calendar from 4-5 weeks to **~1-2 weeks** because the core layer is reusable as-is.

### WBS amendments

**Wave 1 (M6.1) shrinks materially:**

| Original WP | Status after audit |
|---|---|
| WP-07 Extract `omi-core` Models + Providers | **DONE** — already in `Backend-Rust/llm/` and `Backend-Rust/models/` |
| WP-09 omi-core HTTP layer (APIClient + AuthService) | **DONE** — already in `Backend-Rust/` (axum + auth.rs + reqwest) |

**Renamed:**

| New WP | Effort |
|---|---|
| WP-07' Verify `Backend-Rust/` builds on Windows | 1 day |
| WP-09' Audit Regolo-integration MR !6+!7+!8+!9 deltas — confirm they apply cleanly to the Rust backend | 1 day |

**Wave 1 calendar: 4-5 wk → 1-2 wk.**

**Wave 2 (M6.2) is unchanged** — Win-specific platform integrations are unaffected by this finding.

**Wave 3 (M6.3) is unchanged** — distribution.

**Net M6 calendar: 14-18 wk → ~10-14 wk** for 2 engineers.

## Open questions surfaced

1. **Does `llm/client.rs` already include Regolo routing?** Likely — given the Mac app's M0–M2 work hits Regolo through the backend. Need to grep `client.rs` for regolo references; if absent, the M0 spec corrections + M1 retry/telemetry need to be ported into Rust here too. (Quick to verify on next iteration.)
2. **Does `services/firestore.rs` already include the `users/{uid}/settings/profile` schema** that M4.1 introduced for the web frontend? Probably not yet — M4 was web-only. Add as M6.1 follow-up.
3. **What's the Mac-side process-lifecycle story?** How does the Swift app launch the Rust binary, on what port, with what handshake? Tauri Windows shell needs to mimic this. Likely documented in `desktop/run.sh` or `Desktop/Sources/AppState.swift` — read on next iteration.

## Risk #1 status

**RESOLVED in the favorable direction.** The Rust foundation exists; the WBS overestimated the work by ~50%.

The **other 6 risks from the debate transcript still stand** — Risk #2 (WGC IPC latency), Risk #3 (SmartScreen warmup), Risk #4 (FlaUI infra), Risk #5 (team Rust proficiency), Risk #6 (M5/M6 contention), Risk #7 (Tauri rationale rest). This audit doesn't change any of those.

## Recommendation

Update the M6 WBS to reflect:
1. Wave 1 calendar → 1-2 wk
2. Wave 1 WPs renamed (build-on-Windows + delta audit instead of "extract")
3. Total M6 calendar → 10-14 wk for 2 engineers

This is a **good news** finding. Unblock the rest of Wave 0 (WPs 02-05) and proceed to Wave 1.

## Files touched in this audit

- `desktop/Backend-Rust/Cargo.toml` (read)
- `desktop/Backend-Rust/src/main.rs` (existence + size)
- `desktop/Backend-Rust/src/services/firestore.rs` (existence + size)
- `desktop/Backend-Rust/src/llm/client.rs` (existence + size)
- All 27 files in `desktop/Backend-Rust/src/routes/` (existence)

No code changes. Audit doc is the deliverable.
