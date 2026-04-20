// Prevents a console window from appearing behind the app in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_dialog::DialogExt;

const PROJECT_DIR: &str        = r"D:\localai-platform";
const LOCAL_HEALTH_URL: &str   = "http://localhost:8000/health";
const POLL_INTERVAL_SECS: u64  = 2;
const STARTUP_TIMEOUT_SECS: u64 = 120;
const CONFIG_FILE: &str        = "skailer-config.json";

// ---------------------------------------------------------------------------
// Server config — read from %APPDATA%\com.skailer.app\skailer-config.json
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, serde::Serialize, Debug, Clone)]
struct ServerConfig {
    #[serde(rename = "type")]
    mode: String,  // "local" | "remote"
    url:  String,
}

fn read_server_config(app: &AppHandle) -> Option<ServerConfig> {
    let path = app.path().app_data_dir().ok()?.join(CONFIG_FILE);
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Tauri command — called by the setup wizard to persist the server choice.
#[tauri::command]
fn save_server_config(app: AppHandle, mode: String, url: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let cfg = serde_json::json!({ "type": mode, "url": url });
    std::fs::write(dir.join(CONFIG_FILE), cfg.to_string()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_server_config])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                startup_sequence(handle).await;
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Tauri application")
        .run(|app_handle, event| {
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } = &event
            {
                if label == "main" {
                    api.prevent_close();
                    let handle = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let is_remote = read_server_config(&handle)
                            .map(|c| c.mode == "remote")
                            .unwrap_or(false);

                        // Only tear down Docker for local installs
                        if !is_remote {
                            let _ = Command::new("docker")
                                .args(["compose", "down"])
                                .current_dir(PROJECT_DIR)
                                .status();
                        }

                        handle.exit(0);
                    });
                }
            }
        });
}

async fn startup_sequence(app: AppHandle) {
    emit_status(&app, "Initialising…");

    let config    = read_server_config(&app);
    let is_remote = config.as_ref().map(|c| c.mode == "remote").unwrap_or(false);

    let health_url: String = config
        .as_ref()
        .filter(|c| c.mode == "remote")
        .map(|c| format!("{}/health", c.url.trim_end_matches('/')))
        .unwrap_or_else(|| LOCAL_HEALTH_URL.to_string());

    if is_remote {
        emit_status(&app, &format!("Connecting to {}…", health_url.trim_end_matches("/health")));
    } else {
        // Local install — start Docker services
        emit_status(&app, "Starting Docker services…");
        match Command::new("docker")
            .args(["compose", "up", "-d"])
            .current_dir(PROJECT_DIR)
            .status()
        {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                app.dialog()
                    .message(
                        "Docker Desktop was not found.\n\n\
                         Please install Docker Desktop for Windows:\n\
                         https://www.docker.com/products/docker-desktop\n\n\
                         After installing, restart skAIler.",
                    )
                    .title("Docker Not Found")
                    .blocking_show();
                app.exit(1);
                return;
            }
            Err(e) => {
                // Non-fatal — containers may already be running.
                emit_status(&app, &format!("Warning: docker compose error: {e}"));
            }
            Ok(_) => {}
        }
    }

    // Poll health endpoint until ready or timeout
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .unwrap_or_default();

    let deadline =
        std::time::Instant::now() + std::time::Duration::from_secs(STARTUP_TIMEOUT_SECS);

    loop {
        if std::time::Instant::now() > deadline {
            if is_remote {
                // Emit a specific event so the frontend can show the reconnect UI
                let _ = app.emit("backend-unreachable", health_url.trim_end_matches("/health").to_string());
            } else {
                emit_status(&app, "Timeout waiting for backend. Check Docker logs.");
            }
            return;
        }

        match client.get(&health_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                emit_status(&app, "Ready.");
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                let _ = app.emit("backend-ready", ());
                return;
            }
            _ => {
                if is_remote {
                    emit_status(&app, "Waiting for remote server…");
                } else {
                    emit_status(&app, "Waiting for backend…");
                }
                tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS)).await;
            }
        }
    }
}

fn emit_status(app: &AppHandle, msg: &str) {
    let _ = app.emit("status-update", msg.to_string());
}
