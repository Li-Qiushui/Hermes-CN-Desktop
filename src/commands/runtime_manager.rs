// Kernel-facing status commands.
//
// The desktop talks to an external Hermes kernel, so there is no desktop-owned
// kernel version to report and no kernel update channel to poll. These
// commands stay in the IPC surface because the renderer asks for them; they
// describe the external kernel instead of a local install.

use serde::Serialize;
use tauri::State;

use crate::error::AppError;
use crate::process::{artifacts, data_dir};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    /// Always "external": the kernel is not desktop-owned.
    pub mode: String,
    pub packaged: bool,
    pub platform: String,
    pub arch: String,
    /// No locally installed kernel record exists any more.
    pub current: Option<serde_json::Value>,
    pub runtime_root: String,
    pub gateway_runtime_dir: String,
    pub updates_configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub guide_state: String,
    pub api_base_url: String,
    pub connection_mode: String,
}

#[tauri::command]
pub fn runtime_info(state: State<'_, AppState>) -> Result<RuntimeInfo, AppError> {
    let inner = state.inner.lock()?;
    let control = crate::desktop_control::read();
    Ok(RuntimeInfo {
        mode: "external".to_string(),
        packaged: true,
        platform: artifacts::current_platform().to_string(),
        arch: artifacts::current_arch().to_string(),
        current: None,
        runtime_root: data_dir::data_dir().to_string_lossy().to_string(),
        gateway_runtime_dir: data_dir::gateway_runtime_dir()
            .to_string_lossy()
            .to_string(),
        updates_configured: false,
        last_error: inner.last_runtime_error.clone(),
        guide_state: control.guide_state.as_str().to_string(),
        api_base_url: inner.api_base_url.clone(),
        connection_mode: inner.connection_mode.as_str().to_string(),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUpdateCheckResult {
    pub ok: bool,
    pub available: bool,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Kernel updates are provisioned by whoever runs the kernel, not by this
/// desktop: there is never a desktop-downloadable kernel update.
#[tauri::command]
pub async fn runtime_check_update() -> Result<RuntimeUpdateCheckResult, AppError> {
    Ok(RuntimeUpdateCheckResult {
        ok: true,
        available: false,
        current_version: None,
        latest_version: None,
        error: None,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInstallUpdateResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn kernel_managed_elsewhere(action: &str) -> String {
    format!(
        "{} 不可用：桌面端不再内置内核，请在你运行 Hermes 的环境里执行 `hermes update`",
        action
    )
}

#[tauri::command]
pub async fn runtime_install_update() -> Result<RuntimeInstallUpdateResult, AppError> {
    Ok(RuntimeInstallUpdateResult {
        ok: false,
        error: Some(kernel_managed_elsewhere("内核更新")),
    })
}

#[tauri::command]
pub async fn runtime_rollback() -> Result<RuntimeInstallUpdateResult, AppError> {
    Ok(RuntimeInstallUpdateResult {
        ok: false,
        error: Some(kernel_managed_elsewhere("内核回滚")),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopControlStateView {
    pub guide_state: String,
    pub established_install: bool,
}

#[tauri::command]
pub fn get_desktop_control_state() -> Result<DesktopControlStateView, AppError> {
    Ok(DesktopControlStateView {
        guide_state: crate::desktop_control::read().guide_state.as_str().to_string(),
        established_install: crate::desktop_control::established_install(),
    })
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetGuideStateInput {
    pub guide_state: String,
}

#[tauri::command]
pub fn set_guide_state(input: SetGuideStateInput) -> Result<DesktopControlStateView, AppError> {
    let state = match input.guide_state.as_str() {
        "pending" => crate::desktop_control::GuideState::Pending,
        "deferred" => crate::desktop_control::GuideState::Deferred,
        _ => crate::desktop_control::GuideState::Completed,
    };
    let control = crate::desktop_control::set_guide_state(state)?;
    Ok(DesktopControlStateView {
        guide_state: control.guide_state.as_str().to_string(),
        established_install: crate::desktop_control::established_install(),
    })
}
