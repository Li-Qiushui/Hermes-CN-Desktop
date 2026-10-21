// Shared application state, passed to every Tauri command via tauri::State<AppState>.
//
// All mutable fields live behind a Mutex. Contention is low because IPC calls
// come from a single renderer and are mostly sequential.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::sync::Mutex;
use tokio::sync::mpsc;
use tokio::sync::Notify;

use crate::connection::ConnectionMode;

/// Handle to the live Rust→runtime `/api/ws` relay (see commands/ws_proxy.rs).
/// Holds only std/tokio types so this module stays decoupled from the WS crate.
pub struct GatewayWsHandle {
    /// Per-connection id; relay events are tagged with it so a stale relay from
    /// a prior connection can't deliver into a freshly-opened socket's shim.
    pub connection_id: String,
    /// Outbound text frames pushed by `gateway_ws_send` → the writer task.
    pub tx: mpsc::UnboundedSender<String>,
    /// Set to stop the reader/writer tasks (checked at each loop iteration).
    pub abort: Arc<AtomicBool>,
    /// Wakes the reader/writer tasks so they observe `abort` promptly.
    pub notify: Arc<Notify>,
}

/// Process-lifetime browser companion endpoint. The bearer token is distinct
/// from the dashboard credential and is accepted only by the loopback server.
#[derive(Clone)]
pub struct BrowserCompanionHandle {
    pub port: u16,
    pub token: String,
}

/// Handle to the external Hermes kernel this desktop is attached to.
///
/// The desktop never owns the process, so there is nothing to stop or reap on
/// shutdown: this only records where the kernel lives and how it authenticates.
#[derive(Clone)]
pub struct DashboardHandle {
    /// Base URL of the kernel API (e.g. "http://127.0.0.1:9119").
    pub api_base_url: String,
    /// Session token known by this desktop process for the kernel.
    pub session_token: Option<String>,
    /// Loopback (`Local`) or another host (`Remote`).
    pub mode: ConnectionMode,
    /// Authenticated through a cookie/OAuth session instead of a token.
    pub oauth: bool,
}

impl DashboardHandle {
    /// Attach to a remote kernel with a session token.
    pub fn remote(api_base_url: String, session_token: String) -> Self {
        Self {
            api_base_url,
            session_token: Some(session_token),
            mode: ConnectionMode::Remote,
            oauth: false,
        }
    }

    /// Attach to a gated remote kernel authenticated by an OAuth/cookie
    /// session (managed by `oauth_session`, not a token here).
    pub fn remote_oauth(api_base_url: String) -> Self {
        Self {
            api_base_url,
            session_token: None,
            mode: ConnectionMode::Remote,
            oauth: true,
        }
    }

    /// Attach to a loopback kernel.
    pub fn local(api_base_url: String, session_token: Option<String>) -> Self {
        Self {
            api_base_url,
            session_token,
            mode: ConnectionMode::Local,
            oauth: false,
        }
    }
}

/// Interior mutable state shared across all Tauri commands.
pub struct AppStateInner {
    pub api_base_url: String,
    pub gateway_url: String,
    pub hermes_home: String,
    /// The root hermes-home (before profile sub-directory resolution).
    pub hermes_home_base: String,
    pub session_token: Option<String>,
    pub current_profile: String,
    pub dashboard_handle: Option<DashboardHandle>,
    /// The live Rust→runtime `/api/ws` relay connection, when the webview is
    /// on the relay socket path. `None` on webview-direct WS or before the
    /// first relay connect.
    pub gateway_ws: Option<GatewayWsHandle>,
    /// Lazily started when the user chooses “在浏览器中打开社区桌面版”.
    pub browser_companion: Option<BrowserCompanionHandle>,
    pub last_runtime_error: Option<String>,
    /// Whether the attached kernel is on this machine (loopback) or another
    /// host. Commands consult it to decide which local-only capabilities are
    /// allowed and how the token is refreshed.
    pub connection_mode: ConnectionMode,
    /// Live OAuth/cookie session for a gated remote gateway, when the backend
    /// authenticates via OAuth. REST and WS both consult this to pick the
    /// cookie-aware client and mint WS tickets.
    pub oauth_session: Option<std::sync::Arc<crate::oauth_session::OauthSession>>,
    /// Debounce marker for `connection-auth-expired` emits (a burst of 401s
    /// must not storm the UI with re-login banners).
    pub last_auth_expired_emit: Option<std::time::Instant>,
    /// Set while a Track B UI hot update (install/rollback) is in flight.
    /// Guards against two threads extracting/activating UI packages at once.
    pub ui_update_in_flight: bool,
}

/// A snapshot of how the currently-connected dashboard authenticates, taken
/// once inside the state lock so each command can drop the guard before doing
/// async I/O. Token variant carries the shared session token; Oauth variant
/// carries the shared cookie session.
#[derive(Clone)]
pub enum DashboardAuth {
    Token(Option<String>),
    Oauth(std::sync::Arc<crate::oauth_session::OauthSession>),
}

impl AppStateInner {
    /// Snapshot the current auth strategy for use outside the lock.
    pub fn dashboard_auth(&self) -> DashboardAuth {
        match &self.oauth_session {
            Some(session) => DashboardAuth::Oauth(session.clone()),
            None => DashboardAuth::Token(self.session_token.clone()),
        }
    }
}

/// Thread-safe wrapper. Tauri manages this via `app.manage(AppState::new())`.
pub struct AppState {
    pub inner: Mutex<AppStateInner>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(AppStateInner {
                api_base_url: String::new(),
                gateway_url: String::new(),
                hermes_home: String::new(),
                hermes_home_base: String::new(),
                session_token: None,
                current_profile: "default".to_string(),
                dashboard_handle: None,
                gateway_ws: None,
                browser_companion: None,
                last_runtime_error: None,
                connection_mode: ConnectionMode::Local,
                oauth_session: None,
                last_auth_expired_emit: None,
                ui_update_in_flight: false,
            }),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
