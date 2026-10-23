// Desktop connection config: a single mode — an external Hermes kernel.
//
// The desktop attaches to a Hermes Agent that it does not own and never
// starts: either the CLI dashboard on this machine (loopback URL) or a remote
// gateway. Both are just URLs, so `connection.json` stores one entry:
//
//   { "version": 4, "mode": "external",
//     "external": { "url": "...", "token": { ... }, "auth_mode": "token" } }
//
// The in-memory `ConnectionMode` is derived from the URL (loopback ⇒ local,
// anything else ⇒ remote) purely so the renderer keeps its existing
// local/remote distinction; there is no third, desktop-owned mode.
//
// Persistence lives at `data_dir()/connection.json`. The token is stored
// plaintext with 0600 permissions (same trust level as the API keys in
// `HERMES_HOME/.env`); the `encoding` tag reserves a future keyring upgrade.
//
// Resolution precedence (first match wins):
//   1. HERMES_DESKTOP_REMOTE_URL + HERMES_DESKTOP_REMOTE_TOKEN env override
//      (URL without token is a hard error, not a silent fallback)
//   2. connection.json `external.url`
//   3. the loopback default (http://127.0.0.1:9119)

use std::fs;
use std::net::IpAddr;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::process::data_dir;

pub const ENV_REMOTE_URL: &str = "HERMES_DESKTOP_REMOTE_URL";
pub const ENV_REMOTE_TOKEN: &str = "HERMES_DESKTOP_REMOTE_TOKEN";
pub const DEFAULT_EXTERNAL_URL: &str = "http://127.0.0.1:9119";
pub const DEFAULT_LOCAL_DASHBOARD_URL: &str = DEFAULT_EXTERNAL_URL;
const CONNECTION_FILE: &str = "connection.json";
const CONNECTION_FILE_VERSION: u32 = 4;
const EXTERNAL_MODE: &str = "external";

use crate::oauth_session::PersistedCookie;

/// How the external backend authenticates. Legacy files only ever used the
/// session token; gated gateways use an OAuth/cookie session. Absent from a
/// file ⇒ `Token` (backward compatible).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RemoteAuthMode {
    #[default]
    Token,
    Oauth,
}

impl RemoteAuthMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            RemoteAuthMode::Token => "token",
            RemoteAuthMode::Oauth => "oauth",
        }
    }

    pub fn from_str_opt(value: Option<&str>) -> Self {
        match value.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
            Some("oauth") => RemoteAuthMode::Oauth,
            _ => RemoteAuthMode::Token,
        }
    }
}

/// Effective connection flavor of the running desktop, derived from the
/// attached URL. Both variants are external kernels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ConnectionMode {
    #[default]
    Local,
    Remote,
}

impl ConnectionMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConnectionMode::Local => "local",
            ConnectionMode::Remote => "remote",
        }
    }

    pub fn is_remote(&self) -> bool {
        matches!(self, ConnectionMode::Remote)
    }
}

/// Process/filesystem capabilities that only make sense against a kernel on
/// this machine must never be applied to a remote host.
pub fn require_local_filesystem(mode: ConnectionMode, capability: &str) -> AppResult<()> {
    if !mode.is_remote() {
        Ok(())
    } else {
        Err(AppError::InvalidRequest(format!(
            "{} 依赖本机文件或进程，远端 Hermes 模式下已禁用",
            capability
        )))
    }
}

/// Where a resolved backend came from, for logging/diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteSource {
    Env,
    Settings,
}

impl RemoteSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            RemoteSource::Env => "env",
            RemoteSource::Settings => "settings",
        }
    }
}

/// A loopback Hermes kernel the desktop attaches to. The session token is
/// fetched from the dashboard at connect time, so it is never persisted here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalBackend {
    /// Normalized loopback base URL (no trailing slash, no query/hash).
    pub base_url: String,
}

/// Effective backend selected for this boot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionBackend {
    Local(LocalBackend),
    Remote(RemoteBackend),
}

impl ConnectionBackend {
    pub fn base_url(&self) -> &str {
        match self {
            ConnectionBackend::Local(local) => &local.base_url,
            ConnectionBackend::Remote(remote) => &remote.base_url,
        }
    }

    pub fn mode(&self) -> ConnectionMode {
        match self {
            ConnectionBackend::Local(_) => ConnectionMode::Local,
            ConnectionBackend::Remote(_) => ConnectionMode::Remote,
        }
    }
}

/// How a resolved remote backend authenticates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteAuth {
    /// Session token (loopback-style; sent as header/query).
    Token(String),
    /// OAuth/cookie session. Cookies may be empty (never logged in, or
    /// expired) — boot still proceeds and the auth-expired UX takes over.
    Oauth(Vec<PersistedCookie>),
}

/// A fully-resolved remote backend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteBackend {
    /// Normalized base URL (no trailing slash, no query/hash).
    pub base_url: String,
    pub auth: RemoteAuth,
    pub source: RemoteSource,
}

impl RemoteBackend {
    /// Legacy accessor kept for token-mode callers/tests. Returns the token
    /// string for `Token` auth, empty string for `Oauth`.
    pub fn token(&self) -> &str {
        match &self.auth {
            RemoteAuth::Token(t) => t.as_str(),
            RemoteAuth::Oauth(_) => "",
        }
    }
}

/// In-memory connection config as read from / written to connection.json.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConnectionConfig {
    /// External kernel base URL. `None` ⇒ the loopback default.
    pub url: Option<String>,
    pub token: Option<String>,
    pub auth_mode: RemoteAuthMode,
    /// Persisted OAuth session cookies (oauth mode only).
    pub session: Option<Vec<PersistedCookie>>,
}

impl ConnectionConfig {
    /// Effective URL: the saved one, or the loopback default.
    pub fn effective_url(&self) -> String {
        self.url
            .clone()
            .unwrap_or_else(|| DEFAULT_EXTERNAL_URL.to_string())
    }

    /// Flavor derived from the URL host.
    pub fn mode(&self) -> ConnectionMode {
        mode_for_url(&self.effective_url())
    }
}

/// Shape of the persisted file: the legacy `local`/`managed` entry held the
/// address of the kernel this desktop started, while the current `external`
/// entry holds a URL the user picked. Only the legacy shape derives its URL
/// from the running kernel, so only it may be rewritten on attach.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersistedMode {
    Local,
    External,
}

#[derive(Deserialize)]
struct PersistedModeProbe {
    #[serde(default)]
    mode: String,
}

/// Persisted shape of `connection.json`. Anything unreadable, missing, or not
/// a legacy local/managed file counts as `External`, which is never rewritten.
pub fn persisted_mode() -> PersistedMode {
    persisted_mode_from(&config_path())
}

fn persisted_mode_from(path: &PathBuf) -> PersistedMode {
    let Ok(content) = fs::read_to_string(path) else {
        return PersistedMode::External;
    };
    match serde_json::from_str::<PersistedModeProbe>(&content) {
        Ok(probe)
            if matches!(
                probe.mode.trim().to_ascii_lowercase().as_str(),
                "local" | "managed"
            ) =>
        {
            PersistedMode::Local
        }
        _ => PersistedMode::External,
    }
}

pub fn mode_for_url(url: &str) -> ConnectionMode {
    match url::Url::parse(url) {
        Ok(parsed) if is_loopback_host(&parsed) => ConnectionMode::Local,
        Ok(_) => ConnectionMode::Remote,
        // Unparsable saved URL: treated as remote so local-only capabilities
        // stay disabled until Settings fixes it.
        Err(_) => ConnectionMode::Remote,
    }
}

/// Renderer-facing config: presence/preview signals only, never the token.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SanitizedConnectionConfig {
    /// "local" (loopback kernel) or "remote" (another host).
    pub mode: String,
    pub local_url: String,
    pub remote_url: String,
    pub remote_token_set: bool,
    pub remote_token_preview: Option<String>,
    pub remote_auth_mode: String,
    pub remote_session_set: bool,
    pub env_override: bool,
}

// --- File schema ------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct ConnectionFile {
    version: u32,
    mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    external: Option<ExternalFileEntry>,
    // Legacy entries, read-only: they are migrated to `external` on read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    local: Option<LocalFileEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remote: Option<LegacyRemoteFileEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ExternalFileEntry {
    url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token: Option<TokenFileEntry>,
    /// "token" (default, back-compat) or "oauth". Absent ⇒ token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    auth_mode: Option<String>,
    /// Persisted OAuth cookie session (oauth mode only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session: Option<SessionFileEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
struct LocalFileEntry {
    url: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct LegacyRemoteFileEntry {
    url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token: Option<TokenFileEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    auth_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session: Option<SessionFileEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
struct TokenFileEntry {
    /// "plain" today; reserved for a future keyring-backed encoding.
    encoding: String,
    value: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct SessionFileEntry {
    /// "plain" today; reserved for a future keyring-backed encoding (same tag
    /// as TokenFileEntry). Non-"plain" sessions are ignored on read.
    encoding: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    saved_at_ms: Option<u64>,
    #[serde(default)]
    cookies: Vec<PersistedCookie>,
}

pub fn config_path() -> PathBuf {
    data_dir::data_dir().join(CONNECTION_FILE)
}

/// Read the persisted connection config. Fails open: a missing, unreadable, or
/// malformed file yields the default config (loopback URL) rather than an
/// error, so a corrupt connection.json can never brick the desktop boot. Files
/// written by older builds (`managed` / `local` / `remote`) migrate onto the
/// single external shape here.
pub fn read_config() -> ConnectionConfig {
    read_config_from(&config_path())
}

fn read_config_from(path: &PathBuf) -> ConnectionConfig {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return ConnectionConfig::default(),
    };
    let file: ConnectionFile = match serde_json::from_str(&content) {
        Ok(file) => file,
        Err(err) => {
            log::warn!(
                "Malformed connection config at {}; falling back to {}: {}",
                path.display(),
                DEFAULT_EXTERNAL_URL,
                err
            );
            return ConnectionConfig::default();
        }
    };

    if let Some(external) = file.external.as_ref() {
        let url = external.url.trim().to_string();
        if !url.is_empty() {
            return config_from_entry(
                &url,
                external.token.as_ref(),
                external.auth_mode.as_deref(),
                external.session.as_ref(),
            );
        }
    }

    // Legacy shapes: managed / local / remote all collapse onto one URL.
    let legacy = if file.mode.eq_ignore_ascii_case("remote") {
        file.remote.as_ref().map(|entry| {
            config_from_entry(
                entry.url.trim(),
                entry.token.as_ref(),
                entry.auth_mode.as_deref(),
                entry.session.as_ref(),
            )
        })
    } else {
        // "managed", "local" and anything unknown: the loopback dashboard URL.
        file.local
            .as_ref()
            .map(|entry| entry.url.trim().to_string())
            .filter(|url| !url.is_empty())
            .map(|url| config_from_entry(&url, None, None, None))
    };

    legacy.unwrap_or_default()
}

fn config_from_entry(
    url: &str,
    token: Option<&TokenFileEntry>,
    auth_mode: Option<&str>,
    session: Option<&SessionFileEntry>,
) -> ConnectionConfig {
    let url = url.trim().trim_end_matches('/').to_string();
    ConnectionConfig {
        url: if url.is_empty() { None } else { Some(url) },
        token: token
            .filter(|t| t.encoding == "plain")
            .map(|t| t.value.clone())
            .filter(|v| !v.is_empty()),
        auth_mode: RemoteAuthMode::from_str_opt(auth_mode),
        session: session
            .filter(|s| s.encoding == "plain")
            .map(|s| s.cookies.clone()),
    }
}

/// Persist the connection config atomically (temp file + rename) with 0600
/// permissions on Unix — the file may hold a session token in plaintext.
pub fn write_config(config: &ConnectionConfig) -> AppResult<()> {
    write_config_to(&config_path(), config)
}

fn write_config_to(path: &PathBuf, config: &ConnectionConfig) -> AppResult<()> {
    let file = ConnectionFile {
        version: CONNECTION_FILE_VERSION,
        mode: EXTERNAL_MODE.to_string(),
        external: Some(ExternalFileEntry {
            url: config.effective_url(),
            token: config.token.as_ref().map(|value| TokenFileEntry {
                encoding: "plain".to_string(),
                value: value.clone(),
            }),
            auth_mode: Some(config.auth_mode.as_str().to_string()),
            session: config
                .session
                .as_ref()
                .filter(|_| config.auth_mode == RemoteAuthMode::Oauth)
                .map(|cookies| SessionFileEntry {
                    encoding: "plain".to_string(),
                    saved_at_ms: Some(now_ms()),
                    cookies: cookies.clone(),
                }),
        }),
        local: None,
        remote: None,
    };

    let parent = path
        .parent()
        .ok_or_else(|| AppError::FileError(format!("no parent dir for {}", path.display())))?;
    fs::create_dir_all(parent)?;

    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| AppError::Internal(format!("serialize connection config: {}", e)))?;

    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, format!("{}\n", json))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(&tmp_path, path)?;
    Ok(())
}

// --- Runtime endpoint -------------------------------------------------------

/// Cache of the endpoint a kernel actually bound to on the previous run.
/// `connection.json` stays the user's own intent (a pinned external URL is
/// never rewritten); this file is the desktop's own memo so the next cold
/// start can probe the real port instead of a dead configured one. It holds no
/// token and no auth material.
pub const RUNTIME_ENDPOINT_FILE: &str = "runtime-endpoint.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeEndpoint {
    pub url: String,
    #[serde(default)]
    pub updated_at: u64,
}

pub fn runtime_endpoint_path() -> PathBuf {
    data_dir::data_dir().join(RUNTIME_ENDPOINT_FILE)
}

fn normalize_endpoint_url(raw: &str) -> Option<String> {
    let url = raw.trim().trim_end_matches('/');
    if url.is_empty() {
        None
    } else {
        Some(url.to_string())
    }
}

/// Parse a runtime-endpoint file. Malformed JSON, or a file without a usable
/// `url`, yields `None` so the fallback chain moves on instead of probing
/// garbage; a missing `updated_at` is tolerated and reads as 0.
fn parse_runtime_endpoint(content: &str) -> Option<RuntimeEndpoint> {
    let file: RuntimeEndpoint = serde_json::from_str(content).ok()?;
    let url = normalize_endpoint_url(&file.url)?;
    Some(RuntimeEndpoint {
        url,
        updated_at: file.updated_at,
    })
}

/// Whether a freshly adopted endpoint has to be written. Same value ⇒ no
/// rewrite, so a supervisor restarting a kernel on the same port does not
/// churn the file (and `updated_at` keeps meaning "last real change").
pub fn runtime_endpoint_changed(current: Option<&RuntimeEndpoint>, url: &str) -> bool {
    let Some(url) = normalize_endpoint_url(url) else {
        return false;
    };
    current.map(|endpoint| endpoint.url.as_str()) != Some(url.as_str())
}

pub fn read_runtime_endpoint() -> Option<RuntimeEndpoint> {
    read_runtime_endpoint_from(&runtime_endpoint_path())
}

fn read_runtime_endpoint_from(path: &PathBuf) -> Option<RuntimeEndpoint> {
    let content = fs::read_to_string(path).ok()?;
    parse_runtime_endpoint(&content)
}

fn write_runtime_endpoint_to(path: &PathBuf, endpoint: &RuntimeEndpoint) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::FileError(format!("no parent dir for {}", path.display())))?;
    fs::create_dir_all(parent)?;
    let json = serde_json::to_string_pretty(endpoint)
        .map_err(|e| AppError::Internal(format!("serialize runtime endpoint: {}", e)))?;
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, format!("{}\n", json))?;
    fs::rename(&tmp_path, path)?;
    Ok(())
}

/// Record the endpoint a live kernel answered on. Best effort by design: a
/// failed write only costs the next cold start one wasted probe, so it is
/// logged and swallowed instead of failing the boot.
pub fn record_runtime_endpoint(url: &str) {
    let Some(url) = normalize_endpoint_url(url) else {
        return;
    };
    let path = runtime_endpoint_path();
    if !runtime_endpoint_changed(read_runtime_endpoint_from(&path).as_ref(), &url) {
        return;
    }
    let endpoint = RuntimeEndpoint {
        url: url.clone(),
        updated_at: now_ms() / 1000,
    };
    match write_runtime_endpoint_to(&path, &endpoint) {
        Ok(()) => log::info!(
            "runtime-endpoint.json 已记录运行时端点 {}（{}）",
            url,
            path.display()
        ),
        Err(err) => log::warn!(
            "写入 runtime-endpoint.json {} 失败（不影响启动）：{}",
            path.display(),
            err
        ),
    }
}

/// Normalize an external gateway base URL: http/https only, query and hash
/// stripped, trailing slashes trimmed, path prefix preserved.
pub fn normalize_remote_base_url(raw: &str) -> AppResult<String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(AppError::InvalidRequest(
            "Hermes Agent 地址不能为空".to_string(),
        ));
    }

    let mut parsed = url::Url::parse(value)
        .map_err(|e| AppError::InvalidRequest(format!("Hermes Agent 地址无效: {}", e)))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::InvalidRequest(format!(
            "Hermes Agent 地址必须是 http:// 或 https://，当前为 {}://",
            parsed.scheme()
        )));
    }

    parsed.set_fragment(None);
    parsed.set_query(None);
    let trimmed_path = parsed.path().trim_end_matches('/').to_string();
    parsed.set_path(&trimmed_path);

    Ok(parsed.to_string().trim_end_matches('/').to_string())
}

fn normalize_base_url(raw: &str, empty_message: &str, invalid_prefix: &str) -> AppResult<url::Url> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(AppError::InvalidRequest(empty_message.to_string()));
    }

    let mut parsed = url::Url::parse(value)
        .map_err(|e| AppError::InvalidRequest(format!("{}无效: {}", invalid_prefix, e)))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::InvalidRequest(format!(
            "{}必须是 http:// 或 https://，当前为 {}://",
            invalid_prefix,
            parsed.scheme()
        )));
    }
    parsed.set_fragment(None);
    parsed.set_query(None);
    let trimmed_path = parsed.path().trim_end_matches('/').to_string();
    parsed.set_path(&trimmed_path);
    Ok(parsed)
}

fn is_loopback_host(parsed: &url::Url) -> bool {
    match parsed.host() {
        Some(url::Host::Domain(host)) => {
            let lower = host.to_ascii_lowercase();
            lower == "localhost" || lower.ends_with(".localhost")
        }
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => IpAddr::V6(ip).is_loopback(),
        None => false,
    }
}

/// Normalize a loopback dashboard URL. Unlike remote URLs, this must stay on
/// loopback so the desktop never treats a LAN/Internet host as “local”.
pub fn normalize_local_base_url(raw: &str) -> AppResult<String> {
    let parsed = normalize_base_url(raw, "本地 Hermes Agent 地址不能为空", "本地地址")?;
    if !is_loopback_host(&parsed) {
        return Err(AppError::InvalidRequest(
            "本地连接仅允许 localhost / 127.0.0.1 / ::1 地址".to_string(),
        ));
    }
    Ok(parsed.to_string().trim_end_matches('/').to_string())
}

/// "…XXXXXX" preview of a stored token for display: short tokens collapse to
/// "set" so the preview can never reconstruct a meaningful fraction of them.
pub fn token_preview(token: &str) -> Option<String> {
    if token.is_empty() {
        return None;
    }
    let chars: Vec<char> = token.chars().collect();
    if chars.len() <= 8 {
        Some("set".to_string())
    } else {
        let tail: String = chars[chars.len() - 6..].iter().collect();
        Some(format!("...{}", tail))
    }
}

fn env_non_empty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Whether the env override is engaged (URL present). The UI disables the
/// connection editor while this is true, even if the token is missing — the
/// missing token is reported as a boot error instead of silently ignored.
pub fn env_override_active() -> bool {
    env_non_empty(ENV_REMOTE_URL).is_some()
}

/// Resolve the effective backend for this boot.
///
/// Env remote misconfiguration is a hard error; an unparsable saved URL falls
/// back to the loopback default so the user can still reach Settings.
pub fn resolve_connection_backend() -> Result<ConnectionBackend, String> {
    if let Some(raw_url) = env_non_empty(ENV_REMOTE_URL) {
        let token = env_non_empty(ENV_REMOTE_TOKEN).ok_or_else(|| {
            format!(
                "设置了 {} 但缺少 {}：远程模式需要 session token",
                ENV_REMOTE_URL, ENV_REMOTE_TOKEN
            )
        })?;
        let base_url = normalize_remote_base_url(&raw_url)
            .map_err(|e| format!("{} 无效: {}", ENV_REMOTE_URL, e))?;
        // Env override stays token-only by design: OAuth sessions are
        // interactive and cannot be provisioned from a static env var.
        return backend_for(base_url, RemoteAuth::Token(token), RemoteSource::Env);
    }

    let config = read_config();
    let raw_url = config.effective_url();
    let auth = match config.auth_mode {
        RemoteAuthMode::Oauth => RemoteAuth::Oauth(config.session.clone().unwrap_or_default()),
        // No token: a loopback dashboard hands its token out at connect time,
        // so attaching without one is normal there.
        RemoteAuthMode::Token => RemoteAuth::Token(config.token.clone().unwrap_or_default()),
    };
    let normalized = match normalize_remote_base_url(&raw_url) {
        Ok(base_url) => base_url,
        Err(err) => {
            log::warn!(
                "connection.json 中的地址无效（{}）；回退到 {}",
                err,
                DEFAULT_EXTERNAL_URL
            );
            DEFAULT_EXTERNAL_URL.to_string()
        }
    };
    backend_for(normalized, auth, RemoteSource::Settings)
}

fn backend_for(
    base_url: String,
    auth: RemoteAuth,
    source: RemoteSource,
) -> Result<ConnectionBackend, String> {
    Ok(match mode_for_url(&base_url) {
        ConnectionMode::Local => ConnectionBackend::Local(LocalBackend { base_url }),
        ConnectionMode::Remote => ConnectionBackend::Remote(RemoteBackend {
            base_url,
            auth,
            source,
        }),
    })
}

/// Backward-compatible helper for older tests/callers.
pub fn resolve_remote_backend() -> Result<Option<RemoteBackend>, String> {
    match resolve_connection_backend()? {
        ConnectionBackend::Remote(remote) => Ok(Some(remote)),
        ConnectionBackend::Local(_) => Ok(None),
    }
}

/// Strip the token down to presence/preview signals for the renderer.
pub fn sanitize(config: &ConnectionConfig) -> SanitizedConnectionConfig {
    let env_url = env_non_empty(ENV_REMOTE_URL);
    let env_override = env_url.is_some();
    if let Some(url) = env_url {
        let token = env_non_empty(ENV_REMOTE_TOKEN);
        return SanitizedConnectionConfig {
            mode: mode_for_url(&url).as_str().to_string(),
            local_url: DEFAULT_EXTERNAL_URL.to_string(),
            remote_url: url,
            remote_token_set: token.is_some(),
            remote_token_preview: token.as_deref().and_then(token_preview),
            remote_auth_mode: RemoteAuthMode::Token.as_str().to_string(),
            remote_session_set: false,
            env_override,
        };
    }

    let url = config.effective_url();
    let mode = mode_for_url(&url);
    SanitizedConnectionConfig {
        mode: mode.as_str().to_string(),
        local_url: if mode == ConnectionMode::Local {
            url.clone()
        } else {
            DEFAULT_EXTERNAL_URL.to_string()
        },
        remote_url: if mode == ConnectionMode::Remote {
            url
        } else {
            String::new()
        },
        remote_token_set: config.token.is_some(),
        remote_token_preview: config.token.as_deref().and_then(token_preview),
        remote_auth_mode: config.auth_mode.as_str().to_string(),
        remote_session_set: config
            .session
            .as_ref()
            .map(|c| !c.is_empty())
            .unwrap_or(false),
        env_override,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use serial_test::serial;
    use tempfile::TempDir;

    fn clear_env() {
        std::env::remove_var(ENV_REMOTE_URL);
        std::env::remove_var(ENV_REMOTE_TOKEN);
    }

    #[test]
    fn normalize_strips_trailing_slashes() {
        assert_eq!(
            normalize_remote_base_url("http://gateway.example.com/").unwrap(),
            "http://gateway.example.com"
        );
        assert_eq!(
            normalize_remote_base_url("https://gateway.example.com///").unwrap(),
            "https://gateway.example.com"
        );
    }

    #[test]
    fn normalize_keeps_path_prefix() {
        assert_eq!(
            normalize_remote_base_url("https://gateway.example.com/hermes/").unwrap(),
            "https://gateway.example.com/hermes"
        );
    }

    #[test]
    fn normalize_strips_query_and_hash() {
        assert_eq!(
            normalize_remote_base_url("http://host:9120/prefix?x=1#frag").unwrap(),
            "http://host:9120/prefix"
        );
    }

    #[test]
    fn normalize_rejects_empty_and_invalid() {
        assert!(normalize_remote_base_url("").is_err());
        assert!(normalize_remote_base_url("   ").is_err());
        assert!(normalize_remote_base_url("not a url").is_err());
        assert!(normalize_remote_base_url("host:9120").is_err());
    }

    #[test]
    fn normalize_rejects_non_http_schemes() {
        assert!(normalize_remote_base_url("ftp://host").is_err());
        assert!(normalize_remote_base_url("ws://host").is_err());
        assert!(normalize_remote_base_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn token_preview_masks_short_tokens() {
        assert_eq!(token_preview(""), None);
        assert_eq!(token_preview("abc").as_deref(), Some("set"));
        assert_eq!(token_preview("12345678").as_deref(), Some("set"));
    }

    #[test]
    fn token_preview_shows_last_six_of_long_tokens() {
        assert_eq!(token_preview("123456789").as_deref(), Some("...456789"));
    }

    #[test]
    fn config_round_trips_through_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("connection.json");
        let config = ConnectionConfig {
            url: Some("http://host:9221".to_string()),
            token: Some("tok-123".to_string()),
            auth_mode: RemoteAuthMode::Token,
            session: None,
        };
        write_config_to(&path, &config).unwrap();
        let read = read_config_from(&path);
        assert_eq!(read.url.as_deref(), Some("http://host:9221"));
        assert_eq!(read.token.as_deref(), Some("tok-123"));
        assert_eq!(read.auth_mode, RemoteAuthMode::Token);
        assert_eq!(read.mode(), ConnectionMode::Remote);
    }

    #[test]
    fn written_file_uses_the_external_shape() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("connection.json");
        write_config_to(&path, &ConnectionConfig::default()).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["mode"], "external");
        assert_eq!(value["external"]["url"], DEFAULT_EXTERNAL_URL);
    }

    #[test]
    fn read_missing_file_falls_back_to_loopback_default() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("connection.json");
        let config = read_config_from(&path);
        assert_eq!(config.effective_url(), DEFAULT_EXTERNAL_URL);
        assert_eq!(config.mode(), ConnectionMode::Local);
    }

    #[test]
    fn read_malformed_file_falls_back_to_loopback_default() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("connection.json");
        fs::write(&path, "{ not json").unwrap();
        assert_eq!(
            read_config_from(&path).effective_url(),
            DEFAULT_EXTERNAL_URL
        );
    }

    #[test]
    fn legacy_managed_migrates_to_external_default() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("connection.json");
        fs::write(&path, r#"{ "version": 1, "mode": "managed" }"#).unwrap();
        let config = read_config_from(&path);
        assert_eq!(config.effective_url(), DEFAULT_EXTERNAL_URL);
        assert_eq!(config.mode(), ConnectionMode::Local);
    }

    #[test]
    fn legacy_local_migrates_to_external() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("connection.json");
        fs::write(
            &path,
            r#"{ "version": 2, "mode": "local",
                 "local": { "url": "http://localhost:9119/" } }"#,
        )
        .unwrap();
        let config = read_config_from(&path);
        assert_eq!(config.url.as_deref(), Some("http://localhost:9119"));
        assert_eq!(config.mode(), ConnectionMode::Local);
    }

    #[test]
    fn legacy_remote_keeps_url_and_token() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("connection.json");
        fs::write(
            &path,
            r#"{ "version": 2, "mode": "remote",
                 "remote": { "url": "https://gw.example.com",
                             "token": { "encoding": "plain", "value": "T" } } }"#,
        )
        .unwrap();
        let config = read_config_from(&path);
        assert_eq!(config.url.as_deref(), Some("https://gw.example.com"));
        assert_eq!(config.token.as_deref(), Some("T"));
        assert_eq!(config.auth_mode, RemoteAuthMode::Token);
        assert_eq!(config.mode(), ConnectionMode::Remote);
    }

    #[test]
    fn oauth_session_roundtrips() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("connection.json");
        let config = ConnectionConfig {
            url: Some("https://gw.example.com".to_string()),
            token: None,
            auth_mode: RemoteAuthMode::Oauth,
            session: Some(vec![PersistedCookie {
                name: "__Host-hermes_session_rt".to_string(),
                value: "RT".to_string(),
                expires_at_ms: Some(now_ms() + 86_400_000),
            }]),
        };
        write_config_to(&path, &config).unwrap();
        let read = read_config_from(&path);
        assert_eq!(read.auth_mode, RemoteAuthMode::Oauth);
        assert_eq!(read.session.as_ref().map(|c| c.len()), Some(1));
    }

    #[test]
    fn normalize_local_allows_only_loopback() {
        assert_eq!(
            normalize_local_base_url(" http://127.0.0.1:9119/?x=1#frag ").unwrap(),
            DEFAULT_EXTERNAL_URL
        );
        assert_eq!(
            normalize_local_base_url("http://localhost:9119/").unwrap(),
            "http://localhost:9119"
        );
        assert!(normalize_local_base_url("http://192.168.1.10:9119").is_err());
    }

    #[test]
    fn read_ignores_unknown_token_encoding() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("connection.json");
        fs::write(
            &path,
            r#"{ "version": 1, "mode": "remote",
                 "remote": { "url": "http://h:1", "token": { "encoding": "keyring", "value": "x" } } }"#,
        )
        .unwrap();
        let config = read_config_from(&path);
        assert_eq!(config.url.as_deref(), Some("http://h:1"));
        assert_eq!(config.token, None);
    }

    #[cfg(unix)]
    #[test]
    fn written_file_has_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("connection.json");
        write_config_to(
            &path,
            &ConnectionConfig {
                url: Some("http://h:1".to_string()),
                token: Some("secret".to_string()),
                auth_mode: RemoteAuthMode::Token,
                session: None,
            },
        )
        .unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    #[serial]
    fn env_url_without_token_is_a_hard_error() {
        clear_env();
        std::env::set_var(ENV_REMOTE_URL, "http://host:9120");
        let result = resolve_remote_backend();
        clear_env();
        assert!(result.is_err());
    }

    #[test]
    #[serial]
    fn env_override_wins_and_normalizes() {
        clear_env();
        std::env::set_var(ENV_REMOTE_URL, "http://host:9120/");
        std::env::set_var(ENV_REMOTE_TOKEN, "tok");
        let result = resolve_remote_backend();
        clear_env();
        let backend = result.unwrap().unwrap();
        assert_eq!(backend.base_url, "http://host:9120");
        assert_eq!(backend.token(), "tok");
        assert_eq!(backend.source, RemoteSource::Env);
    }

    #[test]
    #[serial]
    fn sanitize_never_leaks_token() {
        clear_env();
        let config = ConnectionConfig {
            url: Some("http://h:1".to_string()),
            token: Some("supersecretvalue".to_string()),
            auth_mode: RemoteAuthMode::Token,
            session: None,
        };
        let sanitized = sanitize(&config);
        assert_eq!(sanitized.mode, "remote");
        assert_eq!(sanitized.remote_url, "http://h:1");
        assert!(sanitized.remote_token_set);
        assert_eq!(sanitized.remote_token_preview.as_deref(), Some("...tvalue"));
        assert!(!sanitized.env_override);
        let json = serde_json::to_string(&sanitized).unwrap();
        assert!(!json.contains("supersecretvalue"));
    }

    #[test]
    fn desktop_owned_capabilities_reject_remote_hosts() {
        assert!(require_local_filesystem(ConnectionMode::Local, "files").is_ok());
        let remote = require_local_filesystem(ConnectionMode::Remote, "files").unwrap_err();
        assert!(remote.to_string().contains("远端 Hermes"));
    }

    fn endpoint(url: &str, updated_at: u64) -> RuntimeEndpoint {
        RuntimeEndpoint {
            url: url.to_string(),
            updated_at,
        }
    }

    #[test]
    fn runtime_endpoint_survives_a_serialize_parse_round_trip() {
        let saved = endpoint("http://127.0.0.1:51234", 1_700_000_000);
        let json = serde_json::to_string(&saved).unwrap();
        assert_eq!(parse_runtime_endpoint(&json), Some(saved));
    }

    #[test]
    fn runtime_endpoint_parsing_tolerates_broken_files() {
        assert_eq!(parse_runtime_endpoint("not json at all"), None);
        assert_eq!(parse_runtime_endpoint("{}"), None);
        assert_eq!(parse_runtime_endpoint(r#"{"url":"   "}"#), None);
        assert_eq!(parse_runtime_endpoint(r#"{"url":42}"#), None);
        assert_eq!(
            parse_runtime_endpoint(r#"{"url":"http://127.0.0.1:51234/"}"#),
            Some(endpoint("http://127.0.0.1:51234", 0))
        );
        assert_eq!(
            parse_runtime_endpoint(r#"{"url":"http://127.0.0.1:51234","updated_at":7}"#),
            Some(endpoint("http://127.0.0.1:51234", 7))
        );
    }

    #[test]
    fn runtime_endpoint_file_round_trips_and_holds_no_secret() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(RUNTIME_ENDPOINT_FILE);
        let saved = endpoint("http://127.0.0.1:51234", 1_700_000_000);
        write_runtime_endpoint_to(&path, &saved).unwrap();
        assert_eq!(read_runtime_endpoint_from(&path), Some(saved));
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"url\""));
        assert!(raw.contains("\"updated_at\""));
        assert!(!raw.contains("token"));
        assert!(!raw.contains("auth"));
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn unchanged_endpoint_is_not_rewritten() {
        let current = endpoint("http://127.0.0.1:51234", 1_700_000_000);
        assert!(runtime_endpoint_changed(None, "http://127.0.0.1:51234"));
        assert!(!runtime_endpoint_changed(
            Some(&current),
            "http://127.0.0.1:51234/"
        ));
        assert!(runtime_endpoint_changed(
            Some(&current),
            "http://127.0.0.1:51235"
        ));
        assert!(!runtime_endpoint_changed(Some(&current), "   "));
        assert!(!runtime_endpoint_changed(None, ""));
    }

    #[test]
    #[serial]
    fn record_runtime_endpoint_skips_an_unchanged_value() {
        let dir = TempDir::new().unwrap();
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", dir.path());
        let path = runtime_endpoint_path();
        assert_eq!(path, dir.path().join(RUNTIME_ENDPOINT_FILE));

        record_runtime_endpoint("http://127.0.0.1:51234/");
        let first = fs::read_to_string(&path).unwrap();
        assert_eq!(
            parse_runtime_endpoint(&first).map(|e| e.url),
            Some("http://127.0.0.1:51234".to_string())
        );

        record_runtime_endpoint("http://127.0.0.1:51234");
        assert_eq!(fs::read_to_string(&path).unwrap(), first);

        record_runtime_endpoint("http://127.0.0.1:51235");
        assert_eq!(
            read_runtime_endpoint().map(|e| e.url),
            Some("http://127.0.0.1:51235".to_string())
        );
        assert!(!path.with_extension("json.tmp").exists());
        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
    }
}
