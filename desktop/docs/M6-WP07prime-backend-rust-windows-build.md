# WP-07' Verification — `Backend-Rust/` Builds on Windows

**Wave:** 1 (M6.1 foundation; renamed from original WP-07 after WP-01 audit found `Backend-Rust/` already production-ready).
**Owner:** Backend.
**Effort actual:** ~1 hour (vs budgeted 1 day).
**Companion to:** `M6-WP01-backend-rust-audit.md` (the audit that flagged this verification as the natural follow-up).

## Executive finding

`cargo build --release` against upstream `BasedHardware/omi:desktop/Backend-Rust/` succeeds cleanly on Windows MSVC. The audit's claim — "no platform-specific deps in the dependency tree" — holds.

**Build verdict:** ✅ ready to launch as a child process from a Tauri shell, after a small Linux-path patch.

## Reproduce

```powershell
# Toolchain (one-time per machine):
winget install --id Rustlang.Rustup --silent --accept-package-agreements --accept-source-agreements
# Picks stable-x86_64-pc-windows-msvc by default; uses VS 2019 Build Tools if present.

# Source (upstream — see "Caveat: source location" below):
git clone --depth 1 https://github.com/BasedHardware/omi.git
cd omi/desktop/Backend-Rust

cargo build --release
```

## Build inputs

| Input | Value |
|---|---|
| Rust toolchain | 1.95.0 stable-x86_64-pc-windows-msvc |
| Linker | MSVC via VS 2019 Build Tools (`Microsoft.VisualStudio.Component.VC.Tools.x86.x64`) |
| Crate | `omi-desktop-backend 0.1.0` (edition 2021), `Cargo.toml` unchanged |
| Profile | `--release` |

## Build outputs

| Metric | Value |
|---|---|
| Result | `Finished release profile [optimized] target(s) in 58.44s` |
| Binary | `target/release/omi-desktop-backend.exe` — **9.58 MB** |
| PDB | `target/release/omi_desktop_backend.pdb` — 4.9 MB |
| Errors | **0** |
| Warnings | 375 (all `function/struct never used`; incomplete route wiring on the Mac-side caller, not a Rust issue) |
| Future-incompat | 1 (`redis v0.25.4` — non-blocking; upstream's redis bump will resolve) |

## Runtime gotcha — Linux path hardcode

The exe panics on launch, NOT a build issue:

```
thread 'main' panicked at src\main.rs:64:10:
Failed to open log file: Os { code: 3, kind: NotFound,
                              message: "The system cannot find the path specified." }
```

Source: `src/main.rs:60-64` opens `/tmp/omi-dev.log`. Linux/macOS-only path, hardcoded to match the Swift dev app convention. The 1-line fix:

```rust
// Before:
let log_file = OpenOptions::new().create(true).append(true)
    .open("/tmp/omi-dev.log")
    .expect("Failed to open log file");

// After (cross-platform):
let log_path = std::env::temp_dir().join("omi-dev.log");
let log_file = OpenOptions::new().create(true).append(true)
    .open(&log_path)
    .expect("Failed to open log file");
```

A grep for other `/tmp/` or `/var/` literals in the crate is recommended before declaring the runtime fully Windows-clean. Tracked as a Wave-1 follow-up (small, ~1d).

## Caveat — source location

`desktop/Backend-Rust/` is **not** in this Euraika fork (`omi-regolo-integration`). It lives only in upstream `BasedHardware/omi`. Verification was performed against a sparse clone of upstream; this repo's main branch has never contained the directory.

**Open architectural decision (separate from this WP):** vendor `desktop/Backend-Rust/` into the Euraika fork for shipping independence, vs. continue pulling from upstream at MSIX-build time. Recommend deciding before WP-08 (Tauri shell scaffold) so the shell knows what relative path to spawn the binary from.

## Implications

### WP-01 audit's projection holds

The audit projected: **Wave 1 (M6.1) shrinks 4-5 wk → 1-2 wk** because the Rust core is reusable as-is. This verification confirms that — the only Wave-1 Rust work remaining is:

1. Resolve the source-location decision (vendor vs upstream pin)
2. Patch the handful of Linux-path literals (`/tmp/omi-dev.log` and any siblings)
3. Have the Tauri shell launch the exe as a child process and HTTP/WS to it on `localhost`

### Risk #5 (team Rust proficiency) unchanged

Building someone else's Rust crate is not the same as authoring Rust under deadline pressure. This verification doesn't speak to Risk #5 from the debate transcript; that audit (WP-02) is still required.

### Suggested next gate

WP-06 (WGC IPC latency spike) remains the next gating decision per the WBS. Verification of the Rust binary build does not change WP-06's framework choice — Tauri vs WinUI 3 still hinges on whether `Windows.Graphics.Capture` frames can be IPC'd to a WebView2 within the 500ms p90 budget.

## Files in this WP

| File | Action | Notes |
|---|---|---|
| `desktop/docs/M6-WP07prime-backend-rust-windows-build.md` | NEW (this doc) | Deliverable |
| `desktop/docs/M6-execution-WBS.md` | Unchanged | WP table already names this WP-07' |
| `desktop/docs/M6-WP01-backend-rust-audit.md` | Unchanged | Audit's Open Question #3 (process-lifecycle) still open — separate WP |

No code changes in this MR.
