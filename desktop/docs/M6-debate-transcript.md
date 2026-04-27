# M6 Plan Debate Transcript

**Date:** 2026-04-27
**Method:** 3-round adversarial 4-way debate (Codex / Gemini / OpenCode / Claude) on `.claude/session-plan.md`.
**Outcome:** plan shipped as-is. This transcript preserves the critique for future revisits.

## TL;DR

The plan was stress-tested across 3 rounds and surfaced 7 amendments. **The user opted to ship the original plan** — this transcript documents the 7 risks that were knowingly accepted.

## Round 1 — Top concerns

| Voice | Concern |
|---|---|
| Codex | `Backend-Rust/` audit is parallel/optional in plan; should be a hard gate before M6.1 |
| Gemini | `Windows.Graphics.Capture` → WebView2 IPC tax not budgeted; could 3-5× slow Rewind |
| OpenCode | SmartScreen warmup is a launch-blocker, not a footnote — first 4-8 weeks of MSIX have full-screen warning |
| Claude | Cross-OS parity validation undersized in Deliver; FlaUI infra is from-scratch, ~2 wk |

## Round 2 — Convergence on 4 amendments

1. Pre-M6.1 audit gate on `Backend-Rust/`
2. WGC IPC latency spike in M6.1 week 1 before committing Tauri
3. Two-tier launch (power users week 14, broad week 18-22)
4. Add explicit M6.4 sub-phase for cross-OS parity matrix + FlaUI infra

## Round 3 — Three deeper risks

5. **Team-proficiency audit** (Codex): before locking Tauri vs WinUI, score the 2 engineers on Rust production + .NET production + WebView dev. If <2 have shipped Rust, flip to WinUI 3 + .NET 8 — team velocity dominates.
6. **M5/M6 sequencing** (Gemini): M5 (DPA + macOS GA) hasn't closed. Starting M6 splits the 2-engineer team across two unfinished projects. Sequence sequentially OR fund separate Windows headcount.
7. **Tauri rationale weak** (OpenCode): the decision doc's primary Tauri arguments (10 MB binary, JS SDK reuse) don't materially apply to THIS codebase. omi's Swift app uses native Deepgram bindings, not JS SDK. Once those arguments are removed, Tauri-vs-WinUI is much closer than the plan suggests.

## Risks knowingly accepted

By shipping the original plan as-is, the team has accepted that:

- Calendar may slip by 50-100% if `Backend-Rust/` audit reveals minimal usable code (Risk #1)
- WGC IPC latency may force a mid-M6 framework pivot to WinUI 3, partially invalidating M6.1 work (Risk #2)
- First 4-8 weeks post-launch will have low conversion through SmartScreen warnings (Risk #3)
- FlaUI test infra setup is implicitly absorbed into Develop or Deliver (Risk #4)
- Framework choice locked without team-proficiency audit; if engineers aren't Rust-fluent, ramp will dominate calendar (Risk #5)
- M6 may compete for engineering attention with M5 closure work, creating two stuck projects (Risk #6)
- Tauri primary commitment rests partly on rationales that don't fully apply to this codebase (Risk #7)

## When to revisit

If during M6 execution any of these symptoms appear, this transcript is the recovery plan:

- M6.1 week 4 and Backend-Rust extraction is < 10% complete → Risk #1 firing → escalate, reset calendar.
- M6.1 spike shows WGC frame latency > 500ms via Tauri → Risk #2 firing → execute the WinUI 3 fallback documented in M6-windows-port-decisions.md Question 2.
- Mac M5 broad launch surfaces P0 issues during Windows M6.2 → Risk #6 firing → pause Windows, dispatch engineering to Mac.
- Engineers are spending >50% of M6.1 time on Rust onboarding → Risk #5 firing → flip to WinUI 3.

## Decision-maker note

The user chose "Done debating, ship original plan" after Round 3. This was a deliberate choice to commit to forward motion despite enumerated risks, on the basis that:
- Endless debate produces zero shipped code
- Risks #1–#4 are detectable mid-execution and have documented fallback plans
- Risks #5–#7 are organizational/strategic and outside this transcript's scope

The team has explicit permission to invoke any of the documented mid-flight pivots without re-debating the plan.
