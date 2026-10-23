// Runtime config + gateway URL refresh for the attached external kernel.

use serde::Serialize;
use tauri::State;

use crate::error::AppError;
use crate::process::dashboard::{build_gateway_url, fetch_session_token};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    pub api_base_url: String,
    pub gateway_url: String,
    pub session_token: Option<String>,
    /// The external kernel reports its own version over HTTP; the desktop does
    /// not track one locally.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kernel_version: Option<String>,
    pub current_profile: String,
    /// "local" (loopback kernel) or "remote" (another host).
    pub connection_mode: String,
    /// Whether REST/Gateway requests can currently reach a configured backend.
    pub backend_ready: bool,
    /// Degraded *and* no local kernel binary at all: the machine has no Hermes
    /// kernel installed, so the UI should offer install/remote guidance instead
    /// of "start failed, retry".
    pub kernel_missing: bool,
    pub guide_state: String,
    /// Kept for the renderer contract: an external kernel is always "running"
    /// from the desktop's point of view (it is not ours to stop).
    pub managed_runtime_desired_state: String,
    pub managed_runtime_lifecycle_state: String,
    pub portable: bool,
    pub embedded: bool,
}

#[tauri::command]
pub fn get_runtime_config(state: State<'_, AppState>) -> Result<RuntimeConfig, AppError> {
    let inner = state.inner.lock()?;
    let control = crate::desktop_control::read();
    Ok(RuntimeConfig {
        api_base_url: inner.api_base_url.clone(),
        gateway_url: inner.gateway_url.clone(),
        session_token: inner.session_token.clone(),
        kernel_version: None,
        current_profile: inner.current_profile.clone(),
        connection_mode: inner.connection_mode.as_str().to_string(),
        backend_ready: inner.dashboard_handle.is_some()
            && !inner.api_base_url.trim().is_empty()
            && !inner.backend_degraded,
        kernel_missing: inner.backend_degraded && crate::kernel_managed::kernel_bin_missing(),
        guide_state: control.guide_state.as_str().to_string(),
        managed_runtime_desired_state: "running".to_string(),
        managed_runtime_lifecycle_state: "running".to_string(),
        portable: false,
        embedded: false,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshGatewayResult {
    pub gateway_url: String,
    pub session_token: Option<String>,
}

#[tauri::command]
pub async fn refresh_gateway_url(
    state: State<'_, AppState>,
) -> Result<RefreshGatewayResult, AppError> {
    let (api_base_url, current_token) = {
        let inner = state.inner.lock()?;
        (inner.api_base_url.clone(), inner.session_token.clone())
    };

    // Remote/gated kernels carry a static credential: return the current
    // connection unchanged instead of scraping HTML for a token they don't
    // embed.
    let oauth = { state.inner.lock()?.oauth_session.is_some() };
    if oauth {
        let inner = state.inner.lock()?;
        return Ok(RefreshGatewayResult {
            gateway_url: inner.gateway_url.clone(),
            session_token: inner.session_token.clone(),
        });
    }

    let env_token = std::env::var("HERMES_DESKTOP_SESSION_TOKEN")
        .ok()
        .or_else(|| std::env::var("HERMES_DASHBOARD_SESSION_TOKEN").ok());
    // Dashboard session tokens are process-local and rotate on every kernel
    // restart. A refresh that races the kernel coming back up sees
    // `fetch_session_token` fail and return None. Treat that as "token
    // unchanged" and keep the token we already have rather than clobbering a
    // valid token with None — otherwise every subsequent proxied request drops
    // its Authorization header and 401s until the next restart.
    let fresh_token = match env_token {
        Some(t) => Some(t),
        None => fetch_session_token(&api_base_url).await.or(current_token),
    };

    let fresh_url = build_gateway_url(&api_base_url, fresh_token.as_deref());

    {
        let mut inner = state.inner.lock()?;
        inner.gateway_url = fresh_url.clone();
        inner.session_token = fresh_token.clone();
    }

    Ok(RefreshGatewayResult {
        gateway_url: fresh_url,
        session_token: fresh_token,
    })
}

/// Kernel version fetch. The external kernel serves `/api/version` over HTTP,
/// so the renderer's version gate uses that path; this command therefore has
/// nothing extra to report.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendVersionInfo {
    pub version: String,
}

#[tauri::command]
pub fn get_backend_version() -> Result<Option<BackendVersionInfo>, AppError> {
    Ok(None)
}
