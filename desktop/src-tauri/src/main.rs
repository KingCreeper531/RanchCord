//! RanchCord for Windows, built on Tauri (Rust + the WebView2 that ships with Windows).
//!
//! The window first shows a small bundled page that remembers which RanchCord server to use, then
//! loads that server's web app. Updating the server updates everyone's app; this shell only adds
//! what a browser tab can't do: tray icon, unread badge, Windows notifications, start with Windows,
//! auto-updates, and mic/camera/screen access without permission prompts.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashSet,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    ipc::CapabilityBuilder,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::{NewWindowResponse, PageLoadEvent},
    window::Color,
    AppHandle, Manager, Theme, Url, UserAttentionType, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_window_state::StateFlags;

const MAIN: &str = "main";
#[cfg(windows)]
const APP_ID: &str = "com.ranchcord.app";
/// Tauri serves the app's own files (the launcher) from this address on Windows.
const LAUNCHER_URL: &str = "http://tauri.localhost/index.html";
const BRIDGE: &str = include_str!("bridge.js");
const BADGE_PNG: &[u8] = include_bytes!("../icons/badge.png");
const TRAY_PNG: &[u8] = include_bytes!("../icons/tray.png");

/// Commands the server's web app may call (the launcher additionally gets connect/check).
const SERVER_PERMISSIONS: &[&str] = &[
    "allow-get-server",
    "allow-change-server",
    "allow-set-badge",
    "allow-flash",
    "allow-set-title-bar-colors",
    "allow-notify",
    "allow-set-open-at-login",
    "allow-get-open-at-login",
];

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    server_url: String,
}

struct AppState {
    settings: Mutex<Settings>,
    /// The http:// server WebView2 was told to treat as secure at launch (needed for mic/camera).
    insecure_origin: Option<String>,
    remote_allowed: Mutex<HashSet<String>>,
    quitting: AtomicBool,
    /// Set once the window has been shown (or was started hidden in the tray).
    shown: AtomicBool,
}

/* ---------------- settings ---------------- */

fn settings_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_file(app)
        .and_then(|f| fs::read_to_string(f).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: &Settings) {
    if let Some(file) = settings_file(app) {
        if let Some(dir) = file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(file, serde_json::to_string_pretty(settings).unwrap_or_default());
    }
}

/* ---------------- server addresses ---------------- */

fn is_private_host(host: &str) -> bool {
    if host == "localhost" || host.ends_with(".local") || host.starts_with("127.") || host.starts_with("10.") || host.starts_with("192.168.") {
        return true;
    }
    if let Some(rest) = host.strip_prefix("172.") {
        if let Some(Ok(n)) = rest.split('.').next().map(str::parse::<u8>) {
            return (16..=31).contains(&n);
        }
    }
    false
}

/// "ranch.example.com" -> https://ranch.example.com, "192.168.1.5:6420" -> http://192.168.1.5:6420
fn normalize_url(input: &str) -> Option<Url> {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        let host = trimmed.split(['/', ':']).next().unwrap_or_default();
        format!("{}://{}", if is_private_host(host) { "http" } else { "https" }, trimmed)
    };
    let url = Url::parse(&with_scheme).ok()?;
    (matches!(url.scheme(), "http" | "https") && url.host_str().is_some()).then_some(url)
}

fn origin_of(url: &Url) -> String {
    url.origin().ascii_serialization()
}

fn is_loopback(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
}

fn base_url(url: &Url) -> String {
    url.as_str().trim_end_matches('/').to_string()
}

/// Makes sure there's a RanchCord server at `url` and returns its name.
async fn probe(url: &Url) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(format!("{}/api/instance", base_url(url)))
        .send()
        .await
        .map_err(|_| format!("Couldn't reach {}. Is the server running?", base_url(url)))?;
    if !res.status().is_success() {
        return Err("Couldn't find a RanchCord server at that address.".into());
    }
    let json: serde_json::Value = res.json().await.map_err(|_| "That address isn't a RanchCord server.".to_string())?;
    json.get("name")
        .and_then(|n| n.as_str())
        .map(str::to_string)
        .ok_or_else(|| "That address isn't a RanchCord server.".into())
}

/// Lets the server's pages (and only them) call this app's commands.
fn allow_remote(app: &AppHandle, origin: &str) {
    let state = app.state::<AppState>();
    let mut allowed = state.remote_allowed.lock().unwrap();
    if !allowed.insert(origin.to_string()) {
        return;
    }
    let mut capability = CapabilityBuilder::new(format!("server-{}", allowed.len()))
        .remote(format!("{origin}/*"))
        .window(MAIN);
    for permission in SERVER_PERMISSIONS {
        capability = capability.permission(*permission);
    }
    if let Err(err) = app.add_capability(capability) {
        eprintln!("couldn't allow {origin}: {err}");
    }
}

fn is_allowed_page(app: &AppHandle, url: &Url) -> bool {
    if url.host_str() == Some("tauri.localhost") || matches!(url.scheme(), "tauri" | "about" | "data" | "blob") {
        return true;
    }
    let server = app.state::<AppState>().settings.lock().unwrap().server_url.clone();
    Url::parse(&server).map(|s| s.origin() == url.origin()).unwrap_or(false)
}

fn open_outside(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

/* ---------------- window helpers ---------------- */

fn show_window(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        show_window(&window);
    }
}

fn open_launcher(window: &WebviewWindow) {
    if let Ok(url) = Url::parse(&format!("{LAUNCHER_URL}?change=1")) {
        let _ = window.navigate(url);
    }
}

fn parse_hex(color: &str) -> Option<(u8, u8, u8)> {
    let hex = color.trim().trim_start_matches('#');
    if hex.len() != 6 {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
    Some((byte(0)?, byte(2)?, byte(4)?))
}

/// Paints Windows 11's title bar in the app's colours (Windows 10 just gets light/dark).
#[cfg(windows)]
fn paint_title_bar(window: &WebviewWindow, background: (u8, u8, u8), text: (u8, u8, u8)) {
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR};
    let Ok(hwnd) = window.hwnd() else { return };
    let colorref = |(r, g, b): (u8, u8, u8)| u32::from(r) | (u32::from(g) << 8) | (u32::from(b) << 16);
    let (bg, fg) = (colorref(background), colorref(text));
    unsafe {
        let _ = DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR, &bg as *const u32 as *const _, 4);
        let _ = DwmSetWindowAttribute(hwnd, DWMWA_TEXT_COLOR, &fg as *const u32 as *const _, 4);
    }
}

/// Mic, camera and notifications are allowed without WebView2's permission pop-ups.
#[cfg(windows)]
fn auto_allow_permissions(window: &WebviewWindow) {
    let _ = window.with_webview(|webview| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ,
            COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        };
        use webview2_com::PermissionRequestedEventHandler;
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                if [
                    COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                    COREWEBVIEW2_PERMISSION_KIND_CAMERA,
                    COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
                    COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ,
                ]
                .contains(&kind)
                {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_PermissionRequested(&handler, &mut token);
    });
}

/* ---------------- commands ---------------- */

#[tauri::command]
fn get_server(state: tauri::State<'_, AppState>) -> Option<String> {
    let settings = state.settings.lock().unwrap();
    (!settings.server_url.is_empty()).then(|| settings.server_url.clone())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Connected {
    url: String,
    name: String,
    restarting: bool,
}

#[tauri::command]
async fn connect(app: AppHandle, input: String) -> Result<Connected, String> {
    let url = normalize_url(&input).ok_or("Type your server address first.")?;
    let name = probe(&url).await?;
    let state = app.state::<AppState>();
    let address = base_url(&url);
    {
        let mut settings = state.settings.lock().unwrap();
        settings.server_url = address.clone();
        save_settings(&app, &settings);
    }
    let origin = origin_of(&url);
    // Plain http on another computer: WebView2 has to restart with that address marked as secure.
    let restarting = url.scheme() == "http" && !is_loopback(&url) && state.insecure_origin.as_deref() != Some(origin.as_str());
    if restarting {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            app.restart();
        });
    } else {
        allow_remote(&app, &origin);
    }
    Ok(Connected { url: address, name, restarting })
}

#[tauri::command]
async fn check_server(url: String) -> Result<String, String> {
    let url = normalize_url(&url).ok_or("That isn't a server address.")?;
    probe(&url).await
}

#[tauri::command]
fn change_server(window: WebviewWindow) {
    open_launcher(&window);
}

#[tauri::command]
fn set_badge(app: AppHandle, window: WebviewWindow, count: u32) {
    let badge = if count > 0 { Image::from_bytes(BADGE_PNG).ok() } else { None };
    let _ = window.set_overlay_icon(badge);
    if let Some(tray) = app.tray_by_id("main") {
        let tip = if count > 0 { format!("RanchCord ({count} unread)") } else { "RanchCord".to_string() };
        let _ = tray.set_tooltip(Some(tip));
    }
    if count > 0 && !window.is_focused().unwrap_or(true) {
        let _ = window.request_user_attention(Some(UserAttentionType::Informational));
    }
}

#[tauri::command]
fn flash(window: WebviewWindow) {
    if !window.is_focused().unwrap_or(true) {
        let _ = window.request_user_attention(Some(UserAttentionType::Informational));
    }
}

#[tauri::command]
fn set_title_bar_colors(window: WebviewWindow, background: String, text: String) {
    let Some(bg) = parse_hex(&background) else { return };
    let light = (u32::from(bg.0) * 299 + u32::from(bg.1) * 587 + u32::from(bg.2) * 114) / 1000 > 140;
    let _ = window.set_theme(Some(if light { Theme::Light } else { Theme::Dark }));
    let _ = window.set_background_color(Some(Color(bg.0, bg.1, bg.2, 255)));
    #[cfg(windows)]
    if let Some(fg) = parse_hex(&text) {
        paint_title_bar(&window, bg, fg);
    }
}

#[tauri::command]
fn notify(app: AppHandle, id: String, title: String, body: String) {
    #[cfg(windows)]
    {
        use tauri_winrt_notification::Toast;
        // Unpackaged dev builds borrow PowerShell's id; the installer registers ours.
        let app_id = if cfg!(debug_assertions) { Toast::POWERSHELL_APP_ID } else { APP_ID };
        let handle = app.clone();
        let result = Toast::new(app_id)
            .title(&title)
            .text1(&body)
            .sound(None)
            .on_activated(move |_| {
                if let Some(window) = handle.get_webview_window(MAIN) {
                    show_window(&window);
                    let id = serde_json::to_string(&id).unwrap_or_default();
                    let _ = window.eval(format!("window.__ranchNotificationClick && window.__ranchNotificationClick({id})"));
                }
                Ok(())
            })
            .show();
        if let Err(err) = result {
            eprintln!("notification failed: {err}");
        }
    }
    #[cfg(not(windows))]
    let _ = (app, id, title, body);
}

#[tauri::command]
fn set_open_at_login(app: AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    if enabled { launcher.enable() } else { launcher.disable() }.map_err(|e| e.to_string())
}

#[tauri::command]
fn get_open_at_login(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/* ---------------- setup ---------------- */

fn create_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let state = app.state::<AppState>();
    // Calls keep running smoothly in the background, and sounds play without a click first.
    let mut args = String::from(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required \
         --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows",
    );
    if let Some(origin) = &state.insecure_origin {
        args.push_str(&format!(" --unsafely-treat-insecure-origin-as-secure={origin}"));
    }
    let bridge = BRIDGE
        .replace("__VERSION__", &app.package_info().version.to_string())
        .replace("__DEFAULT_SERVER__", env!("RANCHCORD_DEFAULT_SERVER"));
    let nav_app = app.clone();
    let popup_app = app.clone();
    let load_app = app.clone();
    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("RanchCord")
        .inner_size(1280.0, 800.0)
        .min_inner_size(940.0, 560.0)
        .center()
        .visible(false)
        .theme(Some(Theme::Dark))
        .background_color(Color(0x0f, 0x11, 0x0f, 0xff))
        .additional_browser_args(&args)
        .initialization_script(bridge)
        .on_navigation(move |url| {
            let ok = is_allowed_page(&nav_app, url);
            if !ok {
                open_outside(&nav_app, url);
            }
            ok
        })
        .on_new_window(move |url, _| {
            open_outside(&popup_app, &url);
            NewWindowResponse::Deny
        })
        .on_page_load(move |window, payload| {
            if payload.event() == PageLoadEvent::Finished && !load_app.state::<AppState>().shown.swap(true, Ordering::SeqCst) {
                show_window(&window);
            }
        })
        .build()?;
    #[cfg(windows)]
    auto_allow_permissions(&window);
    Ok(window)
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open RanchCord", true, None::<&str>)?;
    let switch = MenuItem::with_id(app, "switch", "Switch server", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit RanchCord", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &switch, &PredefinedMenuItem::separator(app)?, &quit])?;
    TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(TRAY_PNG)?)
        .tooltip("RanchCord")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "switch" => {
                if let Some(window) = app.get_webview_window(MAIN) {
                    show_window(&window);
                    open_launcher(&window);
                }
            }
            "quit" => {
                app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Checks GitHub for a new version at startup, then every few hours while the app sits in the tray.
fn spawn_update_checks(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut first = true;
        loop {
            let in_tray = app.get_webview_window(MAIN).and_then(|w| w.is_visible().ok()).map(|v| !v).unwrap_or(false);
            if first || in_tray {
                if let Ok(updater) = app.updater() {
                    if let Ok(Some(update)) = updater.check().await {
                        // The installer closes the app, updates it and opens it again.
                        if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
                            app.restart();
                        }
                    }
                }
            }
            first = false;
            tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
        }
    });
}

fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    #[cfg(windows)]
    unsafe {
        // Groups the taskbar button and notifications under RanchCord.
        let _ = windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(windows::core::w!("com.ranchcord.app"));
    }
    let start_hidden = std::env::args().any(|a| a == "--hidden");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_server,
            connect,
            check_server,
            change_server,
            set_badge,
            flash,
            set_title_bar_colors,
            notify,
            set_open_at_login,
            get_open_at_login,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let settings = load_settings(&handle);
            let server = Url::parse(&settings.server_url).ok();
            let insecure_origin = server.as_ref().filter(|u| u.scheme() == "http" && !is_loopback(u)).map(origin_of);
            app.manage(AppState {
                settings: Mutex::new(settings),
                insecure_origin,
                remote_allowed: Mutex::new(HashSet::new()),
                quitting: AtomicBool::new(false),
                shown: AtomicBool::new(start_hidden),
            });
            if let Some(url) = &server {
                allow_remote(&handle, &origin_of(url));
            }
            create_main_window(&handle)?;
            create_tray(&handle)?;
            spawn_update_checks(&handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps RanchCord in the tray so calls and notifications keep working.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !window.app_handle().state::<AppState>().quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("RanchCord failed to start");
}
