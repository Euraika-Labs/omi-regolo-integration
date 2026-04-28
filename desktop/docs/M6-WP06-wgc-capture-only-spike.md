# WP-06 Spike (complete) — WGC + Tauri IPC Latency

**Wave:** 1 (M6.1 foundation; gating WP for the Tauri-vs-WinUI-3 framework choice).
**Owner:** Backend.
**Status:** **CLOSED — PASS by 6.3×.** Both halves measured: capture-only (`omi-wgc-spike`) and end-to-end Rust→JS via Tauri (`omi-tauri-ipc-spike`).
**Companion to:** `M6-windows-port-decisions.md` (Question 2 documents the 500 ms p90 fallback trigger).

> Note: filename retains `wgc-capture-only-spike` from the partial first-pass commit. Content was extended with the IPC half. Filename rename is a separate follow-up — keeping it stable preserves the MR review thread.

## Executive finding

| Hop | p90 latency |
|---|---|
| WGC frame-pool delivery (capture only) | **79.4 ms** |
| Rust → WebView2 / JS event-bus marshalling | **0.51 ms** |
| **Estimated full loop** | **79.9 ms** |
| **Threshold (M6 decisions Q2)** | **500 ms** |
| **Verdict** | **PASS by ~6.3×** |

**Risk #2 from the debate transcript is closed.** The WinUI 3 fallback trigger does not fire. Tauri remains primary per the original decisions doc.

The IPC half is essentially free — half a millisecond p90, less than 2 ms p99. WebView2's event channel imposes no measurable cost relative to the gating budget. Capture latency dominates by ~150×.

## Reproduce

Two sibling scratch crates, intentionally outside the Euraika fork (no architectural commitments):

```powershell
# Half 1 — WGC capture only:
cd C:\Users\bertc\kDrive\Code\projects\omi-wgc-spike
cargo build --release
.\target\release\wgc-spike.exe

# Half 2 — full Rust + Tauri + WebView2 round trip:
cd C:\Users\bertc\kDrive\Code\projects\omi-tauri-ipc-spike
npm install
cargo --manifest-path src-tauri/Cargo.toml build --release
.\src-tauri\target\release\omi-tauri-ipc-spike.exe
# (window pops up, captures 100 frames, writes to %TEMP%\wp06-ipc-results.txt, auto-exits)
type %TEMP%\wp06-ipc-results.txt
```

## Measurement methodology

### Half 1 — capture-only

`windows-capture v2` (Rust wrapper around `Windows.Graphics.Capture` / `Direct3D11CaptureFramePool`). The handler timestamps every `on_frame_arrived` callback with `Instant::now()` and reports inter-frame deltas. 100 frames from the primary monitor.

### Half 2 — end-to-end

Tauri 2 + `windows-capture v2`. Rust handler emits a Tauri event (`wgc-frame`) on each frame with `(frame_index, emit_unix_us)` where `emit_unix_us = SystemTime::now().duration_since(UNIX_EPOCH).as_micros()`. JS listener computes `delta_ms = (performance.timeOrigin + performance.now()) - emit_unix_us / 1000`. Cross-process comparison is valid because both timestamps reference the OS wall clock.

Auto-runs on `DOMContentLoaded`; writes results to `%TEMP%\wp06-ipc-results.txt`; calls `app.exit(0)` after 100 samples. Total wall time per run: ~4 seconds.

## Measurement outputs

### Half 1 — capture-only inter-frame delta

| Metric | Value |
|---|---|
| Sample size | 100 frames |
| Wall time | 5,469 ms |
| Avg FPS | 18.3 |
| p50 | 61.4 ms |
| **p90** | **79.4 ms** |
| p99 | 140.0 ms |
| max | 140.0 ms |

### Half 2 — Rust → JS event-bus delta (IPC overhead)

| Metric | Value |
|---|---|
| Sample size | 100 frames |
| Wall time | ~4 s (capture + report + exit) |
| min | 0.17 ms |
| mean | 0.40 ms |
| p50 | 0.35 ms |
| **p90** | **0.51 ms** |
| p99 | 1.72 ms |
| max | 1.72 ms |

### Combined

p90 capture (79.4 ms) + p90 IPC (0.51 ms) = **79.9 ms full-loop p90 estimate** vs 500 ms threshold.

## Caveats

1. **Sum of independent p90s** is an upper-bound estimate, not a measured full-loop p90. A direct end-to-end measurement (timestamp at WGC arrival, timestamp at JS receive, single combined sample) would be tighter — but with 420 ms of headroom, the loose estimate is more than adequate to close the decision.

2. **Static-screen artifact** still applies to the capture half. WGC delivers on change; idle-desktop FPS reflects "how often the screen changes," not a stress ceiling. This matches the actual Omi Rewind workload (per-window screenshot every N seconds) so is the right measurement for the product, but a future "live screen mirroring" feature would need re-measurement under that workload.

3. **Single-machine measurement** — `AG493US3R4` ultrawide on this developer rig. Production confidence requires the same probes on representative low-end targets (8 GB Surface, integrated-GPU laptop). Add to QA matrix before broad launch. With 6.3× headroom, even a 5× regression on weaker hardware still passes.

## Risk register impact

- **Risk #2 (WGC IPC latency budget)** — **CLOSED.** The full-loop p90 estimate sits at 16% of the 500 ms threshold. The WinUI 3 fallback trigger does not fire. Tauri remains primary per `M6-windows-port-decisions.md` Q1.
- **Risks #1, #3, #4, #5, #6, #7** — unchanged.

## Implications for the WBS

- **WP-06 closes as PASS.** Mark in `M6-execution-WBS.md` Wave 1 table.
- **WP-08 (Tauri shell scaffold) is unblocked from the framework-choice angle.** Still gated on the WP-04 (branch strategy) and Backend-Rust vendor decisions.
- **No mid-flight pivot needed.** The recovery plan in `M6-debate-transcript.md` ("WGC frame latency > 500ms → halt, execute WinUI 3 fallback per Question 2 of decisions") does not fire.

## Files referenced (none vendored in this MR)

- `C:\Users\bertc\kDrive\Code\projects\omi-wgc-spike\` — half 1 scratch crate (NOT in this repo; reproducible from snippet above)
- `C:\Users\bertc\kDrive\Code\projects\omi-tauri-ipc-spike\` — half 2 scratch Tauri 2 app (NOT in this repo; reproducible from snippet above)
- `desktop/docs/M6-windows-port-decisions.md` — Q2 specifies the 500 ms threshold and WinUI 3 fallback procedure
- `desktop/docs/M6-execution-WBS.md` — WP-06 row in Wave 1 table (mark PASS)
- `desktop/docs/M6-debate-transcript.md` — Risk #2 (now closed)

## Recommendation

**Mark WP-06 PASS in the WBS.** Proceed with Tauri as the M6.1 framework. WP-08 scaffolding can begin once WP-04 (branch strategy) and the Backend-Rust vendor decisions are made.
