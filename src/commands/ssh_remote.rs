use std::collections::HashMap;
use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const SSH_CONNECT_TIMEOUT_SECS: u32 = 10;
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const TUNNEL_READY_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigText {
    pub path: String,
    pub content: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTargetInput {
    pub host: String,
    #[serde(default)]
    pub user: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    #[serde(default)]
    pub key_path: String,
    #[serde(default)]
    pub remote_hermes_path: String,
    #[serde(default = "default_hermes_port")]
    pub remote_port: u16,
}

fn default_ssh_port() -> u16 {
    22
}

fn default_hermes_port() -> u16 {
    9119
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProbeResult {
    pub ok: bool,
    pub host: String,
    pub command: String,
    pub version: Option<String>,
    pub error: Option<String>,
    pub stderr: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelOpenInput {
    pub id: String,
    #[serde(flatten)]
    pub target: SshTargetInput,
    #[serde(default)]
    pub local_port: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelCloseInput {
    pub id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelResult {
    pub id: String,
    pub local_port: u16,
    pub remote_url: String,
    pub pid: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelEntry {
    pub id: String,
    pub pid: u32,
}

fn tunnels() -> &'static Mutex<HashMap<String, Child>> {
    static TUNNELS: OnceLock<Mutex<HashMap<String, Child>>> = OnceLock::new();
    TUNNELS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn validated(target: &SshTargetInput) -> AppResult<()> {
    let host = target.host.trim();
    if host.is_empty() {
        return Err(AppError::InvalidRequest("SSH 主机不能为空".to_string()));
    }
    if host.chars().any(|c| c.is_whitespace()) {
        return Err(AppError::InvalidRequest(
            "SSH 主机不能包含空格".to_string(),
        ));
    }
    Ok(())
}

fn base_args(target: &SshTargetInput) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        format!("ConnectTimeout={SSH_CONNECT_TIMEOUT_SECS}"),
        "-o".into(),
        "NumberOfPasswordPrompts=0".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
    ];
    if target.port != 0 && target.port != 22 {
        args.push("-p".into());
        args.push(target.port.to_string());
    }
    let key_path = target.key_path.trim();
    if !key_path.is_empty() {
        args.push("-i".into());
        args.push(key_path.to_string());
    }
    let user = target.user.trim();
    let host = target.host.trim();
    args.push(if user.is_empty() {
        host.to_string()
    } else {
        format!("{user}@{host}")
    });
    args
}

fn killed_output(mut child: Child, timeout: Duration) -> Result<std::process::Output, String> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("SSH 探测超时".to_string());
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    child.wait_with_output().map_err(|error| error.to_string())
}

fn probe_version(stdout: &str) -> Option<String> {
    let line = stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    Some(line.to_string())
}

fn port_is_open(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(400),
    )
    .is_ok()
}

#[tauri::command]
pub fn ssh_config_text() -> AppResult<SshConfigText> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::InvalidRequest("无法确定用户主目录".to_string()))?;
    let path = home.join(".ssh").join("config");
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    Ok(SshConfigText {
        path: path.to_string_lossy().into_owned(),
        content,
    })
}

#[tauri::command]
pub async fn ssh_probe(target: SshTargetInput) -> AppResult<SshProbeResult> {
    validated(&target)?;
    let remote_command = {
        let raw = target.remote_hermes_path.trim();
        if raw.is_empty() {
            "hermes --version".to_string()
        } else if raw.contains(' ') {
            return Err(AppError::InvalidRequest(
                "远端 hermes 路径不能包含空格".to_string(),
            ));
        } else {
            format!("{raw} --version")
        }
    };
    let host = target.host.trim().to_string();
    let args = base_args(&target);
    let command_line = format!("ssh {} {}", args.join(" "), remote_command);

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new("ssh");
        command.args(&args).arg(&remote_command);
        command.stdin(Stdio::null());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        crate::process_ext::hide_console_window(&mut command);
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => return Err(format!("无法启动 ssh 客户端：{error}")),
        };
        killed_output(child, PROBE_TIMEOUT)
    })
    .await
    .map_err(|error| AppError::InvalidRequest(error.to_string()))?;

    match outcome {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let ok = output.status.success();
            let mut result = SshProbeResult {
                ok,
                host,
                command: command_line,
                version: if ok { probe_version(&stdout) } else { None },
                error: None,
                stderr: stderr.clone(),
            };
            if !ok {
                let detail = stderr
                    .lines()
                    .map(str::trim)
                    .find(|line| !line.is_empty())
                    .unwrap_or("SSH 命令执行失败")
                    .to_string();
                result.error = Some(detail);
            }
            Ok(result)
        }
        Err(error) => Ok(SshProbeResult {
            ok: false,
            host,
            command: command_line,
            version: None,
            error: Some(error),
            stderr: String::new(),
        }),
    }
}

#[tauri::command]
pub async fn ssh_tunnel_open(input: SshTunnelOpenInput) -> AppResult<SshTunnelResult> {
    validated(&input.target)?;
    let id = input.id.trim().to_string();
    if id.is_empty() {
        return Err(AppError::InvalidRequest("隧道标识不能为空".to_string()));
    }

    ssh_tunnel_close(SshTunnelCloseInput { id: id.clone() })?;

    let local_port = if input.local_port == 0 {
        TcpListener::bind("127.0.0.1:0")
            .and_then(|listener| listener.local_addr())
            .map_err(|error| AppError::InvalidRequest(format!("无法分配本地端口：{error}")))?
            .port()
    } else {
        input.local_port
    };
    let remote_port = if input.target.remote_port == 0 {
        default_hermes_port()
    } else {
        input.target.remote_port
    };

    let mut args = base_args(&input.target);
    let forward = format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}");
    let host_index = args.len() - 1;
    let host_arg = args.remove(host_index);
    args.insert(0, "-N".to_string());
    args.insert(1, "-o".to_string());
    args.insert(2, "ExitOnForwardFailure=yes".to_string());
    args.insert(3, "-L".to_string());
    args.insert(4, forward.clone());
    args.push(host_arg);

    let mut command = Command::new("ssh");
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    crate::process_ext::hide_console_window(&mut command);
    let child = command
        .spawn()
        .map_err(|error| AppError::InvalidRequest(format!("无法启动 ssh 客户端：{error}")))?;
    let pid = child.id();

    {
        let mut guard = tunnels()
            .lock()
            .map_err(|_| AppError::InvalidRequest("隧道表不可用".to_string()))?;
        guard.insert(id.clone(), child);
    }

    let started = Instant::now();
    loop {
        if port_is_open(local_port) {
            break;
        }
        let exited = {
            let mut guard = tunnels()
                .lock()
                .map_err(|_| AppError::InvalidRequest("隧道表不可用".to_string()))?;
            match guard.get_mut(&id) {
                Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                None => true,
            }
        };
        if exited {
            let stderr = take_tunnel_stderr(&id);
            return Err(AppError::InvalidRequest(format!(
                "SSH 隧道未能建立：{}",
                if stderr.is_empty() {
                    "ssh 进程已退出".to_string()
                } else {
                    stderr
                }
            )));
        }
        if started.elapsed() > TUNNEL_READY_TIMEOUT {
            let _ = ssh_tunnel_close(SshTunnelCloseInput { id: id.clone() });
            return Err(AppError::InvalidRequest(
                "SSH 隧道建立超时，请检查主机、密钥与远端端口".to_string(),
            ));
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    Ok(SshTunnelResult {
        id,
        local_port,
        remote_url: format!("http://127.0.0.1:{local_port}"),
        pid,
    })
}

fn take_tunnel_stderr(id: &str) -> String {
    let mut child = {
        let mut guard = match tunnels().lock() {
            Ok(guard) => guard,
            Err(_) => return String::new(),
        };
        match guard.remove(id) {
            Some(child) => child,
            None => return String::new(),
        }
    };
    let mut buffer = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let mut raw = Vec::new();
        let _ = stderr.read_to_end(&mut raw);
        buffer = String::from_utf8_lossy(&raw)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
    }
    let _ = child.kill();
    let _ = child.wait();
    buffer
}

#[tauri::command]
pub fn ssh_tunnel_close(input: SshTunnelCloseInput) -> AppResult<bool> {
    let removed = {
        let mut guard = tunnels()
            .lock()
            .map_err(|_| AppError::InvalidRequest("隧道表不可用".to_string()))?;
        guard.remove(input.id.trim())
    };
    if let Some(mut child) = removed {
        let _ = child.kill();
        let _ = child.wait();
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
pub fn ssh_tunnel_list() -> AppResult<Vec<SshTunnelEntry>> {
    let mut guard = tunnels()
        .lock()
        .map_err(|_| AppError::InvalidRequest("隧道表不可用".to_string()))?;
    let mut entries = Vec::new();
    for (id, child) in guard.iter_mut() {
        if matches!(child.try_wait(), Ok(Some(_))) {
            continue;
        }
        entries.push(SshTunnelEntry {
            id: id.clone(),
            pid: child.id(),
        });
    }
    Ok(entries)
}
