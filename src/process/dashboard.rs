// Dashboard probing for an external Hermes kernel.
//
// The desktop never spawns, adopts or terminates the kernel any more: it only
// probes the configured URL, reads the served session token and builds the
// gateway URL. Ownership (start/stop) belongs to whoever runs the kernel.

use std::net::{TcpStream, ToSocketAddrs};
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;

const PROBE_TIMEOUT: Duration = Duration::from_millis(900);
const SESSION_TOKEN_TIMEOUT: Duration = Duration::from_secs(3);
const ATTACHED_DASHBOARD_TIMEOUT: Duration = Duration::from_secs(5);
pub const DEFAULT_DESKTOP_DASHBOARD_PORT: u16 = 9119;
static SESSION_TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"__HERMES_SESSION_TOKEN__="([^"]+)""#).expect("valid session token regex")
});
static PROBE_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .expect("valid dashboard probe HTTP client")
});
static SESSION_TOKEN_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(SESSION_TOKEN_TIMEOUT)
        .build()
        .expect("valid dashboard session token HTTP client")
});
static ATTACHED_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(ATTACHED_DASHBOARD_TIMEOUT)
        .build()
        .expect("valid attached dashboard HTTP client")
});


/// Build the base URL for a dashboard at the given host and port.
pub fn dashboard_base_url(host: &str, port: u16) -> String {
    format!("http://{}:{}", host, port)
}

fn probe_dashboard_port(api_base_url: &str) -> bool {
    let parsed = match url::Url::parse(api_base_url) {
        Ok(url) => url,
        Err(err) => {
            log::debug!("Invalid dashboard probe URL {}: {}", api_base_url, err);
            return false;
        }
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let port = parsed.port_or_known_default().unwrap_or(80);
    let Some(addr) = (host, port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| addrs.next())
    else {
        return false;
    };
    TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).is_ok()
}

/// Check if a compatible dashboard status endpoint is reachable at the given
/// base URL. Returns true if /api/status responds with 2xx or 401.
pub async fn probe_dashboard(api_base_url: &str) -> bool {
    let url = format!("{}/api/status", api_base_url);

    match PROBE_HTTP_CLIENT
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(res) => res.status().is_success() || res.status().as_u16() == 401,
        Err(_) => false,
    }
}

/// More tolerant probe for an already-running local/remote dashboard we do not
/// own. The normal readiness probe is intentionally short, but a user CLI
/// dashboard can briefly spend more
/// than 900ms in `/api/status` while spawning TUI sidecars or loading plugins.
/// Treat that as transient instead of reporting "9119 unreachable".
pub async fn probe_attached_dashboard(api_base_url: &str) -> bool {
    let url = format!("{}/api/status", api_base_url);

    for attempt in 0..3 {
        match ATTACHED_HTTP_CLIENT
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(res) if res.status().is_success() || res.status().as_u16() == 401 => {
                return true;
            }
            Ok(res) => {
                log::debug!(
                    "Attached dashboard probe at {} returned HTTP {}",
                    api_base_url,
                    res.status()
                );
            }
            Err(err) => {
                log::debug!(
                    "Attached dashboard probe attempt {} at {} failed: {}",
                    attempt + 1,
                    api_base_url,
                    err
                );
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    if probe_dashboard_port(api_base_url) {
        log::warn!(
            "Attached dashboard port is listening at {}, but /api/status did not answer within {:?}",
            api_base_url,
            ATTACHED_DASHBOARD_TIMEOUT
        );
    }
    false
}

/// Probe the upstream-native `/api/ws` gateway by actually completing a
/// WebSocket handshake (the route is a WS upgrade, so it never appears in
/// openapi.json — an HTTP GET can't verify it). The connection is dropped
/// immediately after the handshake; the server reaps the orphan transport.
pub async fn dashboard_supports_ws(api_base_url: &str, token: Option<&str>) -> bool {
    dashboard_supports_ws_url(&build_gateway_url(api_base_url, token)).await
}

/// WS handshake probe for a gated gateway using a freshly-minted ticket.
pub async fn dashboard_supports_ws_ticket(api_base_url: &str, ticket: &str) -> bool {
    dashboard_supports_ws_url(&build_gateway_ws_url_with_ticket(api_base_url, ticket)).await
}

async fn dashboard_supports_ws_url(url: &str) -> bool {
    matches!(
        tokio::time::timeout(
            std::time::Duration::from_secs(4),
            tokio_tungstenite::connect_async(url.to_string()),
        )
        .await,
        Ok(Ok(_))
    )
}

/// Get the HERMES_HOME value from a running dashboard.
pub async fn fetch_dashboard_hermes_home(api_base_url: &str) -> Option<String> {
    let url = format!("{}/api/status", api_base_url);

    let res = PROBE_HTTP_CLIENT
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .ok()?;
    let data: serde_json::Value = res.json().await.ok()?;
    data.get("hermes_home")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Tolerant HERMES_HOME lookup for attached local dashboards. This mirrors
/// `probe_attached_dashboard` so a busy CLI dashboard does not make the
/// desktop treat the kernel as unreachable.
pub async fn fetch_attached_dashboard_hermes_home(api_base_url: &str) -> Option<String> {
    let url = format!("{}/api/status", api_base_url);

    for attempt in 0..3 {
        match ATTACHED_HTTP_CLIENT
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(res) => match res.json::<serde_json::Value>().await {
                Ok(data) => {
                    if let Some(home) = data
                        .get("hermes_home")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                        .filter(|s| !s.trim().is_empty())
                    {
                        return Some(home);
                    }
                }
                Err(err) => {
                    log::debug!(
                        "Attached dashboard hermes_home parse attempt {} at {} failed: {}",
                        attempt + 1,
                        api_base_url,
                        err
                    );
                }
            },
            Err(err) => {
                log::debug!(
                    "Attached dashboard hermes_home attempt {} at {} failed: {}",
                    attempt + 1,
                    api_base_url,
                    err
                );
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    None
}

/// Fetch the session token from the dashboard's HTML page.
/// The token is embedded as `__HERMES_SESSION_TOKEN__="<token>"`.
pub async fn fetch_session_token(api_base_url: &str) -> Option<String> {
    let url = format!("{}/", api_base_url);

    let res = SESSION_TOKEN_HTTP_CLIENT
        .get(&url)
        .header("Accept", "text/html")
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let html = res.text().await.ok()?;
    SESSION_TOKEN_RE.captures(&html).map(|c| c[1].to_string())
}

/// Build a WebSocket gateway URL from the dashboard API base URL.
pub fn build_gateway_url(api_base_url: &str, token: Option<&str>) -> String {
    let ws_url = api_base_url
        .replace("http://", "ws://")
        .replace("https://", "wss://");
    match token {
        Some(t) => format!(
            "{}/api/ws?token={}",
            ws_url.trim_end_matches('/'),
            urlencoding::encode(t)
        ),
        None => format!("{}/api/ws", ws_url.trim_end_matches('/')),
    }
}

/// Build the gated `/api/ws?ticket=` URL for an OAuth remote. Mirrors the
/// official desktop's `buildGatewayWsUrlWithTicket`; the ticket is single-use
/// and short-lived, so callers mint a fresh one per (re)connect.
pub fn build_gateway_ws_url_with_ticket(api_base_url: &str, ticket: &str) -> String {
    let ws_url = api_base_url
        .replace("http://", "ws://")
        .replace("https://", "wss://");
    format!(
        "{}/api/ws?ticket={}",
        ws_url.trim_end_matches('/'),
        urlencoding::encode(ticket)
    )
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| crate::util::str_is_truthy(&value))
        .unwrap_or(false)
}

pub fn external_agent_allowed() -> bool {
    if env_flag("HERMES_DESKTOP_ALLOW_EXTERNAL_AGENT")
        || env_flag("HERMES_DESKTOP_DEV_EXTERNAL_DASHBOARD")
    {
        log::warn!(
            "Ignoring external desktop-agent flags; the desktop always attaches to the configured kernel"
        );
    }
    false
}

pub fn dev_external_dashboard_enabled() -> bool {
    if env_flag("HERMES_DESKTOP_DEV_EXTERNAL_DASHBOARD") {
        log::warn!(
            "Ignoring HERMES_DESKTOP_DEV_EXTERNAL_DASHBOARD; the desktop always attaches to the configured kernel"
        );
    }
    false
}
