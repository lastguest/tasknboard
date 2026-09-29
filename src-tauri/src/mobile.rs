use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{
    webview::NewWindowResponse, AppHandle, Manager, State, Url, WebviewUrl, WebviewWindowBuilder,
};

/// WKWebView serves the bundled server setup page from the `tauri` scheme.
const SETUP_SCHEME: &str = "tauri";

/// Lets the remote interface return to the server setup page.
const SHELL_SCRIPT: &str = r#"Object.defineProperty(window, "tasknboardShell", {
  value: Object.freeze({
    changeServer() {
      location.assign("tauri://localhost/?change");
    },
  }),
});"#;

/// The saved workspace server. The webview may navigate only to this origin.
struct Server(Mutex<Option<Url>>);

fn server_file(app: &AppHandle) -> tauri::Result<PathBuf> {
    Ok(app.path().app_data_dir()?.join("server-url"))
}

/// Accepts only an HTTPS origin, because the service owns the root path.
fn parse_server(input: &str) -> Result<Url, String> {
    let url = Url::parse(input.trim())
        .map_err(|_| "Enter the full server address, for example https://tasks.example.com.")?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err("The server address must start with https://.".into());
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("Enter only the server address, without a path.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Do not put credentials in the server address.".into());
    }
    Ok(url)
}

#[tauri::command]
fn saved_server(server: State<'_, Server>) -> Option<String> {
    server.0.lock().unwrap().as_ref().map(Url::to_string)
}

#[tauri::command]
fn save_server(app: AppHandle, server: State<'_, Server>, url: String) -> Result<String, String> {
    let url = parse_server(&url)?;
    let file = server_file(&app).map_err(|error| error.to_string())?;
    if let Some(directory) = file.parent() {
        fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    }
    fs::write(&file, url.as_str())
        .map_err(|error| format!("Could not save the server: {error}"))?;
    *server.0.lock().unwrap() = Some(url.clone());
    Ok(url.to_string())
}

fn open_link(app: &AppHandle, url: &Url) {
    if let Err(error) = crate::open_external(app, url) {
        eprintln!("TasknBoard: Could not open {url}: {error}");
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![saved_server, save_server])
        .setup(|app| {
            let saved = fs::read_to_string(server_file(app.handle())?)
                .ok()
                .and_then(|value| parse_server(&value).ok());
            app.manage(Server(Mutex::new(saved)));
            let navigation_handle = app.handle().clone();
            let window_handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .initialization_script(SHELL_SCRIPT)
                .on_navigation(move |destination| {
                    let allowed = destination.scheme() == SETUP_SCHEME
                        || navigation_handle
                            .state::<Server>()
                            .0
                            .lock()
                            .unwrap()
                            .as_ref()
                            .is_some_and(|server| server.origin() == destination.origin());
                    if !allowed {
                        open_link(&navigation_handle, destination);
                    }
                    allowed
                })
                .on_new_window(move |url, _| {
                    open_link(&window_handle, &url);
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(|_, _| {}),
        Err(error) => {
            eprintln!("TasknBoard: Could not start: {error}");
            std::process::exit(1);
        }
    }
}
