# M6 Execution — Work Breakdown Structure

**Companion to:** `M6-windows-port-decisions.md` (decisions) + `M6-debate-transcript.md` (risks).
**Audience:** the 2-engineer team coordinating M6 execution. WBS is **parallelization-aware** — each work package can be picked up independently after its dependencies clear.

## Conventions

- **Owner:** role, not specific person. Roles: `Backend` (Rust + Win32), `Frontend` (Tauri + TS/React), `DevOps` (CI + signing + distribution), `Admin` (billing, sign-offs, no code).
- **Effort:** engineer-days. Whole-week chunks rounded for clarity.
- **Dependency:** other WP IDs that must complete first. None = can start immediately.
- **Exit criteria:** observable signal that the work package is done.
- **Risk hook:** which of the 7 documented risks (see debate transcript) this WP triggers if it slips.

## Wave 0 — Pre-flight (Week 0, ~1 week elapsed, parallel)

These are the 4 follow-ups in `M6-windows-port-decisions.md`. All can run in parallel. **Wave 1 cannot start until Wave 0 completes.**

| WP  | Title                            | Owner   | Effort | Dep | Exit criteria | Risk hook |
|-----|----------------------------------|---------|--------|-----|---------------|-----------|
| WP-01 | Audit `Backend-Rust/Cargo.toml` | Backend | 1d     | —   | One-pager: existing crate's scope, LOC, public API, gap to omi-core target. Attached to MR | #1 |
| WP-02 | Team-proficiency audit          | Admin   | 0.5d   | —   | Score 2 engineers on: Rust prod, .NET prod, WebView dev, Win32 interop. Decision recorded | #5 |
| WP-03 | Confirm Tauri vs WinUI commit   | Backend + Admin | 0.5d | WP-01, WP-02 | Decision recorded in `M6-windows-port-decisions.md` Question 1 | #5, #7 |
| WP-04 | Branch strategy decision        | Admin   | 0.5d   | —   | `windows/` parallel to `desktop/`, OR restructure into `apps/{mac,windows,web}/` + `core/`. Decision recorded | — |
| WP-05 | Azure Artifact Signing billing  | Admin   | 1d     | —   | Subscription active on Euraika-Labs org. Cert in Key Vault. Test sign of dummy MSIX | — |

**Wave 0 exit gate:** all 5 WPs green. Estimated 1 calendar week with admin overhead.

## Wave 1 — M6.1 Foundation (Weeks 1-5, parallel after Wave 0)

| WP  | Title                                     | Owner   | Effort | Dep | Exit criteria | Risk hook |
|-----|-------------------------------------------|---------|--------|-----|---------------|-----------|
| WP-06 | WGC IPC latency spike                   | Backend | 5d     | WP-03 | Captured 100 frames via WGC + Tauri IPC; p50/p90 latency report; go/no-go on framework | #2 |
| WP-07 | Extract `omi-core` crate — Models + Providers | Backend | 10d | WP-01, WP-03 | omi-core crate compiles; ChatProvider/Claude/Gemini/Regolo callable via UniFFI from Swift | #1 |
| WP-08 | Tauri shell scaffold + WebView2 boot    | Frontend | 5d   | WP-03 | `cargo tauri dev` opens window with React + a stub backend command | — |
| WP-09 | omi-core HTTP layer — APIClient + AuthService | Backend | 7d  | WP-07 | omi-core handles Firebase ID token retrieval + Anthropic/Google streaming SSE | #1 |
| WP-10 | Tauri Settings page (Regolo row + Privacy toggle) | Frontend | 5d | WP-08, WP-09 | Settings UI matches macOS MR !8 visual design; reads/writes Firestore prefs via Rust core | — |
| WP-11 | First end-to-end chat with Regolo BYOK  | Frontend + Backend | 3d | WP-09, WP-10 | User configures Regolo key in Settings → flips Privacy Mode on → sends one chat message → response renders | — |

**Wave 1 exit gate:** WP-06 says "Tauri OK"; WP-11 demo passes. Estimated 4-5 calendar weeks. **Risk #2 trigger here: if WGC frame latency > 500ms, halt and execute WinUI 3 fallback documented in Question 2 of decisions.**

## Wave 2 — M6.2 Feature parity (Weeks 6-13, heavily parallel)

After Wave 1's foundation is in place, these 5 WPs run in parallel:

| WP  | Title                                    | Owner   | Effort | Dep | Exit criteria | Risk hook |
|-----|------------------------------------------|---------|--------|-----|---------------|-----------|
| WP-12 | Audio capture (WASAPI mic + loopback)   | Backend | 10d    | WP-09 | Mic + system audio stream to Deepgram; transcripts arrive via SSE; CPAL covers mac+win | — |
| WP-13 | Screen capture (Windows.Graphics.Capture)| Backend | 10d   | WP-09 | Per-window screenshots saved to disk on Windows; OCR pipeline reuses existing Rust code | — |
| WP-14 | System tray + shield indicator (Win32)   | Frontend | 5d   | WP-08 | Tray icon visible; shield variant swaps reactively on Privacy Mode toggle | — |
| WP-15 | BYOK storage via keyring crate          | Backend | 4d     | WP-09 | Saving a key on Windows persists across restart; Mac path unchanged | — |
| WP-16 | Full UX polish (banner, counter, first-run, ModelQoS) | Frontend | 8d | WP-10 | All MR !8 acceptance criteria observable in the Tauri build | — |
| WP-17 | omi-core BYOK encryption (CryptoKit→ring) | Backend | 3d   | WP-07 | Hash + cipher generated identically on Mac and Win; backend BYOK fingerprint compatibility | — |

**Wave 2 exit gate:** all 6 WPs green; manual smoke test of each acceptance criterion. Estimated 6-8 calendar weeks (depends on team capacity to actually parallelize).

## Wave 3 — M6.3 Distribution (Weeks 14-17, partially parallel)

| WP  | Title                                  | Owner   | Effort | Dep | Exit criteria | Risk hook |
|-----|----------------------------------------|---------|--------|-----|---------------|-----------|
| WP-18 | MSIX manifest + capabilities          | DevOps  | 3d     | Wave 2 done | Package.appxmanifest with `runFullTrust` + `microphone` + `graphicsCaptureProgrammatic` + `graphicsCaptureWithoutBorder`; schema 2021 | — |
| WP-19 | GitHub Actions windows-latest pipeline | DevOps  | 3d     | WP-18 | CI builds, signs (via WP-05), publishes MSIX to release | — |
| WP-20 | `.appinstaller` auto-update file      | DevOps  | 2d     | WP-19 | omi.me/win/omi.appinstaller hosts the manifest; auto-update fires within 4h of new release | — |
| WP-21 | winget manifest                        | DevOps  | 2d     | WP-19 | `winget install omi` succeeds; PR to `microsoft/winget-pkgs` open | — |
| WP-22 | SmartScreen warmup monitoring          | DevOps + Admin | 1d (then ongoing) | WP-19 | Telemetry captures install conversion rate; baseline established for week-over-week | #3 |

**Wave 3 exit gate:** WP-19 publishes a signed MSIX that installs cleanly on a fresh Win11 VM. Estimated 3-4 calendar weeks.

## Wave 4 — M6.4 Cross-OS parity validation (Weeks 14-17, parallel with Wave 3)

This wave was added per Round 2 debate amendment #4. Runs in parallel with Wave 3 since it has different dependencies.

| WP  | Title                                  | Owner   | Effort | Dep | Exit criteria |
|-----|----------------------------------------|---------|--------|-----|---------------|
| WP-23 | FlaUI test harness scaffold           | Frontend | 5d    | Wave 2 done | One green E2E test running on Windows CI |
| WP-24 | Per-feature parity matrix              | Frontend | 5d    | WP-23 | Matrix file: each MR !8 acceptance criterion × {Mac, Win} = pass/fail observed |
| WP-25 | Address parity gaps                    | Frontend + Backend | 5d (variable) | WP-24 | All matrix cells green; or known-defer items documented |

**Wave 4 exit gate:** WP-25 closed. Parity matrix attached to release notes.

## Wave 5 — M6 launch (Week 18+)

Two-tier launch per Round 2 debate amendment #3:

| WP  | Title                                  | Owner   | Effort | Dep | Exit criteria |
|-----|----------------------------------------|---------|--------|-----|---------------|
| WP-26 | Power-user release                     | Admin + DevOps | 1d | All Wave 3+4 done | Announce in newsletter / Discord; first 50-100 installs collected; SmartScreen reputation accruing |
| WP-27 | SmartScreen reputation warmup window   | DevOps  | 4-8 wk (calendar) | WP-26 | Reputation cleared; SmartScreen warning replaced with clean download |
| WP-28 | Broad release                          | Admin   | 1d     | WP-27 | Public marketing push; omi.me homepage features Windows download |

## Adversarial cross-check — what's missing in this WBS?

(Self-review pass to surface gaps before kicking off.)

1. **Localization (l10n)** — the macOS app uses some localized strings; Windows port hasn't budgeted localization. Likely OK to defer (English-first), but flag as "open for product."
2. **Telemetry per-OS dimension** — Sentry / PostHog in the Mac app needs Windows wiring. Not budgeted. Add as **WP-29** under Wave 2 (~3d, Frontend).
3. **Crash reporting symbol upload** — Mac uses Codemagic + Sentry; Windows MSIX builds need symbol upload to Sentry too. Not budgeted. Add as **WP-30** under Wave 3 (~1d, DevOps).
4. **First-launch UX on Windows** — macOS has Onboarding flow (78k LOC `OnboardingChatView.swift`). Tauri version isn't budgeted to port this. Either ship without onboarding (rougher first run) or add **WP-31** under Wave 2 (~10d, Frontend) to port a minimal onboarding.
5. **Update channel for Mac** — when Tauri Win launches, will Mac users notice if Mac auto-update via Sparkle starts diverging? Need a Win/Mac feature flag matrix in release notes, not budgeted as a WP but flagged for Admin.
6. **Documentation site** — omi.me needs a `/win` page with install instructions, troubleshooting, BYOK setup steps. Not budgeted. Add as **WP-32** under Wave 5 (~2d, Admin/Frontend).
7. **Bluetooth (omi device) on Windows** — `btleplug` crate covers cross-platform but needs UART hardware testing. Mac uses CoreBluetooth. Add as **WP-33** under Wave 2 (~5d, Backend) IF the Bluetooth hardware integration is in scope for M6 Day 1. **Decision needed: scope in or defer to M7?**

## Total effort (revised post-cross-check)

| Wave | Engineer-days |
|---|---|
| Wave 0 | ~3.5 |
| Wave 1 | ~35 |
| Wave 2 | ~58 (40 base + 18 added per cross-check) |
| Wave 3 | ~11 |
| Wave 4 | ~15 |
| Wave 5 | ~3 (calendar 4-8 wk) |
| **Total** | **~125 engineer-days** = ~12.5 wk for 2 engineers (perfect parallelization) |
| **Realistic with sync overhead + debugging** | **16-20 calendar weeks** |

## Parallelization opportunities

The "team of teams" angle: each Wave 2 work package (12-17) is independent. With 2 engineers, you can run 2 simultaneously and cycle through them in 6-8 wk. With 4 engineers (e.g., contractor temporarily), Wave 2 collapses to 3-4 wk. This is where headcount investment pays off most.

Wave 4 (cross-OS parity validation) parallel with Wave 3 (distribution) is the other big win — frontend engineer on parity matrix while DevOps engineer ships MSIX/CI. Cuts ~2 wk from the calendar.

## Risk monitoring per wave

| Wave | Risks to watch | Recovery trigger |
|---|---|---|
| 0 | #1, #5 | Backend-Rust audit < 5k LOC OR <2 engineers Rust-fluent → escalate before Wave 1 |
| 1 | #2 | WGC frame latency > 500ms → halt, execute WinUI 3 fallback |
| 2 | #6 | M5 launch issues consume > 30% engineer time → pause Wave 2 |
| 3 | #3 | SmartScreen blocks all installs in test → check Azure Artifact Signing identity reputation; consider pause |
| 4 | #4 | FlaUI infra eats > 1 wk → reduce parity matrix scope |
| 5 | #3 | Power-user conversion < 10% → extend warmup, delay broad launch |

## Dependencies external to this WBS

- M5 (Mac DPA + GA) sequencing — flagged as Risk #6 in debate transcript.
- Privacy-write gap (M2 P1 question) — must close before Windows broad release.
- Regolo DPA — Mac and Windows share the same legal posture.

These are NOT WBS items; they're constraints on when Waves 5+ can fire.
