fn main() {
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
