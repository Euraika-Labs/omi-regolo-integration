// Omi for Windows — Tauri shell.
//
// On startup, spawn the `omi-desktop-backend.exe` child process (vendored at
// `<repo>/backend-rust/`) on a known localhost port and let the WebView talk
// to it via HTTP/WS — same shape as the Mac SwiftUI app.
//
// What this scaffold delivers (WP-08 exit criteria):
//   - `cargo tauri dev` opens a window with the React frontend
//   - A Tauri command `get_backend_health` HTTP-GETs the child's /health
//     endpoint so the UI can show backend status
//   - A Tauri command `get_backend_status` reports child-process state
//
// Out of scope here (later WPs): WGC capture, audio capture, system tray,
// Settings UI, real chat flows.
//
// Added in WP-15 in-app: BYOK key storage commands backed by Windows
// Credential Manager via the `keyring` crate (pinned v3 — see spike doc).

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::process::{Child, Command};

/// Port the backend binds to. Hardcoded for the scaffold; will move to config
/// once Settings (WP-10) lands.
const BACKEND_PORT: u16 = 10201;

/// Holds the spawned child handle so we can kill it on app exit.
/// Arc<Mutex<>> so the setup-hook async task can stash the child while the
/// Tauri command handlers can read it.
#[derive(Clone, Default)]
struct BackendProcess(Arc<Mutex<Option<Child>>>);

/// Locate the bundled `omi-desktop-backend.exe`. In dev (`cargo tauri dev`)
/// it lives at `<repo>/backend-rust/target/release/omi-desktop-backend.exe`.
/// In a production MSIX (WP-18 onward) it'll be co-located with the Tauri exe.
fn locate_backend_exe(app: &AppHandle) -> Option<PathBuf> {
    let exe_name = if cfg!(windows) {
        "omi-desktop-backend.exe"
    } else {
        "omi-desktop-backend"
    };

    // Prod path: alongside the Tauri exe.
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join(exe_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    // Dev path: walk up from CARGO_MANIFEST_DIR (windows/src-tauri) to the repo
    // root, then into backend-rust/target/release/.
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = here.parent()?.parent()?; // src-tauri -> windows -> repo
    let dev = repo_root
        .join("backend-rust")
        .join("target")
        .join("release")
        .join(exe_name);
    if dev.is_file() {
        Some(dev)
    } else {
        None
    }
}

async fn spawn_backend(app: AppHandle) -> Result<Child, String> {
    let exe = locate_backend_exe(&app).ok_or_else(|| {
        "could not locate omi-desktop-backend exe; did you `cargo build --release` in backend-rust/?".to_string()
    })?;
    println!("[omi-windows] spawning backend: {}", exe.display());

    let child = Command::new(&exe)
        .env("PORT", BACKEND_PORT.to_string())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn {}: {e}", exe.display()))?;

    Ok(child)
}

#[derive(Serialize)]
struct BackendHealth {
    reachable: bool,
    status: Option<u16>,
    body: Option<String>,
    error: Option<String>,
}

#[tauri::command]
async fn get_backend_health() -> BackendHealth {
    let url = format!("http://127.0.0.1:{BACKEND_PORT}/health");
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return BackendHealth {
                reachable: false,
                status: None,
                body: None,
                error: Some(format!("client build: {e}")),
            };
        }
    };
    match client.get(&url).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.ok();
            BackendHealth {
                reachable: true,
                status: Some(status),
                body,
                error: None,
            }
        }
        Err(e) => BackendHealth {
            reachable: false,
            status: None,
            body: None,
            error: Some(e.to_string()),
        },
    }
}

#[derive(Serialize)]
struct BackendStatus {
    spawned: bool,
    pid: Option<u32>,
    exited: bool,
    exit_code: Option<i32>,
}

#[tauri::command]
async fn get_backend_status(state: State<'_, BackendProcess>) -> Result<BackendStatus, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let Some(child) = guard.as_mut() else {
        return Ok(BackendStatus {
            spawned: false,
            pid: None,
            exited: false,
            exit_code: None,
        });
    };
    let pid = child.id();
    match child.try_wait().map_err(|e| e.to_string())? {
        Some(status) => Ok(BackendStatus {
            spawned: true,
            pid,
            exited: true,
            exit_code: status.code(),
        }),
        None => Ok(BackendStatus {
            spawned: true,
            pid,
            exited: false,
            exit_code: None,
        }),
    }
}

/// Kept from the template for the React greet button until real commands land.
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
}

// ===== BYOK key storage =====
// Backed by `keyring` v3, which talks to Windows Credential Manager directly.
// Each provider's key is stored as a separate Credential Manager entry under
// the service "omi-byok-<provider>" / account "default". WP-15 spike (MR !18)
// validated the round-trip end-to-end on this machine.

const BYOK_ACCOUNT: &str = "default";

fn byok_entry(provider: &str) -> Result<keyring::Entry, String> {
    let provider = provider.trim().to_lowercase();
    if provider.is_empty() {
        return Err("provider must not be empty".into());
    }
    let service = format!("omi-byok-{provider}");
    keyring::Entry::new(&service, BYOK_ACCOUNT).map_err(|e| format!("entry: {e}"))
}

#[tauri::command]
fn set_byok_key(provider: String, value: String) -> Result<(), String> {
    if value.is_empty() {
        return Err("value must not be empty (use delete_byok_key to clear)".into());
    }
    byok_entry(&provider)?
        .set_password(&value)
        .map_err(|e| format!("set: {e}"))
}

/// Returns Some(key) if a key is stored, None if no entry exists. Errors
/// only on actual OS / API failures.
#[tauri::command]
fn get_byok_key(provider: String) -> Result<Option<String>, String> {
    let entry = byok_entry(&provider)?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("get: {e}")),
    }
}

#[tauri::command]
fn delete_byok_key(provider: String) -> Result<(), String> {
    let entry = byok_entry(&provider)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // Treat "no entry" as success — caller's invariant ("the key is now
        // gone") holds either way.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("delete: {e}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(BackendProcess::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let proc_handle = app.state::<BackendProcess>().0.clone();
            tauri::async_runtime::spawn(async move {
                match spawn_backend(handle).await {
                    Ok(child) => {
                        if let Ok(mut guard) = proc_handle.lock() {
                            *guard = Some(child);
                        }
                    }
                    Err(e) => eprintln!("[omi-windows] backend spawn failed: {e}"),
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_backend_health,
            get_backend_status,
            set_byok_key,
            get_byok_key,
            delete_byok_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
