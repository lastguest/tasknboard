fn main() {
    println!("cargo:rerun-if-env-changed=TASKNBOARD_GITHUB_CLIENT_ID");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "app_version",
            "check_for_updates",
            "open_external_url",
            "pick_folder",
            "workspace_command",
            "saved_server",
            "save_server",
        ]),
    ))
    .expect("failed to run the Tauri build script");
}
