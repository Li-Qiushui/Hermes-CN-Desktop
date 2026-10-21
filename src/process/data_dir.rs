// Writable desktop state root.
//
// The desktop no longer installs or owns a Hermes kernel, so all it needs is
// one place for its own state: `connection.json`, the isolated HERMES_HOME used
// for desktop-side profile metadata, the gateway runtime scratch dir and
// downloaded update packages.

use std::path::PathBuf;
use std::sync::LazyLock;

const APP_DIR: &str = "cn.org.hermesagent.desktop";
/// Packaged / release state tree.
const DATA_SUBDIR_RELEASE: &str = "runtime";
/// Separate tree for `tauri dev` and debug builds so dev state never mixes
/// with an installed copy.
const DATA_SUBDIR_DEV: &str = "dev-runtime";

fn data_subdir_name() -> &'static str {
    if cfg!(debug_assertions) {
        DATA_SUBDIR_DEV
    } else {
        DATA_SUBDIR_RELEASE
    }
}

fn resolve_base() -> PathBuf {
    if let Some(dir) = dirs::data_dir() {
        return dir;
    }
    if let Some(home) = dirs::home_dir() {
        return home.join(".local").join("share");
    }
    panic!(
        "无法确定可写的数据目录：系统数据目录与用户主目录都不可用。\
         请检查 HOME / APPDATA 环境变量后重试。"
    );
}

static DATA_ROOT: LazyLock<PathBuf> =
    LazyLock::new(|| resolve_base().join(APP_DIR).join(data_subdir_name()));

/// Escape hatch for tests and QA: point the whole state tree somewhere else.
const RUNTIME_ROOT_ENV: &str = "HERMES_DESKTOP_RUNTIME_ROOT";

/// Root of every desktop-owned file.
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os(RUNTIME_ROOT_ENV).filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    DATA_ROOT.clone()
}

/// Isolated HERMES_HOME used for desktop-side profile metadata.
pub fn hermes_home_dir() -> PathBuf {
    data_dir().join("hermes-home")
}

/// Scratch dir handed to the gateway's runtime files.
pub fn gateway_runtime_dir() -> PathBuf {
    data_dir().join("gateway-runtime")
}

/// Root for downloaded update packages.
pub fn downloads_root() -> PathBuf {
    data_dir().join("downloads")
}
