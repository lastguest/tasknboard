use std::{thread, time::Duration};
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const INSTALL: &str = "Install and Restart";

/// Checks the release feed at launch and once a day. Development builds do not check.
pub fn watch(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    thread::spawn(move || loop {
        match tauri::async_runtime::block_on(check(&app)) {
            Ok(Some(update)) if confirm(&update) => install(&app, &update),
            Ok(_) => {}
            // Offline use is supported, so a failed check is not shown to the user.
            Err(error) => eprintln!("TasknBoard: update check failed: {error}"),
        }
        thread::sleep(CHECK_INTERVAL);
    });
}

async fn check(app: &AppHandle) -> tauri_plugin_updater::Result<Option<Update>> {
    app.updater()?.check().await
}

fn confirm(update: &Update) -> bool {
    let answer = rfd::MessageDialog::new()
        .set_title("TasknBoard update")
        .set_description(format!(
            "TasknBoard {} is available. You have {}.\n\nTasknBoard restarts to install the update.",
            update.version, update.current_version
        ))
        .set_level(rfd::MessageLevel::Info)
        .set_buttons(rfd::MessageButtons::OkCancelCustom(INSTALL.into(), "Later".into()))
        .show();
    matches!(answer, rfd::MessageDialogResult::Ok)
        || matches!(answer, rfd::MessageDialogResult::Custom(label) if label == INSTALL)
}

/// The update is signed and verified before install. The service stops first
/// because the Windows installer replaces the bundled Node runtime.
fn install(app: &AppHandle, update: &Update) {
    let bytes = match tauri::async_runtime::block_on(update.download(|_, _| {}, || {})) {
        Ok(bytes) => bytes,
        Err(error) => {
            crate::desktop::show_error(&format!("The update could not be downloaded: {error}"));
            return;
        }
    };
    crate::desktop::stop_service(app);
    // On Windows, a successful install starts the installer and exits this process.
    if let Err(error) = update.install(bytes) {
        crate::desktop::show_error(&format!("The update could not be installed: {error}"));
    }
    // The restart also starts the service again if the install failed.
    app.restart();
}
