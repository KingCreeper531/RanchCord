fn main() {
    // The Windows app connects to the same default server as the phone apps (client/.env.production).
    let env_file = std::path::Path::new("../../client/.env.production");
    println!("cargo:rerun-if-changed={}", env_file.display());
    let default_server = std::fs::read_to_string(env_file)
        .ok()
        .and_then(|text| {
            text.lines()
                .find_map(|line| line.trim().strip_prefix("VITE_DEFAULT_SERVER=").map(|v| v.trim().to_string()))
        })
        .unwrap_or_default();
    println!("cargo:rustc-env=RANCHCORD_DEFAULT_SERVER={default_server}");

    // Every app command gets an allow-<name> permission so remote pages only reach what we list.
    let commands = &[
        "get_server",
        "connect",
        "check_server",
        "change_server",
        "set_badge",
        "flash",
        "set_title_bar_colors",
        "notify",
        "set_open_at_login",
        "get_open_at_login",
    ];
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands)))
        .expect("failed to run tauri-build");
}
