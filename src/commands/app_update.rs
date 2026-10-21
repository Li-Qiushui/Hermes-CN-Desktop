//! Unified self-update — retired.
//!
//! The desktop no longer ships a Hermes kernel, so the "one button updates the
//! shell AND the kernel to the same version" flow no longer applies: the kernel
//! is updated by whoever runs it (`hermes update`), and the shell updates
//! through the desktop/UI update tracks. These commands stay in the IPC surface
//! so the renderer's update UI can report the situation instead of failing on a
//! missing command.

use serde::Serialize;

/// The desktop shell version this binary was built as.
const DESKTOP_VERSION: &str = env!("CARGO_PKG_VERSION");

const UNSUPPORTED_HINT: &str =
    "桌面端不再内置 Hermes 内核：请在你运行内核的环境里执行 `hermes update`，\
     桌面本体请使用「桌面更新」或「界面热更新」";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCheckResult {
    pub ok: bool,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub same_version: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInstallResult {
    pub ok: bool,
    pub backend_installed: bool,
    pub frontend_staged: bool,
    pub backend_verified: bool,
    pub frontend_installed: bool,
    pub restarted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
pub async fn app_update_check() -> AppUpdateCheckResult {
    AppUpdateCheckResult {
        ok: false,
        current_version: Some(DESKTOP_VERSION.to_string()),
        latest_version: None,
        update_available: false,
        same_version: false,
        error: Some(UNSUPPORTED_HINT.to_string()),
    }
}

#[tauri::command]
pub async fn app_update_install() -> AppUpdateInstallResult {
    AppUpdateInstallResult {
        ok: false,
        backend_installed: false,
        frontend_staged: false,
        backend_verified: false,
        frontend_installed: false,
        restarted: false,
        error: Some(UNSUPPORTED_HINT.to_string()),
    }
}
