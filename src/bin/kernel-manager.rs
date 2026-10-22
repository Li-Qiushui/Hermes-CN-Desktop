use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

use hermes_agent_cn::kernel_managed::{
    self, ensure_kernel, kill_owned_tree, ledger_path, parse_ledger,
    pick_candidates, probe_kernel, spawn_serve_with_log, wait_for_ready, KernelHandle, ReadyOutcome,
    READY_MARKER, READY_TIMEOUT,
};

fn log_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("HERMES_KERNEL_LOG_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    hermes_agent_cn::process::data_dir::data_dir().join("kernel-logs")
}

fn print_json(value: serde_json::Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())
    );
}

fn handle_json(handle: &KernelHandle) -> serde_json::Value {
    serde_json::json!({
        "host": handle.host,
        "port": handle.port,
        "pid": handle.pid,
        "owned": handle.owned,
        "baseUrl": handle.base_url(),
        "token": handle.token,
    })
}

fn ledger_snapshot() -> serde_json::Value {
    let path = ledger_path();
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|_| "[]".to_string());
    serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!([]))
}

fn ledger_len(value: &serde_json::Value) -> usize {
    value.as_array().map(|items| items.len()).unwrap_or(0)
}

async fn cmd_ensure() -> Result<(), String> {
    let dir = log_dir();
    let ledger_before = ledger_snapshot();
    let (handle, ownership) = ensure_kernel(None, &dir).await.map_err(|e| e.to_string())?;
    let ledger_after = ledger_snapshot();
    let status = kernel_managed::kernel_status();

    print_json(serde_json::json!({
        "ownership": ownership.as_str(),
        "mode": status.mode,
        "handle": handle_json(&handle),
        "restarts": status.restarts,
        "lastError": status.last_error,
        "logDir": dir.to_string_lossy(),
        "ledgerEntriesBefore": ledger_len(&ledger_before),
        "ledgerEntriesAfter": ledger_len(&ledger_after),
        "ledgerGrew": ledger_len(&ledger_after) > ledger_len(&ledger_before),
    }));
    Ok(())
}

async fn cmd_status() -> Result<(), String> {
    let path = ledger_path();
    let raw = std::fs::read_to_string(&path).unwrap_or_default();
    let entries = parse_ledger(&raw);
    let candidates = pick_candidates(entries.clone());

    let mut probed = Vec::new();
    for entry in &candidates {
        let token = probe_kernel(&entry.host, entry.port).await;
        probed.push(serde_json::json!({
            "pid": entry.pid,
            "host": entry.host,
            "port": entry.port,
            "purpose": entry.purpose,
            "registeredAt": entry.registered_at,
            "isolated": entry.isolated,
            "reachable": token.is_some(),
            "tokenChars": token.map(|value| value.chars().count()).unwrap_or(0),
        }));
    }

    print_json(serde_json::json!({
        "ledgerPath": path.to_string_lossy(),
        "ledgerEntries": entries.len(),
        "candidates": probed,
        "status": kernel_managed::kernel_status(),
    }));
    Ok(())
}

async fn cmd_spawn_test() -> Result<(), String> {
    let dir = log_dir();
    let (mut child, log_path) = spawn_serve_with_log(0, &dir).map_err(|e| e.to_string())?;
    let pid = child.id().ok_or_else(|| "子进程没有 pid".to_string())?;

    let outcome = wait_for_ready(&mut child, &log_path, READY_TIMEOUT).await;
    let result = match outcome {
        ReadyOutcome::Ready { port, .. } => {
            let token = probe_kernel("127.0.0.1", port).await;
            let spawned = serde_json::json!({
                "pid": pid,
                "port": port,
                "readyMarker": READY_MARKER,
                "tokenFound": token.is_some(),
                "log": log_path.to_string_lossy(),
            });
            let kill = kill_owned_tree(pid);
            tokio::time::sleep(Duration::from_millis(800)).await;
            let alive = kernel_managed::is_process_alive(pid);
            let kill_label = match &kill {
                Ok(()) => "ok".to_string(),
                Err(err) => err.to_string(),
            };
            serde_json::json!({
                "spawned": spawned,
                "kill": kill_label,
                "aliveAfterKill": alive,
                "residualProcess": alive,
            })
        }
        ReadyOutcome::Exited {
            already_served,
            tail,
        } => {
            let _ = child.kill().await;
            serde_json::json!({
                "pid": pid,
                "error": "exited-before-ready",
                "alreadyServed": already_served,
                "tail": tail,
            })
        }
        ReadyOutcome::TimedOut { tail } => {
            let _ = kill_owned_tree(pid);
            serde_json::json!({ "pid": pid, "error": "timeout", "tail": tail })
        }
    };

    print_json(result);
    Ok(())
}

async fn cmd_supervise() -> Result<(), String> {
    let dir = log_dir();
    let (handle, ownership) = ensure_kernel(None, &dir).await.map_err(|e| e.to_string())?;
    let mut last = String::new();
    loop {
        let status = kernel_managed::kernel_status();
        let line = format!(
            "{} mode={} port={:?} pid={:?} restarts={} lastError={:?}",
            ownership.as_str(),
            status.mode,
            status.port,
            status.pid,
            status.restarts,
            status.last_error
        );
        if line != last {
            println!("{}", line);
            let _ = std::io::stdout().flush();
            last = line;
        }
        if status.mode == "gave_up" {
            println!("supervise: gave up, kernel {} untouched", handle.base_url());
            let _ = std::io::stdout().flush();
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "status".to_string());
    let result = match command.as_str() {
        "ensure" => cmd_ensure().await,
        "status" => cmd_status().await,
        "spawn-test" => cmd_spawn_test().await,
        "supervise" => cmd_supervise().await,
        other => Err(format!(
            "未知子命令：{}（可用：ensure | status | spawn-test | supervise）",
            other
        )),
    };
    if let Err(err) = result {
        eprintln!("kernel-manager: {}", err);
        std::process::exit(1);
    }
    std::process::exit(0);
}
