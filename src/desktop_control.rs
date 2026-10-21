//! Desktop-side control state (onboarding guide progress).
//!
//! This state deliberately lives beside `connection.json`, not inside
//! HERMES_HOME. It controls the desktop shell itself and must survive profile
//! switches.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::connection;
use crate::error::{AppError, AppResult};
use crate::process::data_dir;

const CONTROL_FILE: &str = "desktop-control.json";
const CONTROL_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuideState {
    Pending,
    Deferred,
    Completed,
}

impl GuideState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Deferred => "deferred",
            Self::Completed => "completed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopControlState {
    pub schema_version: u32,
    pub guide_state: GuideState,
}

impl DesktopControlState {
    fn fresh_install() -> Self {
        Self {
            schema_version: CONTROL_SCHEMA_VERSION,
            // Model onboarding happens inside AppShell once the kernel answers,
            // so a clean install must not be diverted into /guide.
            guide_state: GuideState::Completed,
        }
    }
}

pub fn control_path() -> PathBuf {
    data_dir::data_dir().join(CONTROL_FILE)
}

fn read_from(path: &Path) -> Option<DesktopControlState> {
    let raw = fs::read_to_string(path).ok()?;
    // Older files also carried a `managedRuntimeDesiredState` field; unknown
    // fields are ignored by serde, so they read cleanly.
    let state = serde_json::from_str::<DesktopControlState>(&raw).ok()?;
    (state.schema_version == CONTROL_SCHEMA_VERSION).then_some(state)
}

fn write_to(path: &Path, state: &DesktopControlState) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::FileError(format!("no parent dir for {}", path.display())))?;
    fs::create_dir_all(parent)?;
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| AppError::Internal(format!("serialize desktop control: {}", e)))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, format!("{}\n", json))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(tmp, path)?;
    Ok(())
}

/// Initialize the control file without interrupting existing users.
pub fn initialize() -> AppResult<DesktopControlState> {
    let path = control_path();
    if let Some(state) = read_from(&path) {
        return Ok(state);
    }
    let state = DesktopControlState::fresh_install();
    write_to(&path, &state)?;
    Ok(state)
}

pub fn read() -> DesktopControlState {
    read_from(&control_path()).unwrap_or_else(DesktopControlState::fresh_install)
}

/// Whether the user has already been through (or dismissed) the onboarding
/// guide. Used by the renderer through `get_desktop_control_state`.
pub fn established_install() -> bool {
    connection::config_path().is_file() || connection::env_override_active()
}

pub fn write(state: &DesktopControlState) -> AppResult<()> {
    write_to(&control_path(), state)
}

pub fn set_guide_state(guide_state: GuideState) -> AppResult<DesktopControlState> {
    let mut state = read();
    state.guide_state = guide_state;
    write(&state)?;
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guide_state_round_trips() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let path = dir.path().join(CONTROL_FILE);
        let state = DesktopControlState::fresh_install();
        write_to(&path, &state).expect("write");
        let read_back = read_from(&path).expect("read");
        assert_eq!(read_back.guide_state, GuideState::Completed);
    }

    #[test]
    fn legacy_file_with_runtime_intent_still_reads() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let path = dir.path().join(CONTROL_FILE);
        fs::write(
            &path,
            r#"{ "schemaVersion": 1, "guideState": "deferred",
                 "managedRuntimeDesiredState": "running" }"#,
        )
        .expect("write legacy");
        let read_back = read_from(&path).expect("read legacy");
        assert_eq!(read_back.guide_state, GuideState::Deferred);
    }
}
