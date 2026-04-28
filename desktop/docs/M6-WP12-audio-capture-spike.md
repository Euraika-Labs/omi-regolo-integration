# WP-12 Spike — `cpal` Audio Capture (Mic + WASAPI Loopback)

**Wave:** 2 (M6.2 feature parity).
**Owner:** Backend.
**Status:** **CLOSED — PASS on both halves.** Mic capture and WASAPI loopback both work via the `cpal` crate's `build_input_stream` API on Windows.
**Companion to:** `M6-windows-port-decisions.md` Q3 (audio capture API choice).

> Note: Wave 2 spike done early because the WP-06 framework gating spike landed cleanly, freeing time. The actual WP-12 implementation (Deepgram WS plumbing, channel resampling, gain control, retry/backoff) is still ~10 engineer-days; this spike only validates that the bottom-of-stack capture works.

## Executive finding

The decisions doc Q3 commits to "WASAPI via the Rust `cpal` crate for mic capture; WASAPI loopback for system-audio capture." This spike confirms both. Same `build_input_stream` API across the two; only the device source differs (default input device vs default output device).

## Reproduce

```powershell
# Sibling scratch crate, intentionally outside the Euraika fork:
cd C:\Users\bertc\kDrive\Code\projects\omi-audio-spike
cargo build --release
.\target\release\audio-spike.exe
# (5s mic capture + 5s loopback with self-generated 440 Hz tone)
```

`Cargo.toml` (8 lines): `cpal = "0.17"`. `src/main.rs` (~220 LOC) opens a stream per half, counts callbacks/samples/non-zero/RMS, and prints PASS/WARN/FAIL.

## Measurement outputs

### Mic — default input device

| Metric | Value |
|---|---|
| Device | `Microphone` (system default input) |
| Config | 48 kHz, 2 ch, F32 |
| Wall time | 5 s |
| Callbacks | 498 |
| Samples got / expected | 478,046 / 480,000 |
| **Delivery ratio** | **99.6%** |
| Non-zero samples | 99.6% |
| RMS amplitude | 0.011 (ambient room sound) |
| **Verdict** | **PASS** |

### Loopback — default output device

| Metric | Value |
|---|---|
| Device | `IT663x1` (system default output, used as input via WASAPI loopback) |
| Config | 48 kHz, 2 ch, F32 |
| Source audio | Self-generated 440 Hz sine, 25% volume, played on same device |
| Wall time | 5 s |
| Callbacks | 500 |
| Samples got / expected | 480,000 / 480,000 |
| **Delivery ratio** | **100.0%** |
| Non-zero samples | 100.0% |
| RMS amplitude | 0.0019 (the attenuated tone) |
| **Verdict** | **PASS** |

## Implementation note (cpal 0.17 nuance)

To open a loopback capture in cpal 0.17:

```rust
let device = host.default_output_device().unwrap();
// Use OUTPUT config (not input) on the output device:
let cfg = device.default_output_config()?;
let stream = device.build_input_stream(&cfg.into(), data_cb, err_cb, None)?;
```

Calling `default_input_config()` on an output device returns `StreamTypeNotSupported` in cpal 0.17 (this was permitted in older versions but was always semantically wrong). Use the device's own output config — cpal/WASAPI recognises the output-device + input-stream combination as a loopback request.

## Side-finding worth carrying forward

**WASAPI loopback delivers no callbacks when nothing is playing.** A first run with no audio source produced 0 callbacks / 0 samples — initially mistaken for a broken stream. Adding a self-played tone immediately produced 100% delivery.

Production implications:
- Do **not** rely on regular callback cadence for keep-alives, watchdog timers, or "is the stream healthy?" heuristics during silence.
- Deepgram and similar streaming pipelines should not consider "no data for N seconds" as an error condition during obvious silence — pair with VAD or separate health-check.
- For "always-on" recording (e.g., per-window meeting capture), you may want to inject silence buffers manually if the downstream consumer requires continuous data.

## What this DOES NOT cover

- **Format negotiation edge cases** — only the device's default config tested; WASAPI's mix format handling for non-default sample rates / channel layouts unmeasured.
- **MSIX behaviour** — runs as unpackaged Win32 binary; the MSIX manifest declarations from `M6-windows-port-decisions.md` Q4/Q8 may change consent or permission behaviour. Re-test post-WP-18.
- **Latency** — not measured. The Deepgram streaming budget needs end-to-end (capture → frames → WS → response) numbers; out of scope here.
- **Long-running stability** — 5 s test, not a 30-min meeting.
- **Multi-device / device hot-plug** — not exercised.
- **Resampling, gain, AGC, noise suppression** — out of scope; cpal exposes raw frames only.

## Risk register impact

- **None of the 7 risks from `M6-debate-transcript.md` mention audio.** This spike de-risks an unenumerated implementation question (does `cpal` actually deliver as the decisions doc promises?) — answer: yes.

## Implications for the WBS

- **WP-12 implementation can proceed confidently.** The bottom-of-stack capture is solid. The remaining 10 engineer-days are about Deepgram plumbing, gain/AGC, and integration with the Tauri shell — all above the cpal layer.
- **The `Backend-Rust` crate** does NOT need audio code (per WP-01 audit, all Audio/ stays per-OS). The cpal-based capture lives in the per-OS layer of the Tauri shell, not in the shared core.

## Files referenced (none vendored in this MR)

- `C:\Users\bertc\kDrive\Code\projects\omi-audio-spike\` — scratch crate (NOT in this repo; reproducible from snippet above)
- `desktop/docs/M6-windows-port-decisions.md` — Q3 commits to cpal + WASAPI loopback
- `desktop/docs/M6-execution-WBS.md` — WP-12 row in Wave 2 table

## Recommendation

**Mark WP-12 spike PASS in the WBS** (separate from the full implementation effort). When implementation begins, start from `omi-audio-spike` as the seed module — both halves of capture are already validated.
