fn main() {
    println!("cargo:rerun-if-env-changed=TASKNBOARD_GITHUB_CLIENT_ID");
    tauri_build::build();
}
