// Profile switching command.
//
// Replaces the switchProfile IPC handler at
// hermes-cn-ui-v1/apps/desktop/src/main/main.ts lines 669-794.
//
// The active profile belongs to the external kernel: switching it is one
// `POST /api/profiles/active` call, and the desktop only records the sticky
// choice for the next boot.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::AppError;
use crate::profile_name::is_valid_profile_name;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchProfileInput {
    pub name: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchProfileResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hermes_home: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovered_previous_profile: Option<bool>,
}

fn profile_hermes_home(base: &str, profile: &str) -> PathBuf {
    if profile == "default" {
        PathBuf::from(base)
    } else {
        Path::new(base).join("profiles").join(profile)
    }
}

fn active_profile_sticky_path(base: &str) -> PathBuf {
    Path::new(base).join("active_profile")
}

fn write_active_profile_sticky(base: &str, profile: &str) {
    let path = active_profile_sticky_path(base);
    if profile == "default" {
        let _ = fs::remove_file(&path);
    } else {
        let _ = fs::write(&path, profile);
    }
}

pub fn read_active_profile_sticky(base: &str) -> String {
    let path = active_profile_sticky_path(base);
    match fs::read_to_string(&path) {
        Ok(content) => {
            let trimmed = content.trim().to_string();
            if trimmed.is_empty() {
                "default".to_string()
            } else {
                trimmed
            }
        }
        Err(_) => "default".to_string(),
    }
}

#[tauri::command]
pub async fn switch_profile(
    input: SwitchProfileInput,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<SwitchProfileResult, AppError> {
    let name = input.name.trim().to_string();

    if !is_valid_profile_name(&name) {
        return Ok(SwitchProfileResult {
            ok: false,
            error: Some(format!("Invalid profile name: {}", name)),
            ..Default::default()
        });
    }

    let (base, already_active) = {
        let inner = state.inner.lock()?;
        (inner.hermes_home_base.clone(), inner.current_profile == name)
    };

    if already_active {
        let inner = state.inner.lock()?;
        return Ok(SwitchProfileResult {
            ok: true,
            profile_name: Some(inner.current_profile.clone()),
            api_base_url: Some(inner.api_base_url.clone()),
            gateway_url: Some(inner.gateway_url.clone()),
            session_token: inner.session_token.clone(),
            hermes_home: Some(inner.hermes_home.clone()),
            ..Default::default()
        });
    }

    // The profile lives inside the external kernel, so the switch is a plain
    // API call; the desktop only records the sticky choice.
    let request = crate::commands::api_proxy::ApiRequestInput {
        path: "/api/profiles/active".to_string(),
        method: Some("POST".to_string()),
        headers: None,
        body: Some(serde_json::json!({ "name": name }).to_string()),
    };
    let response =
        crate::commands::api_proxy::api_request_from_state(&app, request, &state).await?;
    if !(200..300).contains(&response.status) {
        return Ok(SwitchProfileResult {
            ok: false,
            error: Some(format!(
                "切换到 {name} 失败（HTTP {}）：{}",
                response.status,
                response.body.chars().take(300).collect::<String>()
            )),
            ..Default::default()
        });
    }

    let new_home = profile_hermes_home(&base, &name);
    write_active_profile_sticky(&base, &name);
    let mut inner = state.inner.lock()?;
    inner.current_profile = name.clone();
    inner.hermes_home = new_home.to_string_lossy().to_string();
    Ok(SwitchProfileResult {
        ok: true,
        profile_name: Some(name),
        api_base_url: Some(inner.api_base_url.clone()),
        gateway_url: Some(inner.gateway_url.clone()),
        session_token: inner.session_token.clone(),
        hermes_home: Some(inner.hermes_home.clone()),
        error: None,
        recovered_previous_profile: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    // -------- profile_hermes_home --------

    #[test]
    fn profile_home_default_returns_base_unchanged() {
        let p = profile_hermes_home("/tmp/base", "default");
        assert_eq!(p, PathBuf::from("/tmp/base"));
    }

    #[test]
    fn profile_home_non_default_nested_under_profiles() {
        let p = profile_hermes_home("/tmp/base", "alpha");
        assert_eq!(p, PathBuf::from("/tmp/base").join("profiles").join("alpha"));
    }

    // -------- is_valid_profile_name --------

    #[test]
    fn valid_profile_names_accepted() {
        assert!(is_valid_profile_name("default"));
        assert!(is_valid_profile_name("my-profile"));
        assert!(is_valid_profile_name("test_2"));
        assert!(is_valid_profile_name("A"));
        assert!(is_valid_profile_name("z9"));
    }

    #[test]
    fn invalid_profile_names_rejected() {
        // Empty
        assert!(!is_valid_profile_name(""));
        // Path separators / traversal
        assert!(!is_valid_profile_name("a/b"));
        assert!(!is_valid_profile_name(".."));
        assert!(!is_valid_profile_name("../etc"));
        // Special chars
        assert!(!is_valid_profile_name("a b"));
        assert!(!is_valid_profile_name("a:b"));
        assert!(!is_valid_profile_name("a.b"));
        // Cannot start with hyphen / underscore
        assert!(!is_valid_profile_name("-leading-hyphen"));
        assert!(!is_valid_profile_name("_leading-underscore"));
        // Too long (>64 chars)
        assert!(!is_valid_profile_name(&"a".repeat(65)));
    }

    #[test]
    fn profile_name_length_boundary() {
        // 64 chars exactly is the shared Core/Web maximum.
        assert!(is_valid_profile_name(&"a".repeat(64)));
        assert!(!is_valid_profile_name(&"a".repeat(65)));
    }

    // -------- read / write active_profile sticky --------

    #[test]
    fn read_active_profile_defaults_when_file_missing() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            read_active_profile_sticky(dir.path().to_str().unwrap()),
            "default"
        );
    }

    #[test]
    fn write_then_read_sticky_roundtrip() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().to_str().unwrap();
        write_active_profile_sticky(base, "myprofile");
        assert_eq!(read_active_profile_sticky(base), "myprofile");
    }

    #[test]
    fn write_default_removes_sticky_file() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().to_str().unwrap();
        write_active_profile_sticky(base, "alpha");
        assert!(dir.path().join("active_profile").exists());
        write_active_profile_sticky(base, "default");
        assert!(!dir.path().join("active_profile").exists());
        assert_eq!(read_active_profile_sticky(base), "default");
    }

    #[test]
    fn read_trims_whitespace_in_sticky_file() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("active_profile"), "  beta\n").unwrap();
        assert_eq!(
            read_active_profile_sticky(dir.path().to_str().unwrap()),
            "beta"
        );
    }

    #[test]
    fn read_returns_default_when_sticky_is_blank() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("active_profile"), "   ").unwrap();
        assert_eq!(
            read_active_profile_sticky(dir.path().to_str().unwrap()),
            "default"
        );
    }
}
