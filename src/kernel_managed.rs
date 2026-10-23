use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde::Serialize;

use crate::error::{AppError, AppResult};

pub const LEDGER_FILENAME: &str = "spawn-ledger.json";
pub const READY_MARKER: &str = "HERMES_BACKEND_READY";
pub const DEFAULT_KERNEL_HOST: &str = "127.0.0.1";
pub const MAX_RESTARTS: u32 = 3;
pub const READY_TIMEOUT: Duration = Duration::from_secs(60);
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const LOG_POLL_INTERVAL: Duration = Duration::from_millis(120);
const FALLBACK_PROBE_INTERVAL: Duration = Duration::from_secs(2);
const FALLBACK_RETRY_INTERVAL: Duration = Duration::from_secs(3);
const FALLBACK_MAX_ATTEMPTS: u32 = 4;
const LEDGER_WRITE_ATTEMPTS: usize = 3;
const FALLBACK_PROBE_TIMEOUT: Duration = Duration::from_millis(1500);
const HANDSHAKE_ATTEMPTS: u32 = 4;
const HANDSHAKE_RETRY_DELAY: Duration = Duration::from_millis(700);
const CREATE_TIME_TOLERANCE_SECONDS: f64 = 1.0;
const KERNEL_BIN_ENV: &str = "HERMES_KERNEL_BIN";
const LEDGER_PATH_ENV: &str = "HERMES_KERNEL_LEDGER";

static SESSION_TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)""#).expect("valid kernel token regex")
});

static PROBE_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .expect("valid kernel probe client")
});

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Remember the desktop's AppHandle so the supervisor can republish the
/// endpoint of a kernel it restarted (it runs in a detached task with no
/// handle of its own).
pub fn register_app_handle(app: &tauri::AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
}

fn registered_app_handle() -> Option<&'static tauri::AppHandle> {
    APP_HANDLE.get()
}

static LOOPBACK_URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"http://(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})")
        .expect("valid loopback url regex")
});

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    pub pid: u32,
    pub create_time: f64,
    pub purpose: String,
    pub host: String,
    pub port: u16,
    pub isolated: bool,
    pub registered_at: f64,
    pub argv: String,
    pub hermes_home: String,
    pub profile: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelHandle {
    pub host: String,
    pub port: u16,
    pub token: String,
    pub pid: Option<u32>,
    pub owned: bool,
}

impl KernelHandle {
    pub fn base_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ownership {
    Attached,
    Spawned,
}

impl Ownership {
    pub fn as_str(&self) -> &'static str {
        match self {
            Ownership::Attached => "attached",
            Ownership::Spawned => "spawned",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelStatus {
    pub mode: String,
    pub base_url: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    pub restarts: u32,
    pub port_fallback: bool,
    pub last_error: Option<String>,
}

impl KernelStatus {
    pub const DEGRADED: &'static str = "degraded";

    pub fn remote(base_url: &str) -> Self {
        Self {
            mode: "remote".to_string(),
            base_url: Some(base_url.to_string()),
            host: url_host(base_url),
            port: url_port(base_url),
            ..Self::default()
        }
    }

    pub fn from_handle(handle: &KernelHandle, ownership: Ownership, restarts: u32) -> Self {
        Self {
            mode: ownership.as_str().to_string(),
            base_url: Some(handle.base_url()),
            host: Some(handle.host.clone()),
            port: Some(handle.port),
            pid: handle.pid,
            restarts,
            port_fallback: false,
            last_error: None,
        }
    }

    pub fn attached(base_url: &str) -> Self {
        Self {
            mode: "attached".to_string(),
            base_url: Some(base_url.to_string()),
            host: url_host(base_url),
            port: url_port(base_url),
            ..Self::default()
        }
    }

    pub fn degraded(base_url: &str, last_error: String) -> Self {
        Self {
            mode: Self::DEGRADED.to_string(),
            base_url: Some(base_url.to_string()),
            host: url_host(base_url),
            port: url_port(base_url),
            pid: None,
            restarts: 0,
            port_fallback: false,
            last_error: Some(last_error),
        }
    }

    pub fn with_port_fallback(mut self, flag: bool) -> Self {
        self.port_fallback = flag;
        self
    }

    pub fn is_degraded(&self) -> bool {
        self.mode == Self::DEGRADED
    }
}

fn url_host(raw: &str) -> Option<String> {
    url::Url::parse(raw)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
}

fn url_port(raw: &str) -> Option<u16> {
    url::Url::parse(raw)
        .ok()
        .and_then(|parsed| parsed.port_or_known_default())
}

#[derive(Debug, Clone)]
struct OwnedKernel {
    pid: u32,
    create_time: Option<f64>,
}

static KERNEL_STATUS: OnceLock<Mutex<KernelStatus>> = OnceLock::new();
static OWNED_KERNEL: OnceLock<Mutex<Option<OwnedKernel>>> = OnceLock::new();

fn status_slot() -> &'static Mutex<KernelStatus> {
    KERNEL_STATUS.get_or_init(|| Mutex::new(KernelStatus::default()))
}

fn owned_slot() -> &'static Mutex<Option<OwnedKernel>> {
    OWNED_KERNEL.get_or_init(|| Mutex::new(None))
}

pub fn kernel_status() -> KernelStatus {
    status_slot()
        .lock()
        .map(|status| status.clone())
        .unwrap_or_default()
}

pub fn set_kernel_status(status: KernelStatus) {
    if let Ok(mut slot) = status_slot().lock() {
        *slot = status;
    }
}

pub fn record_kernel_error(message: impl Into<String>) {
    let message = message.into();
    log::warn!("kernel: {}", message);
    if let Ok(mut slot) = status_slot().lock() {
        slot.last_error = Some(message);
    }
}

fn register_owned(pid: u32, create_time: Option<f64>) {
    if let Ok(mut slot) = owned_slot().lock() {
        *slot = Some(OwnedKernel { pid, create_time });
    }
}

fn owned_kernel() -> Option<OwnedKernel> {
    owned_slot().lock().ok().and_then(|slot| slot.clone())
}

pub fn parse_ledger(raw: &str) -> Vec<LedgerEntry> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let value: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let items = match value {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(map) => map
            .get("entries")
            .or_else(|| map.get("processes"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    items.iter().filter_map(ledger_entry_from_value).collect()
}

fn ledger_entry_from_value(value: &serde_json::Value) -> Option<LedgerEntry> {
    let obj = value.as_object()?;
    let pid = json_u32(obj.get("pid"))?;
    let port = json_u32(obj.get("port"))?;
    if pid == 0 || port == 0 || port > u16::MAX as u32 {
        return None;
    }
    let host = obj
        .get("host")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .unwrap_or(DEFAULT_KERNEL_HOST)
        .to_string();
    Some(LedgerEntry {
        pid,
        create_time: json_f64(obj.get("create_time")),
        purpose: json_string(obj.get("purpose")),
        host,
        port: port as u16,
        isolated: obj
            .get("isolated")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        registered_at: json_f64(obj.get("registered_at")),
        argv: json_string(obj.get("argv")),
        hermes_home: json_string(obj.get("hermes_home")),
        profile: json_string(obj.get("profile")),
    })
}

fn json_u32(value: Option<&serde_json::Value>) -> Option<u32> {
    let value = value?;
    if let Some(n) = value.as_u64() {
        return u32::try_from(n).ok();
    }
    value.as_f64().filter(|n| *n >= 0.0).map(|n| n as u32)
}

fn json_f64(value: Option<&serde_json::Value>) -> f64 {
    value.and_then(|v| v.as_f64()).unwrap_or(0.0)
}

fn json_string(value: Option<&serde_json::Value>) -> String {
    value
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

pub fn pick_candidates(mut entries: Vec<LedgerEntry>) -> Vec<LedgerEntry> {
    entries.retain(|entry| !entry.isolated && entry.port != 0);
    entries.sort_by(|a, b| {
        b.registered_at
            .partial_cmp(&a.registered_at)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut seen: HashSet<u32> = HashSet::new();
    entries.retain(|entry| seen.insert(entry.pid));
    entries
}

pub fn parse_ready_line(line: &str) -> Option<u16> {
    let mut cursor = 0usize;
    while let Some(found) = line[cursor..].find(READY_MARKER) {
        let start = cursor + found + READY_MARKER.len();
        let rest = line[start..].trim_start();
        if let Some(rest) = rest.strip_prefix("port") {
            let rest = rest.trim_start();
            if let Some(rest) = rest.strip_prefix('=') {
                let digits: String = rest
                    .trim_start()
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                if let Ok(port) = digits.parse::<u16>() {
                    if port > 0 {
                        return Some(port);
                    }
                }
            }
        }
        cursor = start;
    }
    None
}

const ALREADY_SERVED_MARKERS: [&str; 10] = [
    "already running",
    "already served",
    "already being served",
    "already in use",
    "address already in use",
    "is already served by",
    "已被占用",
    "已被服务",
    "已由",
    "已在运行",
];

pub fn classify_already_served(output: &str) -> bool {
    let lowered = output.to_ascii_lowercase();
    ALREADY_SERVED_MARKERS
        .iter()
        .any(|marker| lowered.contains(marker))
}

pub fn backoff_delays() -> [Duration; MAX_RESTARTS as usize] {
    [
        Duration::from_secs(1),
        Duration::from_secs(2),
        Duration::from_secs(4),
    ]
}

pub fn should_kill(owned: bool, pid_matches: bool) -> bool {
    owned && pid_matches
}

pub fn hermes_root() -> PathBuf {
    if let Some(home) = std::env::var_os("HERMES_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(home);
    }
    if let Some(home) = dirs::home_dir() {
        return home.join(".hermes");
    }
    PathBuf::from(".")
}

pub fn ledger_path() -> PathBuf {
    if let Some(explicit) = std::env::var_os(LEDGER_PATH_ENV).filter(|value| !value.is_empty()) {
        return PathBuf::from(explicit);
    }
    hermes_root().join(LEDGER_FILENAME)
}

pub fn read_ledger() -> Vec<LedgerEntry> {
    read_ledger_at(&ledger_path())
}

pub fn read_ledger_at(path: &Path) -> Vec<LedgerEntry> {
    match fs::read_to_string(path) {
        Ok(raw) => parse_ledger(&raw),
        Err(err) => {
            log::debug!("kernel: no ledger at {}: {}", path.display(), err);
            Vec::new()
        }
    }
}

pub fn remove_ledger_pids(pids: &[u32]) -> usize {
    remove_ledger_pids_at(&ledger_path(), pids)
}

pub fn remove_ledger_pids_at(path: &Path, pids: &[u32]) -> usize {
    if pids.is_empty() {
        return 0;
    }
    for attempt in 0..LEDGER_WRITE_ATTEMPTS {
        match prune_ledger_once(path, pids) {
            LedgerPrune::Done(removed) => {
                log::info!(
                    "kernel: pruned {} dead ledger entr(ies) from {}",
                    removed,
                    path.display()
                );
                return removed;
            }
            LedgerPrune::Nothing => return 0,
            LedgerPrune::Contended => {
                log::debug!(
                    "kernel: ledger at {} changed under us, retrying (attempt {})",
                    path.display(),
                    attempt + 1
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
    0
}

enum LedgerPrune {
    Done(usize),
    Nothing,
    Contended,
}

fn prune_ledger_once(path: &Path, pids: &[u32]) -> LedgerPrune {
    let Ok(raw) = fs::read_to_string(path) else {
        return LedgerPrune::Nothing;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw.trim()) else {
        return LedgerPrune::Nothing;
    };
    let mut removed = 0usize;
    let pruned = match value {
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(retain_live_entries(items, pids, &mut removed))
        }
        serde_json::Value::Object(mut map) => {
            let key = ["entries", "processes"]
                .into_iter()
                .find(|key| map.get(*key).and_then(|v| v.as_array()).is_some());
            let Some(key) = key else {
                return LedgerPrune::Nothing;
            };
            let items = map
                .get(key)
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            map.insert(
                key.to_string(),
                serde_json::Value::Array(retain_live_entries(items, pids, &mut removed)),
            );
            serde_json::Value::Object(map)
        }
        _ => return LedgerPrune::Nothing,
    };
    if removed == 0 {
        return LedgerPrune::Nothing;
    }
    let Ok(serialized) = serde_json::to_string_pretty(&pruned) else {
        return LedgerPrune::Nothing;
    };
    let tmp = ledger_tmp_path(path);
    if fs::write(&tmp, &serialized).is_err() {
        let _ = fs::remove_file(&tmp);
        return LedgerPrune::Contended;
    }
    match fs::read_to_string(path) {
        Ok(current) if current == raw => {}
        _ => {
            let _ = fs::remove_file(&tmp);
            return LedgerPrune::Contended;
        }
    }
    if fs::rename(&tmp, path).is_err() {
        let _ = fs::remove_file(&tmp);
        return LedgerPrune::Contended;
    }
    LedgerPrune::Done(removed)
}

fn ledger_tmp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| LEDGER_FILENAME.to_string());
    let seq = LEDGER_TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let unique = format!(
        "{}.{}.{}.{}.tmp",
        name,
        std::process::id(),
        now_millis(),
        seq
    );
    path.with_file_name(unique)
}

static LEDGER_TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn retain_live_entries(
    items: Vec<serde_json::Value>,
    pids: &[u32],
    removed: &mut usize,
) -> Vec<serde_json::Value> {
    items
        .into_iter()
        .filter(|item| {
            let dead = item
                .get("pid")
                .and_then(|value| json_u32(Some(value)))
                .map(|pid| pids.contains(&pid))
                .unwrap_or(false);
            if dead {
                *removed += 1;
            }
            !dead
        })
        .collect()
}

pub async fn probe_kernel(host: &str, port: u16) -> Option<String> {
    let url = format!("http://{}:{}/", host, port);
    let response = tokio::time::timeout(
        PROBE_TIMEOUT,
        PROBE_CLIENT
            .get(&url)
            .header("Accept", "text/html")
            .send(),
    )
    .await
    .ok()?
    .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let html = response.text().await.ok()?;
    SESSION_TOKEN_RE
        .captures(&html)
        .map(|captures| captures[1].to_string())
}

async fn handshake(host: &str, port: u16) -> Option<String> {
    for attempt in 0..HANDSHAKE_ATTEMPTS {
        if let Some(token) = probe_kernel(host, port).await {
            return Some(token);
        }
        if attempt + 1 < HANDSHAKE_ATTEMPTS {
            tokio::time::sleep(HANDSHAKE_RETRY_DELAY).await;
        }
    }
    None
}

/// Attach to a kernel another process already registered in the ledger, if one
/// answers. Used as a fallback when a fresh start fails: a live kernel we can
/// reach is a normal attach, not a degradation.
pub async fn attach_existing_kernel() -> Option<KernelHandle> {
    attach_first().await
}

async fn attach_first() -> Option<KernelHandle> {
    let mut dead_pids: Vec<u32> = Vec::new();
    let mut attached: Option<KernelHandle> = None;

    for entry in pick_candidates(read_ledger()) {
        let alive = is_process_alive(entry.pid);
        match probe_kernel(&entry.host, entry.port).await {
            Some(token) => {
                if alive {
                    log::info!(
                        "kernel: attached to existing backend pid={} {}:{}",
                        entry.pid,
                        entry.host,
                        entry.port
                    );
                } else {
                    log::warn!(
                        "kernel: ledger pid={} is gone but {}:{} still answers, attaching anyway",
                        entry.pid,
                        entry.host,
                        entry.port
                    );
                }
                attached = Some(KernelHandle {
                    host: entry.host.clone(),
                    port: entry.port,
                    token,
                    pid: Some(entry.pid),
                    owned: false,
                });
                break;
            }
            None => {
                if alive {
                    log::debug!(
                        "kernel: candidate pid={} {}:{} did not answer, skipping",
                        entry.pid,
                        entry.host,
                        entry.port
                    );
                } else {
                    log::info!(
                        "kernel: dropping dead ledger entry pid={} {}:{}",
                        entry.pid,
                        entry.host,
                        entry.port
                    );
                    dead_pids.push(entry.pid);
                }
            }
        }
    }

    if !dead_pids.is_empty() {
        remove_ledger_pids(&dead_pids);
    }
    attached
}

pub async fn ensure_kernel(remote: Option<&str>, log_dir: &Path) -> AppResult<(KernelHandle, Ownership)> {
    if let Some(url) = remote.map(str::trim).filter(|url| !url.is_empty()) {
        set_kernel_status(KernelStatus::remote(url));
        return Err(AppError::InvalidRequest(format!(
            "远程模式优先，跳过本机内核管理：{}",
            url
        )));
    }

    if let Some(handle) = attach_first().await {
        set_kernel_status(KernelStatus::from_handle(
            &handle,
            Ownership::Attached,
            0,
        ));
        return Ok((handle, Ownership::Attached));
    }

    spawn_and_handshake(log_dir).await
}

async fn spawn_and_handshake(log_dir: &Path) -> AppResult<(KernelHandle, Ownership)> {
    let (mut child, log_path) = spawn_serve_with_log(0, log_dir)?;
    let log_display = log_path.display().to_string();

    match wait_for_ready(&mut child, &log_path, READY_TIMEOUT).await {
        ReadyOutcome::Ready { port, owned } => {
            let host = DEFAULT_KERNEL_HOST.to_string();
            let token = match handshake(&host, port).await {
                Some(token) => token,
                None => {
                    let pid = child.id();
                    if let Some(pid) = pid {
                        let _ = kill_owned_tree(pid);
                    }
                    let message = format!(
                        "内核已在 {}:{} 打印 READY，但握手失败（日志：{}）",
                        host, port, log_display
                    );
                    record_kernel_error(message.clone());
                    return Err(AppError::DashboardUnreachable(message));
                }
            };
            let pid = child.id();
            let handle = KernelHandle {
                host,
                port,
                token,
                pid,
                owned,
            };
            if !owned {
                tokio::spawn(async move {
                    log::warn!(
                        "kernel: unattributed backend pid={:?} port={} will not be restarted",
                        pid,
                        port
                    );
                    let _ = child.wait().await;
                });
                set_kernel_status(KernelStatus::from_handle(&handle, Ownership::Attached, 0));
                return Ok((handle, Ownership::Attached));
            }
            let create_time = pid.and_then(spawn_create_time);
            if let Some(pid) = pid {
                register_owned(pid, create_time);
            }
            log::info!(
                "kernel: spawned backend pid={:?} port={} (log {})",
                pid,
                port,
                log_display
            );
            let managed = ManagedKernel {
                child,
                handle: handle.clone(),
                restarts: 0,
                max_restarts: MAX_RESTARTS,
                log_dir: log_dir.to_path_buf(),
            };
            managed.supervise_in_background();
            set_kernel_status(KernelStatus::from_handle(&handle, Ownership::Spawned, 0));
            Ok((handle, Ownership::Spawned))
        }
        ReadyOutcome::Exited {
            already_served: true,
            ..
        } => {
            log::info!("kernel: host already served, retrying attach");
            tokio::time::sleep(Duration::from_millis(300)).await;
            if let Some(handle) = attach_first().await {
                set_kernel_status(KernelStatus::from_handle(
                    &handle,
                    Ownership::Attached,
                    0,
                ));
                return Ok((handle, Ownership::Attached));
            }
            let message = format!("主机已有其他后端在服务，但探测不到可用的会话令牌（日志：{}）", log_display);
            record_kernel_error(message.clone());
            Err(AppError::DashboardUnreachable(message))
        }
        ReadyOutcome::Exited { tail, .. } => {
            let message = format!("内核在就绪前退出（日志：{}）：{}", log_display, tail);
            record_kernel_error(message.clone());
            Err(AppError::DashboardStartup(message))
        }
        ReadyOutcome::TimedOut { tail } => {
            if let Some(pid) = child.id() {
                let _ = kill_owned_tree(pid);
            }
            let message = format!(
                "内核 {:?} 内未打印 {}（日志：{}）：{}",
                READY_TIMEOUT, READY_MARKER, log_display, tail
            );
            record_kernel_error(message.clone());
            Err(AppError::DashboardStartup(message))
        }
    }
}

fn spawn_create_time(pid: u32) -> Option<f64> {
    read_ledger()
        .into_iter()
        .find(|entry| entry.pid == pid && entry.create_time > 0.0)
        .map(|entry| entry.create_time)
        .or_else(|| process_start_time(pid))
}

/// True when no `hermes` executable can be found at all — the machine simply
/// has no local kernel installed, which is a different story from "it failed to
/// start" and deserves different wording in the UI.
pub fn kernel_bin_missing() -> bool {
    resolve_hermes_bin().is_none()
}

pub fn resolve_hermes_bin() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os(KERNEL_BIN_ENV).filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(explicit));
    }
    let root = hermes_root();
    let candidates = [
        root.join("hermes-agent").join(".hermes").join("bin").join("hermes.exe"),
        root.join("hermes-agent").join(".hermes").join("bin").join("hermes"),
        root.join("bin").join("hermes.exe"),
        root.join("bin").join("hermes"),
    ];
    for candidate in candidates {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let name = if cfg!(windows) { "hermes.exe" } else { "hermes" };
    let search_path = std::env::var_os("PATH")?;
    std::env::split_paths(&search_path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

pub fn kernel_env() -> Vec<(String, String)> {
    let root = hermes_root();
    let mut env = vec![("HERMES_HOME".to_string(), root.to_string_lossy().to_string())];
    let runtime_dir = std::env::var_os("HERMES_RUNTIME_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            let candidate = root.join("tools");
            candidate.is_dir().then_some(candidate)
        });
    if let Some(dir) = runtime_dir {
        env.push(("HERMES_RUNTIME_DIR".to_string(), dir.to_string_lossy().to_string()));
    }
    env
}

pub fn spawn_serve(port: u16, log_dir: &Path) -> AppResult<tokio::process::Child> {
    spawn_serve_with_log(port, log_dir).map(|(child, _)| child)
}

pub fn spawn_serve_with_log(port: u16, log_dir: &Path) -> AppResult<(tokio::process::Child, PathBuf)> {
    let bin = resolve_hermes_bin().ok_or_else(|| {
        AppError::DashboardStartup(format!(
            "找不到 hermes 可执行文件（可设置 {}）",
            KERNEL_BIN_ENV
        ))
    })?;
    fs::create_dir_all(log_dir)?;
    let log_path = log_dir.join(format!("kernel-{}.log", now_millis()));
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let stderr = stdout.try_clone()?;

    let mut command = tokio::process::Command::new(&bin);
    command
        .arg("serve")
        .arg("--host")
        .arg(DEFAULT_KERNEL_HOST)
        .arg("--port")
        .arg(port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .kill_on_drop(true);
    for (key, value) in kernel_env() {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        crate::process_ext::hide_console_window_tokio(&mut command);
    }

    let child = command
        .spawn()
        .map_err(|err| AppError::DashboardStartup(format!("启动内核失败：{}", err)))?;
    log::info!(
        "kernel: spawned {} serve --port {} -> {}",
        bin.display(),
        port,
        log_path.display()
    );
    Ok((child, log_path))
}

pub enum ReadyOutcome {
    Ready { port: u16, owned: bool },
    Exited { already_served: bool, tail: String },
    TimedOut { tail: String },
}

#[derive(Debug, Default)]
pub struct FallbackAttempts {
    seen: HashMap<u16, (u32, std::time::Instant)>,
}

impl FallbackAttempts {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn tracked(&self) -> usize {
        self.seen.len()
    }

    fn eligible(&self, port: u16) -> bool {
        match self.seen.get(&port) {
            None => true,
            Some((attempts, last)) => {
                *attempts < FALLBACK_MAX_ATTEMPTS && last.elapsed() >= FALLBACK_RETRY_INTERVAL
            }
        }
    }

    fn record(&mut self, port: u16) {
        let entry = self
            .seen
            .entry(port)
            .or_insert_with(|| (0, std::time::Instant::now()));
        entry.0 += 1;
        entry.1 = std::time::Instant::now();
    }
}

pub fn fallback_ready_allowed(child_alive: bool, already_served: bool) -> bool {
    child_alive && !already_served
}

pub fn fallback_ready_ownership(
    child_alive: bool,
    already_served: bool,
    answered: bool,
) -> Option<bool> {
    (answered && fallback_ready_allowed(child_alive, already_served)).then_some(true)
}

pub fn fallback_candidate_port(seen: &str, attempted: &mut FallbackAttempts) -> Option<u16> {
    for captures in LOOPBACK_URL_RE.captures_iter(seen) {
        let Ok(port) = captures[1].parse::<u16>() else {
            continue;
        };
        if port == 0 || !attempted.eligible(port) {
            continue;
        }
        attempted.record(port);
        return Some(port);
    }
    None
}

pub async fn wait_for_ready(
    child: &mut tokio::process::Child,
    log_path: &Path,
    timeout: Duration,
) -> ReadyOutcome {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut offset = 0u64;
    let mut seen = String::new();
    let mut attempted_ports = FallbackAttempts::new();
    let mut last_fallback_probe = tokio::time::Instant::now();

    loop {
        let chunk = read_growth(log_path, &mut offset);
        seen.push_str(&chunk);

        if let Some(port) = parse_ready_line(&seen) {
            return ReadyOutcome::Ready { port, owned: true };
        }

        let child_alive = matches!(child.try_wait(), Ok(None));
        if !child_alive {
            tokio::time::sleep(Duration::from_millis(150)).await;
            let chunk = read_growth(log_path, &mut offset);
            seen.push_str(&chunk);
            return ReadyOutcome::Exited {
                already_served: classify_already_served(&seen),
                tail: tail_of(&seen),
            };
        }

        if last_fallback_probe.elapsed() >= FALLBACK_PROBE_INTERVAL
            && fallback_ready_allowed(child_alive, classify_already_served(&seen))
        {
            last_fallback_probe = tokio::time::Instant::now();
            if let Some(port) = fallback_candidate_port(&seen, &mut attempted_ports) {
                let answered = tokio::time::timeout(
                    FALLBACK_PROBE_TIMEOUT,
                    probe_kernel(DEFAULT_KERNEL_HOST, port),
                )
                .await
                .ok()
                .flatten()
                .is_some();
                if let Some(owned) = fallback_ready_ownership(
                    matches!(child.try_wait(), Ok(None)),
                    classify_already_served(&seen),
                    answered,
                ) {
                    log::info!(
                        "kernel: no {} line yet, but http://{}:{} answers while our child is alive — keeping ownership",
                        READY_MARKER,
                        DEFAULT_KERNEL_HOST,
                        port
                    );
                    return ReadyOutcome::Ready { port, owned };
                }
            }
        }

        if tokio::time::Instant::now() >= deadline {
            return ReadyOutcome::TimedOut {
                tail: tail_of(&seen),
            };
        }

        tokio::time::sleep(LOG_POLL_INTERVAL).await;
    }
}

fn read_growth(path: &Path, offset: &mut u64) -> String {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return String::new(),
    };
    if file.seek(SeekFrom::Start(*offset)).is_err() {
        return String::new();
    }
    let mut buffer = Vec::new();
    if file.read_to_end(&mut buffer).is_err() {
        return String::new();
    }
    *offset += buffer.len() as u64;
    String::from_utf8_lossy(&buffer).to_string()
}

const TAIL_CHARS: usize = 600;

fn tail_of(text: &str) -> String {
    let trimmed = text.trim();
    let total = trimmed.chars().count();
    if total <= TAIL_CHARS {
        return trimmed.to_string();
    }
    let start = trimmed
        .char_indices()
        .nth(total - TAIL_CHARS)
        .map(|(index, _)| index)
        .unwrap_or(0);
    trimmed[start..].to_string()
}

pub struct ManagedKernel {
    pub child: tokio::process::Child,
    pub handle: KernelHandle,
    pub restarts: u32,
    pub max_restarts: u32,
    log_dir: PathBuf,
}

impl ManagedKernel {
    pub fn supervise_in_background(self) {
        tokio::spawn(async move {
            self.supervise().await;
        });
    }

    pub async fn supervise(mut self) {
        loop {
            let exit = self.child.wait().await;
            log::warn!(
                "kernel: owned backend pid={:?} exited ({:?})",
                self.handle.pid,
                exit
            );

            let mut relaunched = false;
            let mut preferred_port = self.handle.port;
            let port_before_restart = self.handle.port;
            while self.restarts < self.max_restarts {
                let index = (self.restarts as usize).min(backoff_delays().len() - 1);
                let delay = backoff_delays()[index];
                self.restarts += 1;
                log::warn!(
                    "kernel: restart {}/{} in {:?}",
                    self.restarts,
                    self.max_restarts,
                    delay
                );
                {
                    let mut status = kernel_status();
                    status.mode = "restarting".to_string();
                    status.restarts = self.restarts;
                    set_kernel_status(status);
                }
                tokio::time::sleep(delay).await;

                match relaunch_owned(&self.log_dir, preferred_port).await {
                    Ok((child, handle)) => {
                        self.child = child;
                        self.handle = handle;
                        relaunched = true;
                        let mut status = KernelStatus::from_handle(
                            &self.handle,
                            Ownership::Spawned,
                            self.restarts,
                        );
                        status.last_error = None;
                        status.port_fallback =
                            port_fallback_flag(port_before_restart, self.handle.port);
                        set_kernel_status(status);
                        let base_url = self.handle.base_url();
                        if let Some(app) = registered_app_handle() {
                            crate::bootstrap::adopt_kernel_endpoint(app, &base_url);
                        }
                        crate::commands::connection::record_managed_endpoint(&base_url);
                        break;
                    }
                    Err(err) => {
                        preferred_port = 0;
                        log::warn!("kernel: restart failed: {}", err);
                        record_kernel_error(err.to_string());
                    }
                }
            }

            if !relaunched {
                let mut status = kernel_status();
                status.mode = "gave_up".to_string();
                status.restarts = self.restarts;
                if status.last_error.is_none() {
                    status.last_error = Some("内核连续重启失败，已停止重试".to_string());
                }
                set_kernel_status(status);
                log::error!(
                    "kernel: gave up after {} restarts",
                    self.max_restarts
                );
                return;
            }
        }
    }
}

fn port_fallback_flag(previous_port: u16, launched_port: u16) -> bool {
    previous_port != 0 && launched_port != previous_port
}

fn reuse_candidate(previous_port: u16, idle: bool) -> Option<u16> {
    (previous_port != 0 && idle).then_some(previous_port)
}

async fn port_is_idle(port: u16) -> bool {
    tokio::time::timeout(
        FALLBACK_PROBE_TIMEOUT,
        probe_kernel(DEFAULT_KERNEL_HOST, port),
    )
    .await
    .map(|token| token.is_none())
    .unwrap_or(false)
}

async fn relaunch_owned(
    log_dir: &Path,
    previous_port: u16,
) -> AppResult<(tokio::process::Child, KernelHandle)> {
    let reused = if previous_port == 0 {
        None
    } else {
        let idle = port_is_idle(previous_port).await;
        if !idle {
            log::warn!(
                "kernel: previous port {} still answers, relaunching on an ephemeral port",
                previous_port
            );
        }
        reuse_candidate(previous_port, idle)
    };

    if let Some(port) = reused {
        log::info!("kernel: relaunching on previous port {}", port);
        match spawn_owned_kernel(port, log_dir).await {
            Ok(pair) => return Ok(pair),
            Err(err) => log::warn!(
                "kernel: previous port {} unusable after relaunch ({}), falling back to an ephemeral port",
                port,
                err
            ),
        }
    }

    spawn_owned_kernel(0, log_dir).await
}

async fn spawn_owned_kernel(
    requested_port: u16,
    log_dir: &Path,
) -> AppResult<(tokio::process::Child, KernelHandle)> {
    let (mut child, log_path) = spawn_serve_with_log(requested_port, log_dir)?;
    match wait_for_ready(&mut child, &log_path, READY_TIMEOUT).await {
        ReadyOutcome::Ready { port, owned } => {
            if !owned {
                return Err(AppError::DashboardStartup(
                    "重启后探测到的端口归属不明，放弃接管".to_string(),
                ));
            }
            let host = DEFAULT_KERNEL_HOST.to_string();
            let token = handshake(&host, port).await.ok_or_else(|| {
                AppError::DashboardUnreachable(format!("重启后的内核 {}:{} 握手失败", host, port))
            })?;
            let pid = child.id();
            let create_time = pid.and_then(spawn_create_time);
            if let Some(pid) = pid {
                register_owned(pid, create_time);
            }
            Ok((
                child,
                KernelHandle {
                    host,
                    port,
                    token,
                    pid,
                    owned: true,
                },
            ))
        }
        ReadyOutcome::Exited { already_served, tail } => {
            if already_served {
                Err(AppError::DashboardStartup(
                    "重启时主机已被其他后端服务".to_string(),
                ))
            } else {
                Err(AppError::DashboardStartup(tail))
            }
        }
        ReadyOutcome::TimedOut { tail } => {
            if let Some(pid) = child.id() {
                let _ = kill_owned_tree(pid);
            }
            Err(AppError::DashboardStartup(format!("重启超时：{}", tail)))
        }
    }
}

#[cfg(target_os = "windows")]
pub fn kill_owned_tree(pid: u32) -> AppResult<()> {
    let mut command = std::process::Command::new("taskkill");
    command.arg("/PID").arg(pid.to_string()).arg("/T").arg("/F");
    crate::process_ext::hide_console_window(&mut command);
    let output = command
        .output()
        .map_err(|err| AppError::Internal(format!("taskkill 执行失败：{}", err)))?;
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() || text.contains("SUCCESS") || !is_process_alive(pid) {
        Ok(())
    } else {
        Err(AppError::Internal(format!("taskkill {} 失败：{}", pid, text.trim())))
    }
}

#[cfg(not(target_os = "windows"))]
pub fn kill_owned_tree(pid: u32) -> AppResult<()> {
    let group = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
    if group == 0 {
        return Ok(());
    }
    let single = unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    if single == 0 {
        Ok(())
    } else {
        Err(AppError::Internal(format!("kill {} 失败", pid)))
    }
}

#[cfg(target_os = "windows")]
pub fn process_start_time(pid: u32) -> Option<f64> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    const WINDOWS_EPOCH_OFFSET_SECONDS: f64 = 11_644_473_600.0;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut creation = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exit = creation;
        let mut kernel = creation;
        let mut user = creation;
        let ok = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        let ticks = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
        Some(ticks as f64 / 10_000_000.0 - WINDOWS_EPOCH_OFFSET_SECONDS)
    }
}

#[cfg(not(target_os = "windows"))]
pub fn process_start_time(pid: u32) -> Option<f64> {
    let stat = fs::read_to_string(format!("/proc/{}/stat", pid)).ok()?;
    let fields: Vec<&str> = stat.rsplit(')').next()?.split_whitespace().collect();
    let start_ticks: f64 = fields.get(19)?.parse().ok()?;
    let uptime = fs::read_to_string("/proc/uptime").ok()?;
    let uptime_seconds: f64 = uptime.split_whitespace().next()?.parse().ok()?;
    let boot = now_unix() - uptime_seconds;
    Some(boot + start_ticks / 100.0)
}

#[cfg(target_os = "windows")]
pub fn is_process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    const STILL_ACTIVE: u32 = 259;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE
    }
}

#[cfg(not(target_os = "windows"))]
pub fn is_process_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{}", pid)).exists()
}

pub fn pid_identity_matches(pid: u32, create_time: Option<f64>) -> bool {
    if !is_process_alive(pid) {
        return false;
    }
    let Some(actual) = process_start_time(pid) else {
        log::warn!(
            "kernel: pid={} start time unavailable, cannot verify identity; leaving it running instead of killing",
            pid
        );
        return false;
    };
    match create_time {
        Some(expected) if expected > 0.0 => (actual - expected).abs() <= CREATE_TIME_TOLERANCE_SECONDS,
        _ => true,
    }
}

pub fn shutdown_owned_kernel() -> bool {
    let Some(owned) = owned_kernel() else {
        return false;
    };
    let matches = pid_identity_matches(owned.pid, owned.create_time);
    if !should_kill(true, matches) {
        log::warn!(
            "kernel: owned pid={} identity mismatch or unverifiable, leaving it running (residual process, clean up manually)",
            owned.pid
        );
        return false;
    }
    match kill_owned_tree(owned.pid) {
        Ok(()) => {
            log::info!("kernel: killed owned tree pid={}", owned.pid);
            if let Ok(mut slot) = owned_slot().lock() {
                *slot = None;
            }
            true
        }
        Err(err) => {
            log::warn!("kernel: tree kill pid={} failed: {}", owned.pid, err);
            false
        }
    }
}

pub fn now_unix() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relaunch_reuses_a_known_idle_port_only() {
        assert_eq!(reuse_candidate(60303, true), Some(60303));
        assert_eq!(reuse_candidate(60303, false), None);
        assert_eq!(reuse_candidate(0, true), None);
        assert_eq!(reuse_candidate(0, false), None);
    }

    const LEDGER_FIXTURE: &str = r#"
[
  {"pid": 10852, "create_time": 1792675220.6652687, "purpose": "dashboard", "install": "b88577d52ade",
   "spawner_pid": null, "spawner_create": null, "registered_at": 1792675226.1959925,
   "argv": "hermes dashboard --port 9119 --no-open", "host": "127.0.0.1", "port": 9119,
   "profile": "", "hermes_home": "d:\\hermes", "isolated": false},
  {"pid": 10792, "create_time": 1792677773.0004225, "purpose": "serve", "registered_at": 1792677777.6964984,
   "argv": "hermes serve --port 0 --host 127.0.0.1 --isolated", "host": "127.0.0.1", "port": 60303,
   "profile": "", "hermes_home": "d:\\hermes", "isolated": true}
]
"#;

    #[test]
    fn parse_ledger_reads_entries() {
        let entries = parse_ledger(LEDGER_FIXTURE);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].pid, 10852);
        assert_eq!(entries[0].port, 9119);
        assert_eq!(entries[0].purpose, "dashboard");
        assert!(!entries[0].isolated);
        assert_eq!(entries[1].port, 60303);
        assert!(entries[1].isolated);
    }

    #[test]
    fn parse_ledger_tolerates_bad_json() {
        assert!(parse_ledger("{ not json").is_empty());
        assert!(parse_ledger("").is_empty());
        assert!(parse_ledger("null").is_empty());
        assert!(parse_ledger("\"text\"").is_empty());
    }

    #[test]
    fn parse_ledger_handles_empty_array() {
        assert!(parse_ledger("[]").is_empty());
    }

    #[test]
    fn parse_ledger_skips_entries_missing_required_fields() {
        let raw = r#"[
            {"pid": 1, "port": 8080, "host": "127.0.0.1"},
            {"port": 8081},
            {"pid": 2},
            {"pid": 3, "port": 0},
            {"pid": 4, "port": 9000, "host": ""}
        ]"#;
        let entries = parse_ledger(raw);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].pid, 1);
        assert_eq!(entries[1].pid, 4);
        assert_eq!(entries[1].host, DEFAULT_KERNEL_HOST);
    }

    #[test]
    fn pick_candidates_drops_isolated_and_sorts_latest_first() {
        let mut entries = parse_ledger(LEDGER_FIXTURE);
        entries.push(LedgerEntry {
            pid: 20001,
            create_time: 1.0,
            purpose: "serve".to_string(),
            host: "127.0.0.1".to_string(),
            port: 62000,
            isolated: false,
            registered_at: 1792679999.0,
            argv: String::new(),
            hermes_home: String::new(),
            profile: String::new(),
        });
        let candidates = pick_candidates(entries);
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].pid, 20001);
        assert_eq!(candidates[1].pid, 10852);
        assert!(candidates.iter().all(|entry| !entry.isolated));
    }

    #[test]
    fn pick_candidates_dedupes_by_pid_keeping_newest() {
        let base = |registered_at: f64, port: u16| LedgerEntry {
            pid: 7,
            create_time: 1.0,
            purpose: "serve".to_string(),
            host: "127.0.0.1".to_string(),
            port,
            isolated: false,
            registered_at,
            argv: String::new(),
            hermes_home: String::new(),
            profile: String::new(),
        };
        let candidates = pick_candidates(vec![base(10.0, 50000), base(20.0, 50001)]);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].port, 50001);
    }

    #[test]
    fn pick_candidates_empty_is_empty() {
        assert!(pick_candidates(Vec::new()).is_empty());
    }

    #[test]
    fn parse_ready_line_reads_the_marker() {
        assert_eq!(parse_ready_line("HERMES_BACKEND_READY port=60303"), Some(60303));
        assert_eq!(
            parse_ready_line("INFO boot\nHERMES_BACKEND_READY port=60451\nHERMES_DASHBOARD_READY port=60451"),
            Some(60451)
        );
        assert_eq!(
            parse_ready_line("  noise before HERMES_BACKEND_READY port = 51234 trailing"),
            Some(51234)
        );
    }

    #[test]
    fn parse_ready_line_rejects_incomplete_or_invalid() {
        assert_eq!(parse_ready_line("HERMES_BACKEND_READY"), None);
        assert_eq!(parse_ready_line("HERMES_BACKEND_READY port="), None);
        assert_eq!(parse_ready_line("HERMES_BACKEND_READY port=0"), None);
        assert_eq!(parse_ready_line("HERMES_BACKEND_READY port=99999"), None);
        assert_eq!(parse_ready_line("HERMES_DASHBOARD_READY port=60451"), None);
        assert_eq!(parse_ready_line(""), None);
    }

    #[test]
    fn classify_already_served_matches_kernel_output() {
        assert!(classify_already_served(
            "Hermes backend already running on this host: PID 10852, port 9119."
        ));
        assert!(classify_already_served(
            "Refusing to start: this host is already served by pid 1 port 9119."
        ));
        assert!(classify_already_served("Address already in use"));
        assert!(classify_already_served("端口已被占用"));
    }

    #[test]
    fn classify_already_served_ignores_unrelated_output() {
        assert!(!classify_already_served("HERMES_BACKEND_READY port=60303"));
        assert!(!classify_already_served("Traceback: ConnectionResetError"));
        assert!(!classify_already_served(""));
    }

    #[test]
    fn backoff_delays_are_one_two_four_seconds() {
        assert_eq!(
            backoff_delays(),
            [
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(4)
            ]
        );
        assert_eq!(backoff_delays().len(), MAX_RESTARTS as usize);
    }

    #[test]
    fn should_kill_only_owned_and_matching() {
        assert!(should_kill(true, true));
        assert!(!should_kill(true, false));
        assert!(!should_kill(false, true));
        assert!(!should_kill(false, false));
    }

    #[test]
    fn ownership_labels_match_frontend_contract() {
        assert_eq!(Ownership::Attached.as_str(), "attached");
        assert_eq!(Ownership::Spawned.as_str(), "spawned");
    }

    #[test]
    fn status_snapshot_carries_mode_and_endpoint() {
        let handle = KernelHandle {
            host: "127.0.0.1".to_string(),
            port: 60303,
            token: "secret".to_string(),
            pid: Some(1234),
            owned: true,
        };
        let status = KernelStatus::from_handle(&handle, Ownership::Spawned, 2);
        assert_eq!(status.mode, "spawned");
        assert_eq!(status.base_url.as_deref(), Some("http://127.0.0.1:60303"));
        assert_eq!(status.pid, Some(1234));
        assert_eq!(status.restarts, 2);
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains("secret"));

        let remote = KernelStatus::remote("http://192.168.31.7:9119");
        assert_eq!(remote.mode, "remote");
        assert_eq!(remote.host.as_deref(), Some("192.168.31.7"));
        assert_eq!(remote.port, Some(9119));
    }

    #[test]
    fn kernel_env_always_points_at_a_hermes_home() {
        let env = kernel_env();
        assert!(env.iter().any(|(key, _)| key == "HERMES_HOME"));
    }

    #[test]
    fn tail_of_truncates_chinese_logs_on_char_boundary() {
        let body = "内核启动失败：端口已被占用，正在重试。".repeat(120);
        let tail = tail_of(&body);
        assert_eq!(tail.chars().count(), TAIL_CHARS);
        assert!(tail.chars().all(|c| !c.is_whitespace() || c == '\n'));
        assert!(std::str::from_utf8(tail.as_bytes()).is_ok());
        assert!(body.ends_with(&tail));
    }

    #[test]
    fn tail_of_keeps_short_text_untouched() {
        let short = "已被占用\n第二行";
        assert_eq!(tail_of(short), short);
        assert_eq!(tail_of("   "), "");
    }

    #[test]
    fn tail_of_truncates_multibyte_padding_without_panic() {
        let body = format!("{}{}", "字".repeat(700), "内核已由其他进程服务");
        let tail = tail_of(&body);
        assert_eq!(tail.chars().count(), TAIL_CHARS);
        assert!(tail.ends_with("内核已由其他进程服务"));
        assert!(std::str::from_utf8(tail.as_bytes()).is_ok());
    }

    #[test]
    fn fallback_candidate_port_picks_loopback_urls_once() {
        let mut attempted = FallbackAttempts::new();
        let log = "INFO starting\nListening on http://127.0.0.1:60303/\n";
        assert_eq!(fallback_candidate_port(log, &mut attempted), Some(60303));
        assert_eq!(fallback_candidate_port(log, &mut attempted), None);
        assert_eq!(
            fallback_candidate_port("api at http://192.168.31.7:9119/", &mut attempted),
            None
        );
        assert_eq!(
            fallback_candidate_port("http://localhost:60451 ready", &mut attempted),
            Some(60451)
        );
    }

    #[test]
    fn fallback_candidate_port_handles_empty_log() {
        let mut attempted = FallbackAttempts::new();
        assert_eq!(fallback_candidate_port("", &mut attempted), None);
        assert_eq!(attempted.tracked(), 0);
    }

    #[test]
    fn fallback_candidate_port_retries_after_the_interval_until_capped() {
        let log = "Listening on http://127.0.0.1:60303/";
        let mut attempted = FallbackAttempts::new();
        assert_eq!(fallback_candidate_port(log, &mut attempted), Some(60303));
        assert_eq!(fallback_candidate_port(log, &mut attempted), None);

        attempted
            .seen
            .insert(60303, (1, std::time::Instant::now() - FALLBACK_RETRY_INTERVAL));
        assert_eq!(fallback_candidate_port(log, &mut attempted), Some(60303));

        attempted.seen.insert(
            60303,
            (
                FALLBACK_MAX_ATTEMPTS,
                std::time::Instant::now() - FALLBACK_RETRY_INTERVAL,
            ),
        );
        assert_eq!(fallback_candidate_port(log, &mut attempted), None);
    }

    #[test]
    fn fallback_ready_requires_a_live_own_child() {
        assert!(fallback_ready_allowed(true, false));
        assert!(!fallback_ready_allowed(false, false));
        assert!(!fallback_ready_allowed(true, true));
        assert!(!fallback_ready_allowed(false, true));
    }

    #[test]
    fn fallback_ready_keeps_ownership_while_own_child_is_alive() {
        assert_eq!(fallback_ready_ownership(true, false, true), Some(true));
    }

    #[test]
    fn fallback_ready_leaves_ownership_to_attach_when_child_exited() {
        assert_eq!(fallback_ready_ownership(false, false, true), None);
        assert_eq!(fallback_ready_ownership(false, true, true), None);
        assert_eq!(fallback_ready_ownership(true, true, true), None);
        assert_eq!(fallback_ready_ownership(true, false, false), None);
    }

    #[test]
    fn remove_ledger_pids_drops_dead_entries_and_keeps_others() {
        let path = std::env::temp_dir().join(format!(
            "hermes-ledger-{}-{}.json",
            std::process::id(),
            now_millis()
        ));
        fs::write(&path, LEDGER_FIXTURE).expect("fixture written");
        let removed = remove_ledger_pids_at(&path, &[10792]);
        assert_eq!(removed, 1);
        let raw = fs::read_to_string(&path).expect("ledger readable");
        let entries = parse_ledger(&raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].pid, 10852);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn remove_ledger_pids_ignores_empty_or_unknown_pids() {
        let path = std::env::temp_dir().join(format!(
            "hermes-ledger-noop-{}-{}.json",
            std::process::id(),
            now_millis()
        ));
        fs::write(&path, LEDGER_FIXTURE).expect("fixture written");
        assert_eq!(remove_ledger_pids_at(&path, &[]), 0);
        assert_eq!(remove_ledger_pids_at(&path, &[999_999]), 0);
        assert_eq!(parse_ledger(&fs::read_to_string(&path).unwrap()).len(), 2);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn remove_ledger_pids_leaves_no_shared_tmp_file() {
        let path = std::env::temp_dir().join(format!(
            "hermes-ledger-tmp-{}-{}.json",
            std::process::id(),
            now_millis()
        ));
        fs::write(&path, LEDGER_FIXTURE).expect("fixture written");
        assert_eq!(remove_ledger_pids_at(&path, &[10792]), 1);
        let leftovers: Vec<String> = fs::read_dir(std::env::temp_dir())
            .expect("temp dir readable")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("hermes-ledger-tmp-") && name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "leftover tmp files: {:?}", leftovers);
        assert!(parse_ledger(&fs::read_to_string(&path).unwrap()).len() == 1);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn ledger_tmp_names_are_unique_per_writer() {
        let path = std::env::temp_dir().join("hermes-spawn-ledger.json");
        let first = ledger_tmp_path(&path);
        let second = ledger_tmp_path(&path);
        assert_ne!(first, second);
        assert_ne!(first, path);
        let name = first.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.contains(&std::process::id().to_string()));
        assert!(name.ends_with(".tmp"));
        assert_eq!(first.parent(), path.parent());
    }

    #[test]
    fn attached_status_has_no_error() {
        let status = KernelStatus::attached("http://127.0.0.1:9119");
        assert_eq!(status.mode, "attached");
        assert!(!status.is_degraded());
        assert_eq!(status.host.as_deref(), Some("127.0.0.1"));
        assert_eq!(status.port, Some(9119));
        assert!(status.last_error.is_none());
    }

    #[test]
    fn degraded_status_is_marked_and_keeps_the_error() {
        let status = KernelStatus::degraded("http://127.0.0.1:9119", "启动失败".to_string());
        assert_eq!(status.mode, KernelStatus::DEGRADED);
        assert!(status.is_degraded());
        assert_eq!(status.last_error.as_deref(), Some("启动失败"));
        assert_eq!(status.port, Some(9119));

        let spawned = KernelStatus::from_handle(
            &KernelHandle {
                host: "127.0.0.1".to_string(),
                port: 60303,
                token: "secret".to_string(),
                pid: Some(1),
                owned: true,
            },
            Ownership::Spawned,
            0,
        );
        assert!(!spawned.is_degraded());
        assert!(!spawned.port_fallback);
    }

    fn spawned_handle(port: u16) -> KernelHandle {
        KernelHandle {
            host: "127.0.0.1".to_string(),
            port,
            token: "secret".to_string(),
            pid: Some(1),
            owned: true,
        }
    }

    #[test]
    fn port_fallback_flag_needs_a_previous_port_and_a_new_one() {
        assert!(!port_fallback_flag(9119, 9119));
        assert!(port_fallback_flag(9119, 60303));
        assert!(!port_fallback_flag(0, 60303));
        assert!(!port_fallback_flag(0, 0));
    }

    #[test]
    fn status_is_unmarked_until_the_restart_falls_back() {
        let reused = KernelStatus::from_handle(&spawned_handle(9119), Ownership::Spawned, 1);
        assert!(!reused.port_fallback);
        assert_eq!(reused.port, Some(9119));

        let moved = KernelStatus::from_handle(&spawned_handle(60303), Ownership::Spawned, 1)
            .with_port_fallback(port_fallback_flag(9119, 60303));
        assert!(moved.port_fallback);
        assert_eq!(moved.mode, "spawned");

        assert!(!KernelStatus::attached("http://127.0.0.1:9119").port_fallback);
        assert!(!KernelStatus::remote("http://192.168.31.7:9119").port_fallback);
        assert!(!KernelStatus::degraded("http://127.0.0.1:9119", "启动失败".to_string()).port_fallback);
    }

    #[test]
    fn port_fallback_flag_survives_the_restarting_status_rewrite() {
        set_kernel_status(
            KernelStatus::from_handle(&spawned_handle(60303), Ownership::Spawned, 0)
                .with_port_fallback(true),
        );
        let mut status = kernel_status();
        status.mode = "restarting".to_string();
        set_kernel_status(status);
        assert!(kernel_status().port_fallback);
    }
}
