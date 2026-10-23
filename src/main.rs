// Hermes Agent — Tauri v2 entry point.
//
// The desktop shell attaches to a Hermes kernel (loopback dashboard or remote
// gateway), registers all IPC commands and opens the main window. For a
// loopback kernel it may also spawn and supervise one it owns via
// `bootstrap` → `kernel_managed`; a remote kernel is attach-only.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use hermes_agent_cn::bootstrap::{connect_backend, finalize_bootstrap, record_bootstrap_error};
use hermes_agent_cn::commands;
use hermes_agent_cn::commands::profiles::read_active_profile_sticky;
use hermes_agent_cn::connection;
use hermes_agent_cn::process::{data_dir, instance, ui_update};
use hermes_agent_cn::state::AppState;
use hermes_agent_cn::tray;

/// Stop the process-local relay on shutdown, and reap a kernel this desktop
/// spawned (never one it merely attached to).
fn shutdown_local_state(app: &tauri::AppHandle, reason: &str) {
    use tauri::Manager;

    hermes_agent_cn::kernel_managed::shutdown_owned_kernel();

    let state = app.state::<AppState>();
    let gateway_ws = match state.inner.lock() {
        Ok(mut inner) => inner.gateway_ws.take(),
        Err(err) => {
            log::warn!(
                "Failed to lock app state during {} shutdown: {}",
                reason,
                err
            );
            return;
        }
    };

    if let Some(relay) = gateway_ws {
        relay.abort.store(true, Ordering::Relaxed);
        relay.notify.notify_waiters();
    }
}

fn create_and_return(path: PathBuf) -> PathBuf {
    let _ = fs::create_dir_all(&path);
    path
}

fn resolve_hermes_home() -> PathBuf {
    if std::env::var_os("HERMES_DESKTOP_HERMES_HOME").is_some()
        || std::env::var_os("HERMES_HOME").is_some()
    {
        log::warn!("Ignoring external HERMES_HOME overrides; desktop keeps its own metadata home");
    }

    create_and_return(data_dir::hermes_home_dir())
}

fn profile_hermes_home(base: &Path, profile: &str) -> PathBuf {
    if profile == "default" {
        base.to_path_buf()
    } else {
        base.join("profiles").join(profile)
    }
}

/// Resolve the Vite dev-server URL when the desktop runs against it: the
/// explicit `HERMES_DESKTOP_DEV_URL` override wins, otherwise any debug build
/// (tauri dev / cargo run) assumes the standard 9545 dev server. `None` in
/// release builds — the window then loads the `hermesui:` scheme.
fn resolve_dev_url() -> Option<String> {
    if let Ok(url) = std::env::var("HERMES_DESKTOP_DEV_URL") {
        let trimmed = url.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    if cfg!(debug_assertions) {
        return Some("http://localhost:9545".to_string());
    }
    None
}

/// MIME type for a served `hermesui:` asset, keyed by extension. Vite emits a
/// known set (html/js/css + hashed images/fonts); anything unknown falls back
/// to octet-stream.
fn hermesui_content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or("") {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}

fn empty_hermesui_response(status: u16) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .body(Vec::new())
        .unwrap()
}

/// Build the response for a `hermesui:` request.
///
/// 1. DEV bypass: while the Vite dev server owns the window the handler is
///    dormant (HMR untouched) — nothing is served from the hot-update tree.
/// 2. When `ui/current.json` exists, `index.html` is on disk and the signed
///    `appVersionFloor` gate passes, serve from `ui/versions/<v>/` with
///    `index.html` `no-cache` and hashed assets immutable.
/// 3. Otherwise fall back to the embedded `frontendDist` — the window can
///    never brick, even after a bad package installs.
fn build_hermesui_response(
    app: &tauri::AppHandle,
    request_path: &str,
) -> tauri::http::Response<Vec<u8>> {
    if resolve_dev_url().is_some() {
        return empty_hermesui_response(404);
    }

    if let Some(version_dir) = ui_update::ui_serving_version_dir() {
        if let Some(asset_path) = ui_update::resolve_ui_asset(&version_dir, request_path) {
            match std::fs::read(&asset_path) {
                Ok(bytes) => {
                    let is_index = asset_path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.eq_ignore_ascii_case("index.html"));
                    let cache = if is_index {
                        "no-cache"
                    } else {
                        "public, max-age=31536000, immutable"
                    };
                    return tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", hermesui_content_type(&asset_path))
                        .header("Cache-Control", cache)
                        .body(bytes)
                        .unwrap_or_else(|_| empty_hermesui_response(500));
                }
                Err(_) => return empty_hermesui_response(404),
            }
        }
    }

    // Embedded frontendDist fallback (tauri:// scheme assets), so a clean
    // install / first launch / bad package still renders the app.
    let relative = request_path.trim_start_matches('/');
    let asset_key = if relative.is_empty() {
        "index.html".to_string()
    } else {
        relative.to_string()
    };
    if let Some(asset) = app.asset_resolver().get(asset_key) {
        let mut builder = tauri::http::Response::builder().status(200);
        builder = builder.header("Content-Type", asset.mime_type());
        if let Some(csp) = asset.csp_header() {
            builder = builder.header("Content-Security-Policy", csp);
        }
        return builder
            .body(asset.bytes)
            .unwrap_or_else(|_| empty_hermesui_response(500));
    }
    empty_hermesui_response(404)
}

/// stderr + `<data root>/desktop.log`. The packaged app has no console, so
/// without the file a degraded boot leaves no trace to diagnose afterwards.
struct LogTee(std::fs::File);

impl std::io::Write for LogTee {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = std::io::Write::write_all(&mut std::io::stderr(), buf);
        std::io::Write::write_all(&mut self.0, buf)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let _ = std::io::stderr().flush();
        self.0.flush()
    }
}

/// Install the logger. Keeps stderr (dev) and appends to `desktop.log` capped at
/// ~5 MB, so a support report can always answer "why did it degrade".
fn init_logging() {
    let path = data_dir::data_dir().join("desktop.log");
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > 5 * 1024 * 1024 {
            let _ = fs::remove_file(&path);
        }
    }
    let mut builder = env_logger::Builder::from_env(
        // The packaged app has no console: without a default level the file only
        // ever records errors and the boot trail (attach/spawn/degraded) is lost.
        env_logger::Env::default().default_filter_or("info"),
    );
    if let Ok(file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        builder.target(env_logger::Target::Pipe(Box::new(LogTee(file))));
    }
    let _ = builder.try_init();
}

fn main() {
    init_logging();

    // Windows: keep the WebView2 user-data folder (network cache, IndexedDB,
    // service workers, GPU cache — all of which grow over time) under the
    // desktop's data root instead of letting it default to
    // %LOCALAPPDATA%\cn.org.hermesagent.desktop\EBWebView. WebView2 honors
    // WEBVIEW2_USER_DATA_FOLDER; it must be set before the webview environment
    // is created, so do it first thing in main().
    #[cfg(windows)]
    {
        let webview_dir = data_dir::data_dir().join("webview2");
        let _ = fs::create_dir_all(&webview_dir);
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview_dir);
    }

    // Single-instance guard per data root: a second launch against the SAME
    // root focuses the incumbent window and exits. The guard lives on main's
    // stack so the lock is held until process exit.
    let _instance_guard = match instance::try_acquire() {
        instance::SingleInstance::Acquired(guard) => Some(guard),
        instance::SingleInstance::AlreadyRunning => {
            log::info!(
                "another desktop instance owns {}; requesting focus and exiting",
                data_dir::data_dir().display()
            );
            instance::notify_running_instance();
            return;
        }
        instance::SingleInstance::Unavailable(reason) => {
            // Fail open: the guard must never lock users out of their app.
            log::warn!("single-instance lock unavailable ({reason}); continuing");
            None
        }
    };

    let app_state = AppState::new();
    let quit_requested = Arc::new(AtomicBool::new(false));
    let close_quit_requested = Arc::clone(&quit_requested);
    let tray_available = Arc::new(AtomicBool::new(false));
    let setup_tray_available = Arc::clone(&tray_available);
    let close_tray_available = Arc::clone(&tray_available);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(app_state)
        // Track B UI hot update: serve the webview from the writable
        // `ui/versions/<v>/` tree (signed `appVersionFloor` gate + path-traversal
        // guard, embedded frontendDist fallback, dev bypass) so the React UI can
        // update without touching the shell binary.
        .register_asynchronous_uri_scheme_protocol("hermesui", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            tauri::async_runtime::spawn(async move {
                let response = build_hermesui_response(&app, &path);
                responder.respond(response);
            });
        })
        .setup(move |app| {
            use tauri::Manager;
            let state = app.state::<AppState>();

            // Create the main window: production loads the hot-updatable UI
            // through the `hermesui:` custom scheme; dev builds keep the Vite
            // dev server (http://localhost:9545) so HMR is unaffected.
            let window_url = match resolve_dev_url() {
                Some(dev_url) => {
                    tauri::WebviewUrl::External(dev_url.parse().expect("valid dev URL"))
                }
                None => tauri::WebviewUrl::CustomProtocol(
                    "hermesui://localhost/index.html"
                        .parse()
                        .expect("valid hermesui URL"),
                ),
            };
            let window_builder =
                tauri::WebviewWindowBuilder::new(app, tray::MAIN_WINDOW_LABEL, window_url)
                    .title("Hermes Agent")
                    .inner_size(1240.0, 820.0)
                    .min_inner_size(960.0, 680.0);
            #[cfg(target_os = "macos")]
            let window_builder = window_builder.title_bar_style(tauri::TitleBarStyle::Transparent);
            window_builder.build()?;

            // Focus channel for the single-instance guard: consume any stale
            // request from a previous run, then watch for new ones.
            instance::clear_stale_focus_request();
            instance::spawn_focus_watcher(app.handle().clone());

            match tray::install(app) {
                Ok(()) => {
                    setup_tray_available.store(true, Ordering::Relaxed);
                }
                Err(err) => {
                    log::warn!("Failed to install system tray: {}", err);
                }
            }

            log::info!("desktop data root: {}", data_dir::data_dir().display());

            // 1. Resolve the desktop's own metadata home
            let hermes_home_base = resolve_hermes_home();
            let base_str = hermes_home_base.to_string_lossy().to_string();

            // 2. Read sticky active profile
            let mut current_profile = read_active_profile_sticky(&base_str);
            let mut boot_home = profile_hermes_home(&hermes_home_base, &current_profile);

            if current_profile != "default" && !boot_home.exists() {
                log::warn!(
                    "active_profile points to missing {}; falling back to default",
                    current_profile
                );
                current_profile = "default".to_string();
                boot_home = hermes_home_base.clone();
                let _ = fs::remove_file(hermes_home_base.join("active_profile"));
            }

            let boot_home_str = boot_home.to_string_lossy().to_string();

            // 3. Seed AppState with the static fields the UI needs while it
            // waits; finalize_bootstrap fills in apiBaseUrl/gatewayUrl/token
            // once the kernel answers. The bridge waits on the
            // `runtime-status` "ready" event before mounting the React app.
            {
                let mut inner = state.inner.lock().unwrap();
                inner.hermes_home = boot_home_str.clone();
                inner.hermes_home_base = base_str.clone();
                inner.current_profile = current_profile.clone();
            }

            // 4. Resolve the external backend for this boot: env override →
            // connection.json. An env URL without a token is the one fatal
            // misconfiguration.
            let backend = match connection::resolve_connection_backend() {
                Ok(backend) => backend,
                Err(msg) => {
                    record_bootstrap_error(app.handle(), msg);
                    return Ok(());
                }
            };

            let app_handle = app.handle().clone();
            let profile_for_task = current_profile.clone();
            tauri::async_runtime::spawn(async move {
                let handle = connect_backend(&app_handle, &backend).await;
                let mode = backend.mode();
                finalize_bootstrap(
                    &app_handle,
                    handle,
                    boot_home_str,
                    base_str,
                    profile_for_task,
                    mode,
                )
                .await;
            });

            log::info!("Hermes Agent bootstrapping in background");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::gateway::get_runtime_config,
            commands::gateway::refresh_gateway_url,
            commands::gateway::get_backend_version,
            commands::fatal_error::fatal_error_and_exit,
            commands::connection::get_connection_config,
            commands::connection::save_connection_config,
            commands::connection::probe_connection_config,
            commands::connection::test_connection_config,
            commands::connection::apply_connection_config,
            commands::connection_auth::connection_oauth_login,
            commands::connection_auth::connection_password_login,
            commands::connection_auth::connection_auth_me,
            commands::connection_auth::connection_oauth_logout,
            commands::browser_companion::open_browser_companion,
            commands::im_onboarding::im_onboarding_state,
            commands::im_onboarding::im_onboarding_begin,
            commands::im_onboarding::im_onboarding_poll,
            commands::im_onboarding::im_onboarding_apply,
            commands::kernel::kernel_status,
            commands::kernel::retry_kernel,
            commands::file_dialogs::pick_files,
            commands::file_dialogs::pick_directory,
            commands::file_dialogs::create_workspace_project,
            commands::file_dialogs::open_workspace_path,
            commands::file_dialogs::open_external_url,
            commands::log_export::export_log_snapshot,
            commands::session_export::export_session_json,
            commands::debug_bundle::export_debug_bundle,
            commands::desktop_update::desktop_check_update,
            commands::app_update::app_update_check,
            commands::app_update::app_update_install,
            hermes_agent_cn::update_config::get_update_config,
            hermes_agent_cn::update_config::set_update_config,
            commands::devtools::toggle_devtools,
            commands::environment::environment_check,
            commands::coding_agents::coding_agents_check,
            commands::api_proxy::api_request,
            commands::api_proxy::external_request,
            commands::api_proxy::upload_file,
            commands::api_proxy::download_external_image,
            commands::runtime_manager::runtime_info,
            commands::runtime_manager::runtime_check_update,
            commands::runtime_manager::runtime_install_update,
            commands::runtime_manager::runtime_rollback,
            commands::runtime_manager::get_desktop_control_state,
            commands::runtime_manager::set_guide_state,
            commands::profiles::switch_profile,
            commands::memory::read_memory,
            commands::memory::add_memory_entry,
            commands::memory::update_memory_entry,
            commands::memory::remove_memory_entry,
            commands::memory::write_user_profile,
            commands::notify::desktop_notify,
            commands::ws_proxy::gateway_ws_open,
            commands::ws_proxy::gateway_ws_send,
            commands::ws_proxy::gateway_ws_close,
            commands::ui_store::ui_store_snapshot,
            commands::ui_store::ui_store_set_kv,
            commands::ui_store::ui_store_remove_kv,
            commands::ui_store::ui_store_record_turn_stats,
            commands::ui_store::ui_store_get_turn_stats,
            commands::ui_store::ui_store_get_turn_stats_window,
            commands::ui_store::ui_store_record_event,
            commands::terminal::terminal_start,
            commands::terminal::terminal_open_external,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::preview::read_file_data_url,
            commands::preview::read_workspace_file,
            commands::preview::write_workspace_file,
            commands::preview::watch_preview_file,
            commands::preview::stop_preview_file_watch,
            commands::git::git_review_list,
            commands::git::git_review_diff,
            commands::git::git_review_stage,
            commands::git::git_review_unstage,
            commands::git::git_review_revert,
            commands::git::git_review_rev_parse,
            commands::git::git_review_commit,
            commands::git::git_review_commit_context,
            commands::git::git_review_push,
            commands::git::git_review_ship_info,
            commands::git::git_review_create_pr,
            commands::git::git_worktree_list,
            commands::git::git_worktree_add,
            commands::git::git_worktree_remove,
            commands::git::git_branch_list,
            commands::git::git_branch_switch,
            commands::git::git_repo_status,
            commands::ui_update::ui_check_update,
            commands::ui_update::ui_install_update,
            commands::ui_update::ui_rollback,
            commands::secrets::secrets_status,
            commands::secrets::secrets_protect,
            commands::secrets::secrets_unprotect,
            commands::ssh_remote::ssh_config_text,
            commands::ssh_remote::ssh_probe,
            commands::ssh_remote::ssh_tunnel_open,
            commands::ssh_remote::ssh_tunnel_close,
            commands::ssh_remote::ssh_tunnel_list,
        ])
        .on_window_event(move |window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. }
                if window.label() == tray::MAIN_WINDOW_LABEL
                    && close_tray_available.load(Ordering::Relaxed)
                    && !close_quit_requested.load(Ordering::Relaxed) =>
            {
                api.prevent_close();
                tray::hide_main_window_to_tray(window);
            }
            tauri::WindowEvent::Destroyed if window.label() == tray::MAIN_WINDOW_LABEL => {
                log::info!("Main window destroyed");
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building Hermes Agent");

    app.run(move |app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => {
            quit_requested.store(true, Ordering::Relaxed);
        }
        tauri::RunEvent::Exit => {
            shutdown_local_state(app_handle, "app exit");
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            tray::show_main_window(app_handle);
        }
        _ => {}
    });
}
