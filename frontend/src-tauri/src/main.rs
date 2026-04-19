// Prevents a console window from appearing behind the app in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_dialog::DialogExt;

const PROJECT_DIR: &str = r"D:\localai-platform";
const HEALTH_URL: &str = "http://localhost:8000/health";
const POLL_INTERVAL_SECS: u64 = 2;
const STARTUP_TIMEOUT_SECS: u64 = 120;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
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
                        let _ = Command::new("docker")
                            .args(["compose", "down"])
                            .current_dir(PROJECT_DIR)
                            .status();
                        handle.exit(0);
                    });
                }
            }
        });
}

async fn startup_sequence(app: AppHandle) {
    emit_status(&app, "Initialising…");

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
                     After installing, restart LocalAI Platform.",
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

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .unwrap_or_default();

    let deadline =
        std::time::Instant::now() + std::time::Duration::from_secs(STARTUP_TIMEOUT_SECS);

    loop {
        if std::time::Instant::now() > deadline {
            emit_status(&app, "Timeout waiting for backend. Check Docker logs.");
            return;
        }

        match client.get(HEALTH_URL).send().await {
            Ok(resp) if resp.status().is_success() => {
                emit_status(&app, "Backend ready.");
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                let _ = app.emit("backend-ready", ());
                return;
            }
            _ => {
                emit_status(&app, "Waiting for backend…");
                tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS)).await;
            }
        }
    }
}

fn emit_status(app: &AppHandle, msg: &str) {
    let _ = app.emit("status-update", msg.to_string());
}
