// Shared bootstrap pipeline: attach the desktop to an external Hermes kernel.
//
// Two backend shapes come out of here, both attach-only:
//   - local: a loopback Hermes Agent CLI dashboard (http://127.0.0.1:9119)
//   - remote: a Hermes Agent on another host
//
// Nothing here installs, spawns or supervises a kernel — the desktop only
// probes the URL, picks up its session token and publishes the address to the
// renderer.

use tauri::Emitter;

use crate::connection::{ConnectionBackend, ConnectionMode, RemoteBackend};
use crate::error::AppError;
use crate::process::dashboard;
use crate::state::{AppState, DashboardHandle};

/// Emit a "runtime-status" event for the frontend overlay to consume.
/// Phases (in order along the happy path):
///   "starting-dashboard" — probing the configured kernel
///   "ready" — bootstrap complete, frontend can mount the app
///   "error" — fatal; frontend should display message and offer retry
pub fn emit_runtime_status(app: &tauri::AppHandle, phase: &str, message: &str) {
    let _ = app.emit(
        "runtime-status",
        serde_json::json!({ "phase": phase, "message": message }),
    );
}

/// Record a fatal bootstrap error: log it, stash it in AppState for the UI to
/// read, and emit a "runtime-status" error event. Returns the message so
/// callers can write `return Err(record_bootstrap_error(...))`.
pub fn record_bootstrap_error(app: &tauri::AppHandle, message: String) -> String {
    use tauri::Manager;
    log::error!("{}", message);
    let state = app.state::<AppState>();
    if let Ok(mut inner) = state.inner.lock() {
        inner.last_runtime_error = Some(message.clone());
    }
    emit_runtime_status(app, "error", &message);
    message
}

/// Attach to the resolved backend. An unreachable kernel is deliberately NOT a
/// bootstrap error: an "error" runtime-status would stop the React app from
/// ever mounting, locking the user out of the Settings page where a bad saved
/// URL gets fixed. The gateway client's reconnect UI surfaces unreachability
/// once the app is up.
pub async fn connect_backend(
    app: &tauri::AppHandle,
    backend: &ConnectionBackend,
) -> DashboardHandle {
    match backend {
        ConnectionBackend::Local(local) => connect_local_backend(app, &local.base_url).await,
        ConnectionBackend::Remote(remote) => connect_remote_backend(app, remote).await,
    }
}

/// Attach to a loopback Hermes Agent CLI dashboard: probe it and pick up the
/// session token it serves.
pub async fn connect_local_backend(app: &tauri::AppHandle, base_url: &str) -> DashboardHandle {
    emit_runtime_status(app, "starting-dashboard", "正在连接本机 Hermes Agent...");
    log::info!("Local connection: attaching to {}", base_url);
    if !dashboard::probe_attached_dashboard(base_url).await {
        log::warn!(
            "Local Hermes Agent dashboard not reachable at {} during bootstrap; continuing — \
             Settings → 连接 can fix the URL, or start the kernel with `hermes dashboard`",
            base_url
        );
    }
    let token = dashboard::fetch_session_token(base_url).await;
    if token.is_none() {
        log::warn!(
            "Local Hermes Agent dashboard at {} did not expose a session token",
            base_url
        );
    }
    DashboardHandle::local(base_url.to_string(), token)
}

/// Attach to a remote Hermes Agent: no spawn, no ownership — just a
/// reachability probe and an attach-only handle.
pub async fn connect_remote_backend(
    app: &tauri::AppHandle,
    remote: &RemoteBackend,
) -> DashboardHandle {
    emit_runtime_status(app, "starting-dashboard", "正在连接远程 Hermes Agent...");
    log::info!(
        "Remote mode ({}): attaching to {}",
        remote.source.as_str(),
        remote.base_url
    );
    if !dashboard::probe_dashboard(&remote.base_url).await {
        log::warn!(
            "Remote Hermes Agent not reachable at {} during bootstrap; continuing — \
             the gateway client retries and Settings → 连接 can fix the URL",
            remote.base_url
        );
    }
    match &remote.auth {
        // OAuth: seed the session registry from persisted cookies so REST/WS
        // work immediately, then verify liveness in the background — a dead
        // session only pops the re-login banner, never blocks boot.
        crate::connection::RemoteAuth::Oauth(cookies) => {
            if let Ok(session) = crate::oauth_session::session_for(&remote.base_url) {
                session.import_cookies(cookies);
                let app_bg = app.clone();
                let base = remote.base_url.clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(s) = crate::oauth_session::session_for(&base) {
                        if let Err(AppError::AuthSessionExpired(_)) = s.mint_ws_ticket().await {
                            emit_auth_expired(&app_bg, &base);
                        }
                    }
                });
            }
            DashboardHandle::remote_oauth(remote.base_url.clone())
        }
        crate::connection::RemoteAuth::Token(token) => {
            DashboardHandle::remote(remote.base_url.clone(), token.clone())
        }
    }
}

/// Emit the re-login banner event from bootstrap's background verify.
fn emit_auth_expired(app: &tauri::AppHandle, base_url: &str) {
    let _ = app.emit(
        "connection-auth-expired",
        serde_json::json!({ "baseUrl": base_url, "reason": "session_expired", "loginUrl": null }),
    );
}

/// Finish bootstrap once a handle is available: fetch the session token, build
/// the gateway URL, populate AppState, and emit the "ready" event the frontend
/// waits on.
pub async fn finalize_bootstrap(
    app: &tauri::AppHandle,
    handle: DashboardHandle,
    hermes_home: String,
    hermes_home_base: String,
    profile: String,
    mode: ConnectionMode,
) {
    use tauri::Manager;

    // An OAuth remote authenticates via the cookie session, not a token — the
    // registry already holds it (seeded in connect_remote_backend).
    let oauth_session = if handle.oauth {
        matches!(
            crate::connection::read_config().auth_mode,
            crate::connection::RemoteAuthMode::Oauth
        )
        .then(|| crate::oauth_session::session_for(&handle.api_base_url).ok())
        .flatten()
    } else {
        None
    };

    let session_token = if oauth_session.is_some() {
        None
    } else {
        match handle.session_token.clone() {
            Some(token) => Some(token),
            // Remote token handles carry their token; this scrape fallback is
            // only for loopback dashboards that hand out a fresh token.
            None => match std::env::var("HERMES_DESKTOP_SESSION_TOKEN")
                .ok()
                .or_else(|| std::env::var("HERMES_DASHBOARD_SESSION_TOKEN").ok())
            {
                Some(token) => Some(token),
                None => dashboard::fetch_session_token(&handle.api_base_url).await,
            },
        }
    };
    // OAuth gateway URL carries no token; the relay mints a ticket per connect.
    let gateway_url = dashboard::build_gateway_url(&handle.api_base_url, session_token.as_deref());

    // A loopback kernel owns its HERMES_HOME; ask it so profile/session views
    // point at the real tree instead of the desktop's own home.
    let (effective_home, effective_home_base, effective_profile) = if !mode.is_remote() {
        match dashboard::fetch_attached_dashboard_hermes_home(&handle.api_base_url)
            .await
            .filter(|h| !h.trim().is_empty())
        {
            Some(home) => (home.clone(), home, "default".to_string()),
            None => {
                log::warn!(
                    "Local dashboard at {} did not return hermes_home; keeping bootstrap home until Settings reconnect succeeds",
                    handle.api_base_url
                );
                (hermes_home, hermes_home_base, "default".to_string())
            }
        }
    } else {
        (hermes_home, hermes_home_base, profile)
    };

    {
        let state = app.state::<AppState>();
        let mut inner = state.inner.lock().unwrap();
        inner.api_base_url = handle.api_base_url.clone();
        inner.gateway_url = gateway_url;
        inner.hermes_home = effective_home;
        inner.hermes_home_base = effective_home_base;
        inner.session_token = session_token;
        inner.current_profile = effective_profile;
        inner.connection_mode = mode;
        inner.oauth_session = oauth_session;
        inner.dashboard_handle = Some(handle);
    }

    emit_runtime_status(app, "ready", "");
    log::info!("Hermes Agent ready");
}
