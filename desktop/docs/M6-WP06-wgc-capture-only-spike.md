# WP-06 Spike (partial) — WGC Capture-Only Latency

**Wave:** 1 (M6.1 foundation; gating WP for the Tauri-vs-WinUI-3 framework choice).
**Owner:** Backend.
**Status:** **Capture-only half complete. IPC half still pending** — see "What this does NOT prove" below.
**Companion to:** `M6-windows-port-decisions.md` (Question 2 documents the 500 ms p90 fallback trigger).

## Executive finding

`Windows.Graphics.Capture` (WGC) frame-pool delivery on this Windows 11 development machine sits at **p90 = 79.4 ms inter-frame**, against a documented gating threshold of 500 ms p90. **PASS by ~6×** on the capture side alone.

The remaining gating question — does the IPC hop (Rust → WebView2 / Tauri JS) push the full-loop latency over 500 ms? — is **not yet answered** by this spike. With ~420 ms of headroom in the budget, it would take a 5× IPC overhead to flip the verdict; that is unlikely but unmeasured.

## Reproduce

```powershell
# Sibling scratch crate (intentionally outside the Euraika fork — no
# architectural commitments made here):
cd C:\Users\bertc\kDrive\Code\projects\omi-wgc-spike
cargo build --release
.\target\release\wgc-spike.exe
```

Source: `Cargo.toml` (12 lines, `windows-capture = "2"`) + `src/main.rs` (~125 lines). The probe implements `GraphicsCaptureApiHandler`, captures 100 frames from the primary monitor, and records the `Instant::now()` delta on each `on_frame_arrived` callback.

## Measurement inputs

| Input | Value |
|---|---|
| Crate | `windows-capture v2.0.0` (224k+ downloads on crates.io; wraps `Direct3D11CaptureFramePool`) |
| Frame format | `ColorFormat::Rgba8` |
| Cursor capture | Default (included) |
| Border | Default (suppressed via Win11 22H2+ `graphicsCaptureWithoutBorder` capability) |
| Monitor | Primary — `AG493US3R4` (ultrawide gaming display) |
| Sample size | 100 frames |
| Toolchain | Rust 1.95 stable-x86_64-pc-windows-msvc |

## Measurement outputs

| Metric | Value |
|---|---|
| Wall time | 5,469 ms |
| Avg FPS | 18.3 |
| **Inter-frame p50** | **61.4 ms** |
| **Inter-frame p90** | **79.4 ms** |
| Inter-frame p99 | 140.0 ms |
| Inter-frame max | 140.0 ms |
| Gating threshold (M6 decisions Q2) | 500 ms p90 |
| **Verdict (capture-only)** | **PASS by ~6×** |

## Interpretation

### Why 18 FPS, not 60+?

WGC delivers a frame each time the captured surface changes. With a near-static desktop during the spike (an editor window, no video), the inter-frame deltas are dominated by sparse cursor blinks and idle redraws. **This is not a stress ceiling**; it is a representative inter-frame measurement for an idle workload, which matches the actual Omi Rewind use case (per-window screenshot every N seconds, not 60 fps streaming).

A stress test (video playing fullscreen, screen actively redrawing) would push closer to monitor refresh — but that is not the workload.

### Implication for the actual product workload

Per `M6-windows-port-decisions.md` Q4, the Rewind feature wants **per-window screenshots once per N seconds** for OCR. At 79 ms p90, capture is two orders of magnitude faster than that need. The capture side is not the bottleneck for any plausible Omi feature.

## What this does NOT prove

1. **IPC marshalling cost is unmeasured.** The 500 ms p90 threshold in M6 decisions Q2 is for "captured frame reaches WebView2 and is rendered" — the full chain. This spike measures only the first hop (capture → Rust handler). The remaining hops are:
   - Frame buffer copy (Rust-side, GPU→CPU if needed for serialization)
   - Tauri IPC channel marshalling (likely base64 or a typed-array fast path)
   - WebView2 `postMessage` → JS deserialization → render
   - Each is plausibly <50 ms, summing well under the 500 ms budget — but unmeasured.

2. **Static-screen artifact.** A workload that *forces* WGC to deliver at monitor refresh (e.g., a fullscreen video) was not run. For the Rewind use case this doesn't matter; for any future "live screen mirroring" feature, it would.

3. **Single-machine measurement.** This is one developer machine. Production-class confidence requires the same probe on a representative low-end target (e.g., an 8 GB Surface, an integrated-GPU Win11 laptop). Add to QA matrix before broad launch.

## What needs to happen next

To formally close WP-06 and unlock the rest of Wave 1, the **IPC half needs measurement**. Two paths:

### Path A — minimal Tauri scratch app (sibling to this probe)

Bootstrap a `cargo tauri init`-scale project at a second sibling location (e.g., `C:\Users\bertc\kDrive\Code\projects\omi-tauri-ipc-spike\`), wire `windows-capture` to forward each frame to the WebView via Tauri's event channel, render in JS, measure end-to-end delta. ~1 engineer-day. Doesn't commit to either the **vendor-`Backend-Rust/`** or the **WP-04 branch-strategy** decisions.

### Path B — wait for WP-04 + vendor decisions, then scaffold in-fork

Resolve WP-04 (where does Tauri code live: `desktop/Tauri/` vs `windows/` vs `apps/{mac,windows,web}/+core/`) and the upstream-vendor question, then scaffold WP-08 properly and measure IPC inside it. Same outcome but ties WP-06 closure to architectural sign-off.

**Recommend Path A** — preserves the sibling-scratch separation that has worked well so far for both this WP and WP-07'.

## Risk register impact

- **Risk #2** (WGC IPC latency budget): partially de-risked. With 420 ms of headroom on the IPC half, the WinUI 3 fallback trigger is unlikely to fire. **Not closed.**
- All other risks unchanged.

## Files referenced (none in this MR — sibling scratch crate not vendored)

- `C:\Users\bertc\kDrive\Code\projects\omi-wgc-spike\` — scratch crate (NOT in this repo; reproducible via the snippet above)
- `desktop/docs/M6-windows-port-decisions.md` — Q2 specifies the 500 ms threshold and WinUI 3 fallback procedure
- `desktop/docs/M6-execution-WBS.md` — WP-06 row in Wave 1 table

## Recommendation

Mark WP-06 as **partial-pass** in the WBS (capture half done; IPC half pending). Do not yet flip the framework choice; await Path A measurement. The probability of the WinUI 3 fallback firing has dropped materially but is not zero.
