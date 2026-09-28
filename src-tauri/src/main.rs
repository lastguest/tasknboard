#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse},
    Manager, WebviewUrl, WebviewWindowBuilder,
};

#[derive(serde::Deserialize)]
struct Ready {
    url: String,
}

struct Service(Arc<Mutex<Option<Child>>>);

impl Service {
    fn stop(&self) {
        let Some(mut child) = self.0.lock().unwrap().take() else {
            return;
        };
        // EOF also stops the service if this host crashes or is forcibly killed.
        drop(child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
            }
        }
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        self.stop();
    }
}

fn start_service(app: &tauri::App) -> Result<(Service, tauri::Url), Box<dyn std::error::Error>> {
    let resources = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
    } else {
        app.path().resource_dir()?.join("resources")
    };
    let data = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data)?;
    let mut child = Command::new(resources.join("node"))
        .arg(resources.join("server.mjs"))
        .current_dir(&data)
        .env_clear()
        .env("HOST", "127.0.0.1")
        .env("PORT", "0")
        .env("TASKNBOARD_DESKTOP", "1")
        .env("TASKNBOARD_DB", data.join("tasknboard.sqlite"))
        .env("TASKNBOARD_STATIC_DIR", resources.join("dist"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child.stdout.take().ok_or("Service stdout is unavailable")?;
    let stderr = child.stderr.take().ok_or("Service stderr is unavailable")?;
    let service = Service(Arc::new(Mutex::new(Some(child))));
    let diagnostics = Arc::new(Mutex::new(String::new()));
    let captured = Arc::clone(&diagnostics);
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("{line}");
            let mut log = captured.lock().unwrap();
            if log.len() < 16_384 {
                log.push_str(&format!("{line}\n"));
            }
        }
    });
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut lines = BufReader::new(stdout).lines();
        let _ = sender.send(lines.next().transpose());
        for line in lines.map_while(Result::ok) {
            eprintln!("{line}");
        }
    });
    let line = receiver
        .recv_timeout(Duration::from_secs(15))?
        .map_err(|error| format!("Could not read service readiness: {error}"))?
        .ok_or_else(|| {
            format!(
                "Workspace service exited during startup. {}",
                diagnostics.lock().unwrap()
            )
        })?;
    let ready: Ready = serde_json::from_str(&line)?;
    let url: tauri::Url = ready.url.parse()?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none() {
        return Err("Workspace service reported an invalid address".into());
    }
    Ok((service, url))
}

fn show_error(message: &str) {
    eprintln!("TasknBoard: {message}");
    rfd::MessageDialog::new()
        .set_title("TasknBoard")
        .set_description(message)
        .set_level(rfd::MessageLevel::Error)
        .show();
}

fn open_artifact(url: &tauri::Url) {
    if matches!(url.scheme(), "http" | "https") {
        if let Err(error) = open::that_detached(url.as_str()) {
            show_error(&format!("Could not open the artifact: {error}"));
        }
    }
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let (service, url) = start_service(app)?;
            let origin = url.origin();
            let blob_prefix = format!("blob:{}/", url.origin().ascii_serialization());
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("TasknBoard")
                .inner_size(1440.0, 900.0)
                .min_inner_size(720.0, 520.0)
                .disable_drag_drop_handler()
                .on_navigation(move |destination| {
                    if destination.origin() == origin || destination.as_str().starts_with(&blob_prefix) {
                        true
                    } else {
                        // WKWebView checks navigation before its new-window callback.
                        open_artifact(destination);
                        false
                    }
                })
                .on_new_window(|url, _| {
                    open_artifact(&url);
                    NewWindowResponse::Deny
                })
                .on_download(|_, event| {
                    match event {
                        DownloadEvent::Requested { destination, .. } => {
                            let filename = destination.file_name().and_then(|name| name.to_str()).unwrap_or("tasknboard-export.json");
                            if let Some(path) = rfd::FileDialog::new().set_file_name(filename).save_file() {
                                *destination = path;
                                true
                            } else { false }
                        }
                        DownloadEvent::Finished { success: false, .. } => {
                            show_error("The export could not be saved.");
                            true
                        }
                        _ => true,
                    }
                })
                .build()?;
            let child = Arc::clone(&service.0);
            app.manage(service);
            let handle = app.handle().clone();
            thread::spawn(move || loop {
                thread::sleep(Duration::from_millis(500));
                let ended = {
                    let mut guard = child.lock().unwrap();
                    let Some(process) = guard.as_mut() else { return };
                    match process.try_wait() {
                        Ok(Some(status)) => Some(format!("The workspace service stopped ({status}). Restart TasknBoard to reconnect.")),
                        Err(error) => Some(format!("Could not monitor the workspace service: {error}")),
                        Ok(None) => None,
                    }
                };
                if let Some(message) = ended {
                    show_error(&message);
                    handle.exit(1);
                    return;
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(service) = handle.try_state::<Service>() {
                    service.stop();
                }
            }
        }),
        Err(error) => {
            show_error(&format!("Could not start TasknBoard: {error}"));
            std::process::exit(1);
        }
    }
}
