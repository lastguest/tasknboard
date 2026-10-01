#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;
#[cfg(desktop)]
mod update;

use tauri::{AppHandle, Url};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    let url = Url::parse(&url).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only HTTP and HTTPS links can open externally.".into());
    }
    open_external(&app, &url)
}

/// Opens web links in the system browser. Other schemes are ignored.
fn open_external(app: &AppHandle, url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Ok(());
    }
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    desktop::run();
    #[cfg(mobile)]
    mobile::run();
}
