// Shared bootstrap pipeline: attach the desktop to a Hermes kernel.
//
// Two backend shapes come out of here:
//   - local: a loopback Hermes Agent CLI dashboard (spawned+supervised when no
//     live one is found, otherwise attached to)
//   - remote: a Hermes Agent on another host, attach-only
//
// A spawned loopback kernel reports itself ready via a marker line; bootstrap
// waits for it, picks up the session token and publishes the address to the
// renderer. Nothing here installs a kernel.

use tauri::Emitter;

use crate::connection::{ConnectionBackend, ConnectionMode, RemoteBackend};
use crate::error::AppError;
use crate::kernel_managed::{self, KernelStatus};
use crate::process::dashboard;
use crate::process::data_dir;
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

/// Record a non-fatal degradation: log it, mark the state degraded, and emit a
/// "degraded" runtime-status. Unlike `record_bootstrap_error` this does not
/// block the renderer from mounting — the app comes up with
/// `backendReady: false` so the UI can surface the failure and offer retry.
/// The reason travels on `KernelStatus::degraded` (`lastError`) and on the
/// "degraded" event, never on `last_runtime_error`: that field is reserved for
/// fatal bootstrap errors, because the renderer's ready-poll treats any
/// `lastError` there as "boot failed" and refuses to mount.
pub fn record_runtime_degraded(app: &tauri::AppHandle, message: String) -> String {
    use tauri::Manager;
    log::error!("{}", message);
    let state = app.state::<AppState>();
    if let Ok(mut inner) = state.inner.lock() {
        inner.backend_degraded = true;
    }
    emit_runtime_status(app, "degraded", &message);
    message
}

/// Clear the degraded markers once a kernel attach/spawn/switch actually
/// succeeded, so `backendReady` can go back to true and the UI stops showing
/// the degraded badge with a stale error.
pub fn clear_runtime_degraded(app: &tauri::AppHandle) {
    use tauri::Manager;
    let state = app.state::<AppState>();
    if let Ok(mut inner) = state.inner.lock() {
        inner.backend_degraded = false;
        inner.last_runtime_error = None;
    }
    drop(state);
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
        ConnectionBackend::Local(local) => connect_managed_local_backend(app, &local.base_url).await,
        ConnectionBackend::Remote(remote) => {
            kernel_managed::set_kernel_status(KernelStatus::remote(&remote.base_url));
            clear_runtime_degraded(app);
            connect_remote_backend(app, remote).await
        }
    }
}

fn kernel_log_dir() -> std::path::PathBuf {
    data_dir::data_dir().join("kernel-logs")
}

/// Loopback kernel: hand lifecycle to `kernel_managed` (attach to a live
/// backend, otherwise spawn one we own), then reuse the plain local attach
/// path with whichever URL came back.
pub async fn connect_managed_local_backend(
    app: &tauri::AppHandle,
    fallback_url: &str,
) -> DashboardHandle {
    emit_runtime_status(app, "starting-dashboard", "正在准备本机 Hermes Agent...");
    match kernel_managed::ensure_kernel(None, &kernel_log_dir()).await {
        Ok((kernel, ownership)) => {
            log::info!(
                "Local kernel {} at {} (pid {:?}, owned {})",
                ownership.as_str(),
                kernel.base_url(),
                kernel.pid,
                kernel.owned
            );
            clear_runtime_degraded(app);
            kernel_managed::set_kernel_status(KernelStatus::from_handle(&kernel, ownership, 0));
            connect_local_backend(app, &kernel.base_url()).await.0
        }
        Err(err) => {
            log::warn!(
                "Local kernel {} did not come up; probing the configured address {}: {}",
                kernel_log_dir().display(),
                fallback_url,
                err
            );
            let (handle, reachable) = connect_local_backend(app, fallback_url).await;
            match fallback_outcome(reachable) {
                KernelFallback::Attached => {
                    clear_runtime_degraded(app);
                    mark_attached(fallback_url, None);
                    handle
                }
                KernelFallback::Degraded => {
                    let message = format!(
                        "本机 Hermes 内核启动失败，配置地址 {} 也不可达：{}",
                        fallback_url, err
                    );
                    record_runtime_degraded(app, message);
                    kernel_managed::set_kernel_status(KernelStatus::degraded(
                        fallback_url,
                        err.to_string(),
                    ));
                    handle
                }
            }
        }
    }
}

/// A failed kernel start is only a degradation when the configured address is
/// unreachable too: a live fallback kernel is a normal attach, not an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KernelFallback {
    Attached,
    Degraded,
}

pub fn fallback_outcome(fallback_reachable: bool) -> KernelFallback {
    if fallback_reachable {
        KernelFallback::Attached
    } else {
        KernelFallback::Degraded
    }
}

fn mark_attached(base_url: &str, last_error: Option<String>) {
    let status = match last_error {
        Some(error) => KernelStatus::degraded(base_url, error),
        None => KernelStatus::attached(base_url),
    };
    kernel_managed::set_kernel_status(status);
}

/// Attach to a loopback Hermes Agent CLI dashboard: probe it and pick up the
/// session token it serves. The bool reports whether the probe answered, so
/// callers can decide between "attached" and "degraded" instead of discarding
/// the reachability result.
pub async fn connect_local_backend(
    app: &tauri::AppHandle,
    base_url: &str,
) -> (DashboardHandle, bool) {
    emit_runtime_status(app, "starting-dashboard", "正在连接本机 Hermes Agent...");
    log::info!("Local connection: attaching to {}", base_url);
    let reachable = dashboard::probe_attached_dashboard(base_url).await;
    if !reachable {
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
    (DashboardHandle::local(base_url.to_string(), token), reachable)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_live_fallback_kernel_is_an_attach_not_a_degradation() {
        assert_eq!(fallback_outcome(true), KernelFallback::Attached);
        assert_eq!(fallback_outcome(false), KernelFallback::Degraded);
    }
}
