use crate::service::{self, Paths};
use serde::Serialize;
use std::{path::PathBuf, time::Duration};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse},
    AppHandle, WebviewUrl, WebviewWindowBuilder,
};

pub(crate) fn show_error(message: &str) {
    eprintln!("TasknBoard: {message}");
    rfd::MessageDialog::new()
        .set_title("TasknBoard")
        .set_description(message)
        .set_level(rfd::MessageLevel::Error)
        .show();
}

/// Lets the board editor fill its repository folder from the native picker.
/// Resolves to None when the person cancels.
#[tauri::command]
async fn pick_folder(start: Option<String>) -> Option<String> {
    let mut dialog = rfd::AsyncFileDialog::new().set_title("Choose the repository folder");
    if let Some(start) = start.map(PathBuf::from).filter(|path| path.is_dir()) {
        dialog = dialog.set_directory(start);
    }
    let folder = dialog.pick_folder().await?;
    Some(
        dunce::simplified(folder.path())
            .to_string_lossy()
            .into_owned(),
    )
}

pub(crate) fn stop_service(_app: &AppHandle) -> Result<(), String> {
    let paths = crate::service::Paths::current().map_err(|error| error.to_string())?;
    crate::service::stop_managed(&paths).map_err(|error| error.to_string())
}

fn open_artifact(app: &AppHandle, url: &tauri::Url) {
    if let Err(error) = crate::open_external(app, url) {
        show_error(&format!("Could not open the artifact: {error}"));
    }
}

struct Workspace {
    paths: Paths,
    client: reqwest::Client,
    credential: String,
}

#[derive(Serialize)]
struct WorkspaceResponse {
    status: u16,
    text: String,
}

impl Workspace {
    fn new(paths: Paths, credential: String) -> Result<Self, reqwest::Error> {
        // The updater also uses ring. Set it before constructing the first client.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(2))
            .build()?;
        Ok(Self {
            paths,
            client,
            credential,
        })
    }

    async fn request(
        &self,
        name: &str,
        args: serde_json::Value,
    ) -> Result<WorkspaceResponse, String> {
        if name.is_empty()
            || name.len() > 64
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_' || byte == b'-')
        {
            return Err("Invalid workspace command.".into());
        }
        let runtime = service::read_runtime(&self.paths)
            .map_err(|_| "The workspace service is unavailable.")?;
        let address: tauri::Url = runtime
            .url
            .parse()
            .map_err(|_| "Invalid workspace address.")?;
        let port = address.port().ok_or("Invalid workspace port.")?;
        let timeout = if matches!(name, "service-connect" | "export-file" | "pick-folder") {
            130
        } else {
            15
        };
        let url = format!("http://127.0.0.1:{port}/api/{name}");
        let request = if matches!(name, "mcp-config" | "mcp-status") {
            self.client.get(url)
        } else {
            self.client.post(url).json(&args)
        };
        let response = request
            .bearer_auth(&self.credential)
            .timeout(Duration::from_secs(timeout))
            .send()
            .await
            .map_err(|_| {
                "The workspace request failed. Read the current state before retrying a write."
            })?;
        let status = response.status().as_u16();
        let text = response
            .text()
            .await
            .map_err(|_| "The workspace response was interrupted.")?;
        Ok(WorkspaceResponse { status, text })
    }
}

#[tauri::command]
async fn workspace_command(
    workspace: tauri::State<'_, Workspace>,
    name: String,
    args: serde_json::Value,
) -> Result<WorkspaceResponse, String> {
    workspace.request(&name, args).await
}

fn connect_workspace() -> Result<Workspace, Box<dyn std::error::Error>> {
    let paths = Paths::current()?;
    service::attach(&paths)?;
    Ok(Workspace::new(paths, service::credential()?)?)
}

pub fn run() {
    // Resolve service and credential failures before the macOS event loop starts.
    // Returning these errors from setup can panic in tao's native event callback.
    let workspace = match connect_workspace() {
        Ok(workspace) => workspace,
        Err(error) => {
            show_error(&format!(
                "Could not connect to the TasknBoard service: {error}"
            ));
            std::process::exit(1);
        }
    };
    let app = tauri::Builder::default()
        .manage(workspace)
        .invoke_handler(tauri::generate_handler![
            crate::update::app_version,
            crate::update::check_for_updates,
            crate::open_external_url,
            pick_folder,
            workspace_command
        ])
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let navigation_handle = app.handle().clone();
            let window_handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .initialization_script("window.tasknboardDesktop = true;")
                .title("TasknBoard")
                .inner_size(1440.0, 900.0)
                .min_inner_size(720.0, 520.0)
                .disable_drag_drop_handler()
                .on_navigation(move |destination| {
                    if matches!(
                        (destination.scheme(), destination.host_str()),
                        ("tauri", Some("localhost")) | ("http", Some("tauri.localhost"))
                    ) || destination.as_str().starts_with("blob:tauri://localhost/")
                        || destination
                            .as_str()
                            .starts_with("blob:http://tauri.localhost/")
                    {
                        true
                    } else {
                        // WKWebView checks navigation before its new-window callback.
                        open_artifact(&navigation_handle, destination);
                        false
                    }
                })
                .on_new_window(move |url, _| {
                    open_artifact(&window_handle, &url);
                    NewWindowResponse::Deny
                })
                .on_download(|_, event| match event {
                    DownloadEvent::Requested { destination, .. } => {
                        let filename = destination
                            .file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or("tasknboard-export.json");
                        if let Some(path) =
                            rfd::FileDialog::new().set_file_name(filename).save_file()
                        {
                            *destination = path;
                            true
                        } else {
                            false
                        }
                    }
                    DownloadEvent::Finished { success: false, .. } => {
                        show_error("The export could not be saved.");
                        true
                    }
                    _ => true,
                })
                .build()?;
            crate::update::watch(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(|_, _| {}),
        Err(error) => {
            show_error(&format!("Could not start TasknBoard: {error}"));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        thread,
        time::Instant,
    };

    #[test]
    fn workspace_requests_follow_the_resident_descriptor_after_an_outage() {
        let data = std::env::temp_dir().join(format!("tasknboard-ipc-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&data).unwrap();
        let runtime = data.join("runtime.json");
        let credential = "native-adapter-fixture";
        let workspace = Workspace::new(
            Paths {
                data: data.clone(),
                resources: data.clone(),
                executable: data.clone(),
                home: data.clone(),
            },
            credential.into(),
        )
        .unwrap();
        let request = || {
            tauri::async_runtime::block_on(
                workspace.request("workspace-revision", serde_json::json!({})),
            )
        };

        // Keep both listeners bound so the operating system cannot reuse the first port.
        let first = TcpListener::bind("127.0.0.1:0").unwrap();
        let second = TcpListener::bind("127.0.0.1:0").unwrap();
        for (listener, instance) in [(first, "before"), (second, "after")] {
            assert!(request().is_err());
            let url = format!("http://{}", listener.local_addr().unwrap());
            fs::write(
                &runtime,
                serde_json::to_vec(&serde_json::json!({
                    "url": url, "mcpUrl": format!("{url}/mcp"), "instanceId": instance, "pid": 1
                }))
                .unwrap(),
            )
            .unwrap();
            listener.set_nonblocking(true).unwrap();
            let response = thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(5);
                let (mut stream, _) = loop {
                    match listener.accept() {
                        Ok(connection) => break connection,
                        Err(err)
                            if err.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            thread::sleep(Duration::from_millis(10))
                        }
                        Err(err) => panic!("Fixture connection failed: {err}"),
                    }
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let headers: Vec<_> = BufReader::new(&stream)
                    .lines()
                    .map(Result::unwrap)
                    .take_while(|line| !line.is_empty())
                    .collect();
                assert_eq!(headers[0], "POST /api/workspace-revision HTTP/1.1");
                assert!(headers.iter().any(|line| {
                    line.eq_ignore_ascii_case(&format!("authorization: Bearer {credential}"))
                }));
                let body = serde_json::json!({ "instanceId": instance }).to_string();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            });
            let result = request().unwrap();
            response.join().unwrap();
            assert_eq!(result.status, 200);
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&result.text).unwrap()["instanceId"],
                instance
            );
            fs::remove_file(&runtime).unwrap();
        }
        fs::remove_dir(data).unwrap();
    }
}
