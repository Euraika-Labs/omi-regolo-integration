# M6 Windows Port — Decision Record

**Companion to:** `M6-windows-port-research.md` (forthcoming Discover-phase report).
**Status:** decisions locked after 5-agent multi-provider research + 4-way convergence (Codex / Gemini / OpenCode / Claude).
**Audience:** the 2-engineer team starting M6 onward.

This file gives one definitive answer to each of the 10 research questions, plus the rationale and the alternatives weighed and rejected. Edit only with a fresh research pass.

## Summary table

| # | Question | Decision |
|---|---|---|
| 1 | Native Windows UI stack | **Tauri v2 + Rust core** (primary) |
| 2 | Cross-platform option (if Tauri rejected later) | **WinUI 3 + .NET 8** |
| 3 | Audio capture API | **WASAPI** via `cpal` (Rust) for mic + loopback |
| 4 | Screen capture API | **Windows.Graphics.Capture (WGC)** via `windows` crate |
| 5 | System tray + shield indicator | **Win32 `Shell_NotifyIcon`** + two pre-rendered ICOs swapped via `NIM_MODIFY` |
| 6 | E2E automation analog to agent-swift | **UI Automation (UIA) + FlaUI (C#)** or **pywinauto (Python)** |
| 7 | BYOK key storage | **Windows Credential Manager** (`CredWrite`) |
| 8 | Packaging + distribution | **MSIX bundle + Azure Artifact Signing + `.appinstaller` + winget manifest** |
| 9 | Codemagic equivalent for Windows CI | **GitHub Actions `windows-latest`** |
| 10 | Code-sharing strategy | **Extract Rust core** from existing `Backend-Rust/` + share it across mac & Windows |

## Question 1 — Native Windows UI stack

**Decision:** Tauri v2 (Rust + WebView2).

**Rationale:**
- Smallest installer (~10 MB vs WinUI 3's 30-60 MB MSIX vs Electron's 150-250 MB).
- First-class system tray via `tauri::tray::TrayIconBuilder` — WinUI 3 still has no native tray in 2026 (microsoft-ui-xaml#2020 still open), forcing every WinUI 3 app to depend on `H.NotifyIcon.WinUI` Win32 interop.
- Built-in updater plugin matches Sparkle's mental model.
- WebView2 ships with Win11; Deepgram's JS SDK runs unmodified.
- Reuses the existing omi web-frontend skill set (TypeScript, React).
- Ship velocity for a 2-engineer team is ~2× WinUI 3 per cross-validated agent estimates.

**Rejected alternatives:**
- **WinUI 3 + .NET 8** — most native-feeling on Win11 but no native tray + larger installer + slower 2-engineer ship velocity. Fall-back if WebView2 turns out to be a non-starter for a specific feature.
- **MAUI** — desktop is afterthought; no first-class system audio.
- **Electron** — same disadvantages as Tauri but 15× the binary size.
- **Compose Multiplatform** — closest mental model to SwiftUI but JNI tax for audio/screen capture, plugins community-maintained.
- **WPF** — Win11 visual fidelity lags (no Mica without backports).
- **Flutter desktop** — too many community plugins on the critical path.

## Question 2 — Cross-platform fallback

**Decision:** WinUI 3 + .NET 8.

**When to switch:** if a M6/M7 spike reveals a hard blocker in WebView2 (e.g. screen capture frame-rate limits, audio device latency, or a UX gesture that can't be reasonably synthesized in HTML/CSS), pivot to WinUI 3 + Win32 interop. Reuses ~50% of the M6/M7 work because the Rust core remains the same.

**Rejected alternatives:** see Question 1.

## Question 3 — Audio capture

**Decision:** WASAPI via the Rust `cpal` crate for mic capture; WASAPI loopback (Win32 raw COM via `windows` crate) for system-audio capture.

**Rationale:**
- WASAPI mic + loopback is the recommended Win11 path per Microsoft Learn. Loopback is a render endpoint (not a capture device) so unpackaged Win32 apps don't trigger an OS consent prompt.
- Win11 24H2 added `AUDCLNT_STREAMOPTIONS_POST_VOLUME_LOOPBACK` for pre/post-volume tap selection — useful when capturing meeting audio without including the user's own microphone.
- `cpal` covers both macOS CoreAudio and Windows WASAPI behind one Rust trait, so the audio-pipeline code in the Rust core stays platform-agnostic.
- Deepgram has no Windows-specific SDK; their JS SDK (browser WebSocket) and Rust SDK both work cleanly. Tauri lets the JS SDK do the streaming directly from the WebView, with audio frames pushed to JS via Rust IPC.
- For the alternative WinUI path: Deepgram's official .NET 4.0 SDK ships a `Deepgram.Microphone` helper that streams NAudio → WebSocket out of the box.

**Rejected alternatives:**
- **`Windows.Media.Capture`** (WinRT) — mandatory consent prompt every launch; no loopback. Too heavy.
- **miniaudio (C lib)** — wraps WASAPI well but loses event-driven buffering; reasonable for prototypes only.
- **GDI BitBlt + audio** — N/A for audio.

## Question 4 — Screen capture

**Decision:** `Windows.Graphics.Capture` (WGC) via the Rust `windows` crate, with `graphicsCaptureProgrammatic` + `graphicsCaptureWithoutBorder` capabilities so the Win11 yellow capture border is suppressed.

**Rationale:**
- GPU-backed (`Direct3D11CaptureFramePool`); supports both per-window (`CreateForWindow`) and per-monitor (`CreateForMonitor`); honors `WDA_EXCLUDEFROMCAPTURE` for password fields (Recall integration).
- Matches the "Rewind" feature's needs: per-window screenshot once per N seconds, BGRA8 frame pool, OCR downstream.
- Win11 22H2+ supports borderless programmatic capture with the right manifest declarations.

**Rejected alternatives:**
- **DXGI Desktop Duplication** — full-monitor only, no per-window targeting, 4-process-per-session limit. Useful only as a fallback for older hardware.
- **GDI BitBlt / PrintWindow** — deprecated, fails on hardware-accelerated/DRM windows.

## Question 5 — System tray + shield indicator

**Decision:** Win32 `Shell_NotifyIcon` directly (via Tauri's tray builder, which bridges to it). Ship two pre-rendered ICOs (`tray.ico`, `tray-shield.ico`) at 16/20/24/32/40 px. Swap with `NIM_MODIFY` when `eu_privacy_mode_enabled` changes.

**Rationale:**
- There is **no Windows API to composite an overlay onto an existing tray icon** — the macOS `NSStatusItem.button.subviews` pattern doesn't translate. Microsoft-recommended pattern is two pre-rendered icons.
- `ITaskbarList3::SetOverlayIcon` is the **taskbar button** overlay, not the **tray** — a common confusion.
- WinUI 3 still has no native tray API in 2026. Tauri abstracts the Win32 call cleanly.
- Use a GUID in `guidItem` so Win11 remembers the user's pin/promote choice across launches.

**Rejected alternatives:**
- `H.NotifyIcon.WinUI` — required only if going the WinUI 3 path.
- Electron `Tray` — same API surface, 120 MB Chromium overhead unjustified.

## Question 6 — E2E automation analog to agent-swift

**Decision:** UI Automation (UIA) + **FlaUI** (C#) for the test harness.

**Rationale:**
- UIA is the official Microsoft analog to macOS Accessibility API — it covers Win32, WinForms, WPF, WinUI 2/3, Edge/WebView2 uniformly via `IUIAutomationElement` trees with `AutomationId`, `ControlType`, control patterns (`InvokePattern`, `TogglePattern`, etc.).
- FlaUI's ergonomics are closest to agent-swift: `window.FindFirstDescendant(cf.ByAutomationId("save")).Patterns.Invoke.Pattern.Invoke()`.
- WinAppDriver development is paused (Microsoft hasn't shipped a release since 2019). FlaUI is the 2026 default per the testing-tools community.
- Tag every interactive Tauri/WinUI element with `data-automation-id` (HTML) or `AutomationProperties.AutomationId` (XAML) so refs are stable — same discipline as `accessibilityIdentifier` on SwiftUI.

**Rejected alternatives:**
- **pywinauto** — fine if the team prefers Python; FlaUI gives slightly better Tauri/WebView2 coverage.
- **Inspect.exe** + Accessibility Insights — these are inspectors, not automation drivers (analog to macOS Accessibility Inspector).
- **Playwright** — only handles WebView2 content, not native Win32/WinUI controls.
- **WinAppDriver** — paused upstream; risky long-term bet.

## Question 7 — BYOK key storage

**Decision:** Windows Credential Manager (`CredWrite` / `CredRead` Win32) for individual BYOK keys, fronted by a thin Rust crate (e.g. `keyring` which wraps both macOS Keychain and Win Credential Manager).

**Rationale:**
- Closest behavioral match to macOS Keychain: per-user, OS-managed, survives reinstall, accessible without an MSIX/AppContainer manifest.
- The `keyring` Rust crate (used by `cargo-credential` and `git-credential-rs`) wraps both macOS Keychain and Windows Credential Manager behind one API — perfect for the omi shared-Rust-core design.
- DPAPI (`CryptProtectData`) is a fallback for bulk JSON config blobs that don't fit the per-secret model. Ship later if needed.

**Rejected alternatives:**
- **`Windows.Security.Credentials.PasswordVault`** — 20-credential cap, AppContainer/UWP only. Wrong fit for a non-MSIX dev build.
- **Custom AES-GCM file** — only justified if cross-platform parity is required AND the OS keystore is unsuitable. Not the case here.

## Question 8 — Packaging + distribution

**Decision:** MSIX bundle + Azure Artifact Signing (~$10/mo) + `.appinstaller` auto-update channel + winget manifest. Tauri builds NSIS by default but can produce MSIX via `tauri.conf.json` `bundle.targets`.

**Rationale:**
- **EV certs no longer bypass SmartScreen** — Microsoft removed EV-specific OIDs from the Trusted Root Program in 2024. Don't pay $400+/yr for EV.
- **Azure Artifact Signing** (the renamed Trusted Signing service) is ~$10/mo, no HSM required, US/CA/EU/UK orgs eligible. Identity-based reputation that clears warnings within weeks.
- **`.appinstaller` schema must be 2021** — VS-default is 2017/2 which silently ignores `ShowPrompt` / `UpdateBlocksActivation` / `HoursBetweenUpdateChecks`. Hand-edit the `xmlns`.
- **`ms-appinstaller://`** has been disabled by default since Dec 2023 — users download `.appinstaller` files manually now. Plan UX accordingly.
- **winget manifest** in `microsoft/winget-pkgs` gives `winget install omi` discoverability and update-via-CLI for power users.
- **MS Store optional** — separate channel, free re-signing, no SmartScreen ever, but submission overhead. Ship later as a P2 polish item.

**Rejected alternatives:**
- **MSI / WiX** — pick if enterprise procurement requires it. M8 fallback only.
- **Squirrel.Windows** — abandoned upstream. Don't start here.
- **Velopack** — modern Squirrel fork; strong runner-up if MSIX's container model fights screen-capture/audio code. Re-evaluate after M6 spike.
- **Inno Setup / InstallForge** — fine for beta but you build update logic. Skip.
- **Portable EXE** — power-user channel only; consider for unsigned dev builds.

## Question 9 — CI

**Decision:** GitHub Actions `windows-latest` runners with the `azure/trusted-signing-action` step.

**Rationale:**
- Free for OSS repos.
- Native Windows SDK + SignTool path setup.
- Microsoft publishes the official `azure/trusted-signing-action@v0` so signed-MSIX-then-publish is ~10 lines of YAML.
- Aligns with the existing GitHub-based workflow (the M3+M4 desktop/web work already used the upstream-omi `Euraika-Labs/omi` fork's GitHub Actions).
- `wingetcreate` integrates cleanly so the same workflow can PR `microsoft/winget-pkgs` after each release.

**Rejected alternatives:**
- **Azure Pipelines Microsoft-hosted** — fine if you're already in Azure DevOps; no advantage for an OSS-on-GitHub project.
- **AppVeyor** — losing mindshare.
- **Codemagic** — macOS/iOS/Flutter focused, no first-class Windows MSIX agent.

## Question 10 — Code-sharing strategy

**Decision:** Extract a `omi-core` Rust crate from the existing `Backend-Rust/` codebase. Share it across macOS (via UniFFI → Swift bindings) and Windows (direct FFI from Rust→Tauri). UI is per-OS: SwiftUI on macOS keeps the existing 266-file investment; Tauri (TS/React) on Windows is a fresh build sharing the Rust core.

**What goes into the Rust core (in priority order):**
1. `Models/` (Codable structs → `serde` structs, ~1 week)
2. `Providers/{Claude,Gemini,Regolo}` clients (~95% reusable; pure HTTP+SSE; use `reqwest` + `reqwest-eventsource` + `anthropic-sdk-rust`)
3. `APIClient.swift` HTTP layer (~90% reusable: `URLSession` → `reqwest`)
4. `AuthService.swift` (~85% reusable; trickiest part is keychain abstraction → use `keyring` crate)
5. `BYOKValidator.swift` + CryptoKit (~95% reusable via `ring` or `RustCrypto/aes-gcm`)
6. `WAL/` + `Stores/` (SQLite via `rusqlite` shared)

**What stays per-OS:**
- All `Audio/` (CoreAudio macOS / WASAPI Windows via `cpal`)
- All `Bluetooth/` (CoreBluetooth macOS / `btleplug` cross-platform actually covers both — could share)
- All `Rewind/` screen capture (CGWindowList macOS / `Windows.Graphics.Capture` Windows)
- All UI (SwiftUI on Mac, Tauri/React on Windows)

**Estimated reuse:** 50-65% of the 140k Swift LOC. The 35-50% rewrite is unavoidable because of the macOS-specific UI and platform-API surface.

**Rejected alternatives:**
- **Pure rewrite (C#/WinUI)** — 0% reuse, two divergent codebases forever. Slow.
- **Swift on Windows** — toolchain ships in 2026 (Swift Workgroup formed Jan 2026) but no SwiftUI/AppKit on Windows. ~35-45% logic-only reuse, but UI is full Win32 rewrite anyway. Pay the FFI tax twice. **Trap.**
- **Wasm Component Model** — 50-60% reuse with cleaner ABI but 2026 desktop tooling is still rough. Premature.
- **Tauri-only TypeScript core** — 70-85% UI reuse but you abandon SwiftUI investment on macOS. Considered and rejected because the existing 266-file Swift codebase is too valuable to throw away.
- **C ABI from Swift** — theoretically possible but worse than the Rust core in every dimension.

## Open follow-ups before M6 starts

1. **Audit `Backend-Rust/Cargo.toml`** to see what's already there. Decide: extend in place, or start a sibling `omi-core` crate?
2. **Tauri or WinUI commitment** — confirm Tauri before M6 starts. If product wants WinUI 3 native-feel, the Rust core decision still holds but ship velocity drops ~30%.
3. **Branch strategy in the patch package** — does Windows code live in `windows/` parallel to `desktop/` (mac), or do we restructure into `apps/{mac,windows,web}/` with shared `core/`?
4. **CI cost** — Azure Artifact Signing $10/mo is trivial but needs a billing account in the Euraika-Labs org. Set this up before signing the first MSIX.

## Sign-off

Decisions above lock unless the M6 technical spike (the first 1-2 weeks of foundation work) surfaces a hard blocker. In that case, this file gets a "**Revised: \<date\>**" header and the affected question is rewritten with new evidence.
