# WP-15 Spike — `keyring` Crate Round-Trip on Windows Credential Manager

**Wave:** 2 (M6.2 feature parity).
**Owner:** Backend.
**Status:** **CLOSED — PASS on all 5 round-trip tests.** The `keyring` crate writes, reads (same and fresh handle), and deletes credentials in Windows Credential Manager.
**Companion to:** `M6-windows-port-decisions.md` Q7 (BYOK key storage choice).

> Like WP-12, this is a Wave-2 spike done early. The full WP-15 implementation (BYOK lifecycle: rotate, multi-provider per-key separation, fingerprint comparison, migration on Mac↔Win move) is still ~4 engineer-days; this spike only validates the OS plumbing.

## Executive finding

The decisions doc Q7 commits to "Windows Credential Manager (`CredWrite` / `CredRead` Win32) for individual BYOK keys, fronted by a thin Rust crate (e.g. `keyring` which wraps both macOS Keychain and Win Credential Manager)." This spike confirms `keyring` works exactly as advertised on Windows, with one **important version-pinning finding**.

## Reproduce

```powershell
cd C:\Users\bertc\kDrive\Code\projects\omi-keyring-spike
cargo build --release
.\target\release\keyring-spike.exe
```

`Cargo.toml` (8 lines): `keyring = { version = "3", features = ["windows-native"] }`. `src/main.rs` (~85 LOC) runs 5 tests in sequence and prints PASS/FAIL.

## Test results

| Test | Action | Result |
|---|---|---|
| T1 | `Entry::new(SERVICE, ACCOUNT).set_password(VALUE)` | **OK** |
| T2 | Same handle: `entry.get_password()` matches input (35 bytes) | **OK** |
| T3 | Fresh handle: `Entry::new(...).get_password()` returns same bytes | **OK** — persisted to Credential Manager (not just in-process cache) |
| T4 | `entry.delete_credential()` | **OK** |
| T5 | After delete: `get_password()` returns `Error::NoEntry` | **OK** |

Build time: ~3s incremental (after cold cargo cache from earlier spikes). Run time: <100 ms.

## Important — pin to keyring v3, NOT v4

**keyring v4 pulls in `aegis v0.9.8` for credential encryption, and aegis's build script requires `clang-cl.exe` (LLVM Clang in MSVC-compat mode) on Windows.** Without LLVM installed (winget `LLVM.LLVM`, ~250 MB), the v4 build fails with:

```
error occurred in cc-rs: failed to find tool "clang-cl.exe": program not found
```

**v3 has no aegis dep** and uses Win Credential Manager directly via `windows-sys`. v3 is what `cargo-credential` and `git-credential-rs` (and most production Rust tooling) use today, so it's the right baseline regardless.

**Recommendation for the actual M6 implementation:**

```toml
keyring = { version = "3", features = ["windows-native"] }
```

If a future M6/M7 need pulls us to v4 (e.g., for an aegis-encrypted credential format), budget the LLVM install as a CI dependency. **Until then, stay on v3.**

## What this DOES NOT cover

- **Multi-provider BYOK** — only one secret per service+account tested. The actual M6 schema needs per-provider separation (regolo / claude / openai / etc.) — straightforward to extend, not exercised here.
- **Long-lived persistence** — credentials persisted across handles in the same process. Survival across reboot is documented behaviour of Win Credential Manager but not directly tested in this 100 ms run.
- **MSIX / AppContainer** — runs as unpackaged Win32. AppContainer behaviour for `CredWrite` may differ; re-test post-WP-18.
- **Keychain parity (macOS)** — keyring is the cross-platform layer; this spike only exercises Windows. Mac-side behaviour with the same code is presumed working (the audit's WP-01 confirmed Backend-Rust uses similar primitives).
- **Concurrent access from multiple processes** — typical OS behaviour is "last writer wins" with no locks; not exercised.

## Risk register impact

- None of the 7 risks from `M6-debate-transcript.md` mention BYOK storage. This spike de-risks an unenumerated implementation question (does `keyring` actually deliver as Q7 promises?) — answer: yes, on v3.

## Implications for the WBS

- **WP-15 implementation can proceed confidently.** Bottom-of-stack works. Remaining ~4 engineer-days are about per-provider schema, lifecycle (rotate, revoke), and cross-platform Mac sync.
- **Add to the "version pin" notes** for the eventual omi-core BYOK module: `keyring = "3"`, `features = ["windows-native"]`. Don't drift to v4 unless we accept the LLVM toolchain cost.

## Files referenced (none vendored in this MR)

- `C:\Users\bertc\kDrive\Code\projects\omi-keyring-spike\` — scratch crate (NOT in this repo; reproducible from snippet)
- `desktop/docs/M6-windows-port-decisions.md` — Q7 commits to keyring + Windows Credential Manager
- `desktop/docs/M6-execution-WBS.md` — WP-15 row in Wave 2 table

## Recommendation

**Mark WP-15 spike PASS in the WBS** with the v3-pin note. When implementation begins, the `omi-keyring-spike` 5-test sequence is a good template for the regression test suite.
