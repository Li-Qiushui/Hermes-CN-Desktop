use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use zip::write::SimpleFileOptions;

use crate::error::{AppError, AppResult};
use crate::process::data_dir;
use crate::state::AppState;

const MAX_TEXT_FILE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES: u64 = 250 * 1024 * 1024;

const CONFIG_FILES: &[&str] = &["config.yaml", ".env", "auth.json", ".anthropic_oauth.json"];

const SENSITIVE_KEY_NEEDLES: &[&str] = &[
    "api_key",
    "apikey",
    "api-key",
    "authorization",
    "x-hermes-session-token",
    "session_token",
    "sessiontoken",
    "session-token",
    "secret",
    "password",
    "access_token",
    "accesstoken",
    "refresh_token",
    "refreshtoken",
    "key_env",
    "token",
];

static BEARER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(Bearer\s+)[A-Za-z0-9_.\-+/=]{8,}").expect("valid bearer redaction regex")
});
static LONG_TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\b(sk-[A-Za-z0-9_\-]{16,}|gh[pous]_[A-Za-z0-9_]{20,}|xox[abprsu]-[A-Za-z0-9-]{10,})\b",
    )
    .expect("valid token redaction regex")
});
static QUERY_TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)([?&](?:token|session_token|access_token|refresh_token)=)[^&\s]+")
        .expect("valid query token redaction regex")
});
static KEY_VALUE_SECRET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?ix)
        ( ["']?
          [A-Za-z0-9_.-]*
          (?: api[_-]?key | authorization | x-hermes-session-token | session[_-]?token | secret | password | access[_-]?token | refresh[_-]?token | key_env | token )
          [A-Za-z0-9_.-]*
          ["']? \s* [:=] \s* ["']? )
        ( [^"'\s,;}]+ )
        ( ["']? )
        "#,
    )
    .expect("valid key/value redaction regex")
});

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportDebugBundleInput {
    #[serde(default)]
    pub frontend_debug: Option<Value>,
    #[serde(default)]
    pub renderer_diagnostics: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDebugBundleResult {
    pub ok: bool,
    pub zip_path: String,
    pub directory_path: String,
    pub size_bytes: u64,
    pub included_files: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
struct RuntimeProcessSnapshot {
    api_base_url: String,
    gateway_url: String,
    hermes_home: String,
    hermes_home_base: String,
    current_profile: String,
    connection_mode: String,
    session_token_present: bool,
    gateway_ws_relay_active: bool,
}

#[derive(Debug, Clone)]
struct DebugStateSnapshot {
    generated_at_unix_ms: u128,
    hermes_home: String,
    hermes_home_base: String,
    current_profile: String,
    runtime_info: Value,
    desktop_state: Value,
    selected_env: Value,
}

#[tauri::command]
pub async fn export_debug_bundle(
    state: State<'_, AppState>,
    input: Option<ExportDebugBundleInput>,
) -> AppResult<ExportDebugBundleResult> {
    let snapshot = capture_debug_state(&state)?;
    let input = input.unwrap_or_default();

    let mut result =
        tauri::async_runtime::spawn_blocking(move || build_debug_bundle(snapshot, input))
            .await
            .map_err(|e| AppError::Internal(format!("Debug bundle task failed: {e}")))??;

    if let Err(err) = open::that(&result.directory_path) {
        result
            .warnings
            .push(format!("导出成功，但自动打开文件夹失败: {err}"));
    }

    Ok(result)
}

fn capture_debug_state(state: &State<'_, AppState>) -> AppResult<DebugStateSnapshot> {
    let (last_error, process, desktop_state) = {
        let inner = state.inner.lock()?;
        let process = inner
            .dashboard_handle
            .as_ref()
            .map(|handle| RuntimeProcessSnapshot {
                api_base_url: inner.api_base_url.clone(),
                gateway_url: inner.gateway_url.clone(),
                hermes_home: inner.hermes_home.clone(),
                hermes_home_base: inner.hermes_home_base.clone(),
                current_profile: inner.current_profile.clone(),
                connection_mode: handle.mode.as_str().to_string(),
                session_token_present: inner.session_token.is_some(),
                gateway_ws_relay_active: inner
                    .gateway_ws
                    .as_ref()
                    .map(|relay| !relay.abort.load(std::sync::atomic::Ordering::Relaxed))
                    .unwrap_or(false),
            });

        let desktop_state = json!({
            "appVersion": env!("CARGO_PKG_VERSION"),
            "packageName": env!("CARGO_PKG_NAME"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "currentExe": std::env::current_exe().ok().map(|p| p.to_string_lossy().to_string()),
            "currentDir": std::env::current_dir().ok().map(|p| p.to_string_lossy().to_string()),
            "apiBaseUrl": inner.api_base_url,
            "gatewayUrl": inner.gateway_url,
            "hermesHome": inner.hermes_home,
            "hermesHomeBase": inner.hermes_home_base,
            "currentProfile": inner.current_profile,
            "connectionMode": inner.connection_mode.as_str(),
            "sessionTokenPresent": inner.session_token.is_some(),
            "lastRuntimeError": inner.last_runtime_error,
            "dashboard": process.as_ref().map(|p| json!({
                "apiBaseUrl": p.api_base_url,
                "connectionMode": p.connection_mode,
                "gatewayWsRelayActive": p.gateway_ws_relay_active,
            })),
        });

        (inner.last_runtime_error.clone(), process, desktop_state)
    };

    // The kernel is external: there is no local install record to report.
    let runtime_info = json!({
        "mode": "external",
        "lastError": last_error,
        "process": process.as_ref().map(|p| json!({
            "apiBaseUrl": p.api_base_url,
            "gatewayUrl": p.gateway_url,
            "currentProfile": p.current_profile,
            "connectionMode": p.connection_mode,
            "sessionTokenPresent": p.session_token_present,
            "gatewayWsRelayActive": p.gateway_ws_relay_active,
        })),
    });
    let runtime_info_value = runtime_info.clone();

    let hermes_home = process
        .as_ref()
        .map(|p| p.hermes_home.clone())
        .or_else(|| {
            desktop_state
                .get("hermesHome")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_default();
    let hermes_home_base = process
        .as_ref()
        .map(|p| p.hermes_home_base.clone())
        .or_else(|| {
            desktop_state
                .get("hermesHomeBase")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_default();
    let current_profile = process
        .as_ref()
        .map(|p| p.current_profile.clone())
        .or_else(|| {
            desktop_state
                .get("currentProfile")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| "default".to_string());

    Ok(DebugStateSnapshot {
        generated_at_unix_ms: now_unix_ms(),
        hermes_home,
        hermes_home_base,
        current_profile,
        runtime_info: redact_json(runtime_info_value),
        desktop_state: redact_json(desktop_state),
        selected_env: redact_json(selected_environment()),
    })
}

fn build_debug_bundle(
    snapshot: DebugStateSnapshot,
    input: ExportDebugBundleInput,
) -> AppResult<ExportDebugBundleResult> {
    let output_dir = debug_output_dir();
    fs::create_dir_all(&output_dir)?;
    let zip_path = unique_debug_zip_path(&output_dir, snapshot.generated_at_unix_ms);
    let file = File::create(&zip_path)?;
    let mut bundle = DebugBundleWriter::new(file);

    bundle.add_text(
        "README.txt",
        "Hermes Agent debug 包。\n\n这个压缩包包含桌面端运行态、内核 runtime 信息、前端 Debug 面板快照、已脱敏配置摘要，以及 HERMES_HOME / gateway runtime 下的日志文件。\n请直接把整个 zip 发给开发者用于排查问题。\n",
    )?;

    bundle.add_json(
        "diagnostics/manifest.json",
        &json!({
            "generatedAtUnixMs": snapshot.generated_at_unix_ms,
            "appVersion": env!("CARGO_PKG_VERSION"),
            "currentProfile": snapshot.current_profile,
            "hermesHome": snapshot.hermes_home,
            "hermesHomeBase": snapshot.hermes_home_base,
            "limits": {
                "maxTextFileBytes": MAX_TEXT_FILE_BYTES,
                "maxTotalSourceBytes": MAX_TOTAL_SOURCE_BYTES,
            },
        }),
    )?;
    bundle.add_json("diagnostics/desktop-state.json", &snapshot.desktop_state)?;
    bundle.add_json("diagnostics/runtime-info.json", &snapshot.runtime_info)?;
    bundle.add_json("diagnostics/selected-env.json", &snapshot.selected_env)?;

    if let Some(renderer) = input.renderer_diagnostics {
        bundle.add_json("diagnostics/renderer.json", &redact_json(renderer))?;
    }
    if let Some(frontend_debug) = input.frontend_debug {
        bundle.add_json(
            "diagnostics/frontend-debug-bus.json",
            &redact_json(frontend_debug),
        )?;
    }

    add_config_snapshots(&mut bundle, &snapshot);
    add_log_directories(&mut bundle, &snapshot);
    add_runtime_artifacts(&mut bundle, &snapshot);

    let included_files = bundle.included_files;
    let mut warnings = bundle.finish()?;
    let size_bytes = fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);

    warnings.sort();
    warnings.dedup();

    Ok(ExportDebugBundleResult {
        ok: true,
        zip_path: zip_path.to_string_lossy().to_string(),
        directory_path: output_dir.to_string_lossy().to_string(),
        size_bytes,
        included_files,
        warnings,
    })
}

struct DebugBundleWriter {
    zip: zip::ZipWriter<File>,
    included_files: usize,
    source_bytes: u64,
    warnings: Vec<String>,
}

impl DebugBundleWriter {
    fn new(file: File) -> Self {
        Self {
            zip: zip::ZipWriter::new(file),
            included_files: 0,
            source_bytes: 0,
            warnings: Vec::new(),
        }
    }

    fn add_json(&mut self, entry_name: &str, value: &Value) -> AppResult<()> {
        let text = serde_json::to_string_pretty(value)
            .map_err(|e| AppError::Internal(format!("Failed to serialize JSON: {e}")))?;
        self.add_text(entry_name, &format!("{text}\n"))
    }

    fn add_text(&mut self, entry_name: &str, text: &str) -> AppResult<()> {
        let opts = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);
        self.zip
            .start_file(safe_entry_name(entry_name), opts)
            .map_err(zip_err)?;
        self.zip.write_all(text.as_bytes())?;
        self.included_files += 1;
        Ok(())
    }

    fn add_redacted_file(&mut self, path: &Path, entry_name: &str) -> AppResult<()> {
        let meta = match fs::symlink_metadata(path) {
            Ok(meta) => meta,
            Err(err) => {
                self.warnings
                    .push(format!("无法读取文件 {}: {err}", path.display()));
                return Ok(());
            }
        };
        if meta.file_type().is_symlink() {
            self.warnings
                .push(format!("已跳过符号链接文件 {}", path.display()));
            return Ok(());
        }
        if !meta.is_file() {
            return Ok(());
        }
        if self.source_bytes >= MAX_TOTAL_SOURCE_BYTES {
            self.warnings.push(format!(
                "已达到 debug 包源文件读取上限 {} bytes，跳过 {}",
                MAX_TOTAL_SOURCE_BYTES,
                path.display()
            ));
            return Ok(());
        }

        let mut file = File::open(path)?;
        let size = meta.len();
        let take_tail = size > MAX_TEXT_FILE_BYTES;
        let read_bytes = if take_tail {
            self.warnings.push(format!(
                "{} 超过 {} bytes，仅收录尾部内容",
                path.display(),
                MAX_TEXT_FILE_BYTES
            ));
            file.seek_to_tail(MAX_TEXT_FILE_BYTES)?;
            MAX_TEXT_FILE_BYTES
        } else {
            size
        };
        let allowed = (MAX_TOTAL_SOURCE_BYTES - self.source_bytes).min(read_bytes);
        if allowed == 0 {
            return Ok(());
        }

        let mut bytes = Vec::with_capacity(allowed.min(1024 * 1024) as usize);
        let mut limited = file.take(allowed);
        limited.read_to_end(&mut bytes)?;
        self.source_bytes = self.source_bytes.saturating_add(bytes.len() as u64);

        let mut text = String::from_utf8_lossy(&bytes).to_string();
        if take_tail {
            text = format!(
                "[Hermes Debug Bundle] 原文件大小 {} bytes；此文件仅收录尾部 {} bytes。\n\n{}",
                size,
                bytes.len(),
                text
            );
        }
        let text = redact_text(&text);
        self.add_text(entry_name, &text)
    }

    fn add_redacted_dir(&mut self, dir: &Path, zip_prefix: &str) -> AppResult<()> {
        if !dir.exists() {
            self.warnings
                .push(format!("目录不存在，已跳过: {}", dir.display()));
            return Ok(());
        }
        let meta = fs::symlink_metadata(dir)?;
        if meta.file_type().is_symlink() {
            self.warnings
                .push(format!("已跳过符号链接目录 {}", dir.display()));
            return Ok(());
        }
        if !meta.is_dir() {
            self.warnings
                .push(format!("不是目录，已跳过: {}", dir.display()));
            return Ok(());
        }

        let mut stack = vec![dir.to_path_buf()];
        while let Some(current) = stack.pop() {
            let mut entries = match fs::read_dir(&current) {
                Ok(entries) => entries.filter_map(Result::ok).collect::<Vec<_>>(),
                Err(err) => {
                    self.warnings
                        .push(format!("无法读取目录 {}: {err}", current.display()));
                    continue;
                }
            };
            entries.sort_by_key(|entry| entry.file_name());
            entries.reverse();
            for entry in entries {
                let path = entry.path();
                let meta = match fs::symlink_metadata(&path) {
                    Ok(meta) => meta,
                    Err(err) => {
                        self.warnings
                            .push(format!("无法读取路径 {}: {err}", path.display()));
                        continue;
                    }
                };
                if meta.file_type().is_symlink() {
                    self.warnings
                        .push(format!("已跳过符号链接 {}", path.display()));
                    continue;
                }
                if meta.is_dir() {
                    stack.push(path);
                    continue;
                }
                if !meta.is_file() {
                    continue;
                }
                let rel = match path.strip_prefix(dir) {
                    Ok(rel) => rel,
                    Err(_) => continue,
                };
                let entry_name = join_entry_path(zip_prefix, rel);
                self.add_redacted_file(&path, &entry_name)?;
            }
        }
        Ok(())
    }

    fn finish(self) -> AppResult<Vec<String>> {
        self.zip.finish().map_err(zip_err)?;
        Ok(self.warnings)
    }
}

trait SeekTail {
    fn seek_to_tail(&mut self, max_bytes: u64) -> std::io::Result<()>;
}

impl SeekTail for File {
    fn seek_to_tail(&mut self, max_bytes: u64) -> std::io::Result<()> {
        use std::io::{Seek, SeekFrom};
        let len = self.metadata()?.len();
        let start = len.saturating_sub(max_bytes);
        self.seek(SeekFrom::Start(start))?;
        Ok(())
    }
}

fn add_config_snapshots(bundle: &mut DebugBundleWriter, snapshot: &DebugStateSnapshot) {
    let home = Path::new(&snapshot.hermes_home);
    if home.as_os_str().is_empty() {
        bundle
            .warnings
            .push("HERMES_HOME 为空，无法收录配置摘要".to_string());
        return;
    }

    for rel in CONFIG_FILES {
        let path = home.join(rel);
        if path.exists() {
            let entry = format!(
                "config/active-profile/{}.redacted.txt",
                rel.replace('/', "__")
            );
            let _ = bundle.add_redacted_file(&path, &entry);
        }
    }
}

fn add_log_directories(bundle: &mut DebugBundleWriter, snapshot: &DebugStateSnapshot) {
    let mut seen = HashSet::new();
    add_log_dir_if_exists(
        bundle,
        Path::new(&snapshot.hermes_home).join("logs"),
        "logs/active-profile",
        &mut seen,
    );

    let base = Path::new(&snapshot.hermes_home_base);
    add_log_dir_if_exists(bundle, base.join("logs"), "logs/default-profile", &mut seen);

    let profiles_dir = base.join("profiles");
    if let Ok(entries) = fs::read_dir(&profiles_dir) {
        let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let profile_name = sanitize_component(&entry.file_name().to_string_lossy());
            add_log_dir_if_exists(
                bundle,
                path.join("logs"),
                &format!("logs/profiles/{profile_name}"),
                &mut seen,
            );
        }
    }
}

fn add_runtime_artifacts(bundle: &mut DebugBundleWriter, _snapshot: &DebugStateSnapshot) {
    let path = data_dir::gateway_runtime_dir();
    if path.exists() {
        let _ = bundle.add_redacted_dir(&path, "runtime/gateway-runtime");
    }
}

fn add_log_dir_if_exists(
    bundle: &mut DebugBundleWriter,
    path: PathBuf,
    zip_prefix: &str,
    seen: &mut HashSet<PathBuf>,
) {
    if !path.exists() {
        return;
    }
    let key = path.canonicalize().unwrap_or_else(|_| path.clone());
    if !seen.insert(key) {
        return;
    }
    let _ = bundle.add_redacted_dir(&path, zip_prefix);
}

fn selected_environment() -> Value {
    let mut vars = serde_json::Map::new();
    for (key, value) in std::env::vars() {
        if key.starts_with("HERMES_")
            || key.starts_with("TAURI_")
            || key == "RUST_LOG"
            || key == "RUST_BACKTRACE"
            || key == "HTTP_PROXY"
            || key == "HTTPS_PROXY"
            || key == "NO_PROXY"
            || key == "ALL_PROXY"
        {
            vars.insert(key, Value::String(value));
        }
    }
    Value::Object(vars)
}

fn debug_output_dir() -> PathBuf {
    dirs::download_dir()
        .or_else(dirs::document_dir)
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("Hermes Debug Reports")
}

fn unique_debug_zip_path(output_dir: &Path, unix_ms: u128) -> PathBuf {
    let mut path = output_dir.join(format!("hermes-debug-{unix_ms}.zip"));
    let mut i = 2;
    while path.exists() {
        path = output_dir.join(format!("hermes-debug-{unix_ms}-{i}.zip"));
        i += 1;
    }
    path
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn redact_json(value: Value) -> Value {
    match value {
        Value::String(s) => Value::String(redact_text(&s)),
        Value::Array(items) => Value::Array(items.into_iter().map(redact_json).collect()),
        Value::Object(map) => {
            let mut next = serde_json::Map::new();
            for (key, value) in map {
                if is_sensitive_key(&key) {
                    next.insert(key, Value::String("***".to_string()));
                } else {
                    next.insert(key, redact_json(value));
                }
            }
            Value::Object(next)
        }
        other => other,
    }
}

fn redact_text(input: &str) -> String {
    let text = BEARER_RE.replace_all(input, "${1}***");
    let text = LONG_TOKEN_RE.replace_all(&text, "***");
    let text = QUERY_TOKEN_RE.replace_all(&text, "${1}***");
    KEY_VALUE_SECRET_RE
        .replace_all(&text, "${1}***${3}")
        .to_string()
}

fn is_sensitive_key(key: &str) -> bool {
    let lower = key.to_lowercase();
    SENSITIVE_KEY_NEEDLES
        .iter()
        .any(|needle| lower.contains(needle))
}

fn join_entry_path(prefix: &str, rel: &Path) -> String {
    let mut out = safe_entry_name(prefix);
    for component in rel.components() {
        if let std::path::Component::Normal(part) = component {
            out.push('/');
            out.push_str(&sanitize_component(&part.to_string_lossy()));
        }
    }
    out
}

fn safe_entry_name(name: &str) -> String {
    name.split('/')
        .filter(|part| !part.is_empty() && *part != "." && *part != "..")
        .map(sanitize_component)
        .collect::<Vec<_>>()
        .join("/")
}

fn sanitize_component(value: &str) -> String {
    let out = value
        .chars()
        .map(|c| match c {
            '/' | '\\' | '\0' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect::<String>();
    if out.is_empty() {
        "_".to_string()
    } else {
        out
    }
}

fn zip_err(err: zip::result::ZipError) -> AppError {
    AppError::FileError(format!("Zip 写入失败: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    #[test]
    fn redacts_tokens_in_text() {
        let input = "Authorization: Bearer abcdefghijklmnop\napi_key=sk-abcdefghijklmnop123456\nurl=/api/ws?token=secret-token";
        let out = redact_text(input);
        assert!(!out.contains("abcdefghijklmnop"));
        assert!(!out.contains("secret-token"));
        assert!(out.contains("Authorization: ***"));
        assert!(out.contains("api_key=***"));
        assert!(out.contains("?token=***"));
    }

    #[test]
    fn redacts_sensitive_json_fields() {
        let value = json!({
            "sessionToken": "abc123456789",
            "nested": { "api_key": "sk-abcdefghijklmnop123456", "normal": "ok" }
        });
        let out = redact_json(value);
        assert_eq!(out["sessionToken"], "***");
        assert_eq!(out["nested"]["api_key"], "***");
        assert_eq!(out["nested"]["normal"], "ok");
    }

    #[test]
    fn safe_entry_name_strips_path_traversal() {
        assert_eq!(safe_entry_name("logs/../evil/./x"), "logs/evil/x");
        assert_eq!(safe_entry_name("/absolute/path"), "absolute/path");
    }

    #[test]
    fn bundle_writer_collects_redacted_log_dir() {
        let dir = TempDir::new().unwrap();
        let logs = dir.path().join("logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(logs.join("agent.log"), "hello token=secret-value\n").unwrap();
        let zip_path = dir.path().join("debug.zip");
        let file = File::create(&zip_path).unwrap();
        let mut writer = DebugBundleWriter::new(file);
        writer.add_redacted_dir(&logs, "logs/active").unwrap();
        writer.finish().unwrap();

        let file = File::open(zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut entry = archive.by_name("logs/active/agent.log").unwrap();
        let mut content = String::new();
        entry.read_to_string(&mut content).unwrap();
        assert!(content.contains("token=***"));
        assert!(!content.contains("secret-value"));
    }
}
