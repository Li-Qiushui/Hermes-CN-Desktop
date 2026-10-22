use tauri::State;

use crate::bootstrap;
use crate::connection;
use crate::error::AppError;
use crate::kernel_managed::{self, KernelStatus};
use crate::state::AppState;

#[tauri::command]
pub fn kernel_status() -> KernelStatus {
    kernel_managed::kernel_status()
}

/// Re-run the whole attach-or-spawn pipeline for the saved connection and
/// report the resulting kernel status. This is the recovery entry point for a
/// degraded boot: success clears `backend_degraded` (so `backendReady` goes
/// back to true) and re-emits the `runtime-status: ready` event the renderer
/// waits on.
#[tauri::command]
pub async fn retry_kernel(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<KernelStatus, AppError> {
    let backend = connection::resolve_connection_backend().map_err(AppError::InvalidRequest)?;
    let mode = backend.mode();
    let (home, home_base, profile) = {
        let inner = state.inner.lock()?;
        (
            inner.hermes_home.clone(),
            inner.hermes_home_base.clone(),
            inner.current_profile.clone(),
        )
    };

    let handle = bootstrap::connect_backend(&app, &backend).await;
    bootstrap::finalize_bootstrap(&app, handle, home, home_base, profile, mode).await;
    Ok(kernel_managed::kernel_status())
}
