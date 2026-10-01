fn main() {
    println!("cargo:rerun-if-env-changed=TASKNBOARD_GITHUB_CLIENT_ID");
    // The desktop window loads the local service over http, a remote origin
    // for Tauri, so app commands must be granted by a capability.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "app_version",
            "check_for_updates",
            "open_external_url",
            "pick_folder",
            "saved_server",
            "save_server",
        ]),
    ))
    .expect("failed to run the Tauri build script");
}
