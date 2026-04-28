# WP-13 Spike — WGC Per-Window Capture (`CreateForWindow`)

**Wave:** 2 (M6.2 feature parity).
**Owner:** Backend.
**Status:** **CLOSED — PASS.** Per-window WGC capture works via the same `windows-capture` API as the per-monitor capture from WP-06.
**Companion to:** `M6-windows-port-decisions.md` Q4 (screen capture API), `M6-WP06-wgc-capture-only-spike.md` (per-monitor baseline).

## Executive finding

Decisions doc Q4 commits to `Windows.Graphics.Capture` and notes both `CreateForWindow` (per-window) and `CreateForMonitor` (per-monitor) are supported. WP-06 validated per-monitor; this spike validates per-window. **Both use the same `windows-capture v2` `Settings::new` API; only the first argument changes** (`Monitor` → `Window`).

**Per-window p90 was actually better than per-monitor** on this machine, because the test target (an active app window) had more frequent visible changes than the relatively idle full desktop:

| Mode | p50 | **p90** | p99 | max |
|---|---|---|---|---|
| Per-monitor (WP-06) | 61.4 ms | **79.4 ms** | 140 ms | 140 ms |
| Per-window (this spike, active app) | 18.2 ms | **36.6 ms** | 1,563 ms | 1,563 ms |

## Reproduce

```powershell
cd C:\Users\bertc\kDrive\Code\projects\omi-wgc-window-spike
cargo build --release
.\target\release\wgc-window-spike.exe                 # auto-pick first titled window
.\target\release\wgc-window-spike.exe -- "Notepad"    # filter by title substring
```

`Cargo.toml`: 12 lines, `windows-capture = "2"`. `src/main.rs`: ~150 LOC. Calls `Window::enumerate()`, picks a target by substring filter or first titled, captures 100 frames.

## Side-finding 1 — high p99 variance is structural, not a bug

WGC delivers a frame **on change** (not on a fixed schedule). For an active app window with cursor blinks, scrolling, typing animations, p90 is excellent. But if the user pauses, the next frame may not arrive until the window next changes — could be milliseconds, could be many seconds.

This is **not** a bug; it's the API contract. Implications:

- **For Omi Rewind / OCR** (per-window screenshot every N seconds): irrelevant. We trigger captures on a timer, not consume the WGC stream as a clock.
- **For "live preview / always-fresh-thumbnail"**: combine WGC with a periodic forced-redraw or an idle-fallback timer.
- **For VAD-style activity detection**: WGC's silence-implies-no-change behaviour is actually useful — but treat the absence of callbacks as data, not as a stream-broken signal (same gotcha as WP-12 audio loopback).

## Side-finding 2 — **window titles can contain PII**

The probe enumerates top-level windows and reads their titles via `Window::title()`. Real-world top-level windows on a developer machine include:

- Chat client titles with the **other party's name and email address**
- Browser titles with **document/page names**
- Email client titles with **mailbox owner's email address**
- IDE titles with **file paths revealing project structure**

**Production implications:**

- **Do not log full window titles to Sentry / PostHog / Grafana / any telemetry sink.** Either log a hash of the title, the process name only, or omit entirely.
- **The Rewind feature must consider what user-controllable filtering or redaction it offers** before sending screenshots-for-OCR off-device. (This may already be in the Mac app's design — verify before Win parity ships.)
- **Settings UX should let users blacklist windows from capture by title pattern** (or per-process), like the Mac app's existing per-app Privacy Mode shield.
- This is **not a Risk #2 / framework decision** — applies equally to WinUI 3, WGC vs DXGI, etc. It's a **product privacy** concern surfaced by the implementation.

Adding this as an explicit follow-up in the WBS commentary section is recommended.

## What this DOES NOT cover

- **Window-handle stability across captures.** If the target window is closed/reopened or its HWND changes, the capture session breaks. The Rewind use case re-enumerates per-screenshot, so this is the right pattern; live "stick to one window" use cases need handling.
- **Minimised / occluded windows.** WGC can capture occluded windows (that's a feature) but minimised windows may behave differently. Not exercised.
- **DPI / multi-monitor positioning** of the target window. Not exercised.
- **WDA_EXCLUDEFROMCAPTURE** windows (the Recall integration that decisions Q4 mentions). Not exercised; would require a target that sets that flag.

## Risk register impact

- **Risk #2 (WGC IPC budget) — already CLOSED by WP-06.** This spike only confirms the per-window variant also passes.
- **No new risks introduced.** The PII-in-window-titles finding is a product-privacy concern, not a debate-transcript risk; surfacing it preemptively avoids a downstream surprise.

## Implications for the WBS

- **WP-13 implementation can proceed confidently.** The bottom-of-stack per-window capture works.
- **Add a sub-task to WP-13 (or to WP-16 UX polish)** for window-title PII handling: telemetry redaction + per-window/per-process Privacy Mode opt-out.

## Files referenced (none vendored)

- `C:\Users\bertc\kDrive\Code\projects\omi-wgc-window-spike\` — sibling scratch crate (NOT in this repo)
- `desktop/docs/M6-WP06-wgc-capture-only-spike.md` — per-monitor baseline
- `desktop/docs/M6-windows-port-decisions.md` Q4 — screen capture API choice
- `desktop/docs/M6-execution-WBS.md` — WP-13 row in Wave 2 table

## Recommendation

**Mark WP-13 spike PASS in the WBS.** Add a follow-up sub-task for PII-aware telemetry / per-window Privacy-Mode-opt-out before the Rewind feature ships.
