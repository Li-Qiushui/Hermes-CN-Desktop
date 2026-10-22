import { runtime } from "./runtime";
import { EXPECTED_BACKEND_VERSION } from "./build-info";
import type { ConnectionMode } from "@hermes/protocol";

export interface BackendVersionInfo {
  version: string;
  name?: string;
}

export type BackendRecoveryReason =
  | "managed-runtime-offline"
  | "external-backend-unreachable"
  | "external-backend-auth-required";

export type VersionCheckState =
  | { kind: "unchecked" }
  | { kind: "deferred"; reason: BackendRecoveryReason }
  | { kind: "ok"; backendVersion: string }
  | { kind: "mismatch"; backendVersion: string; expectedVersion: string }
  | { kind: "unavailable"; reason: string };

export interface VersionCheckOptions {
  connectionMode?: ConnectionMode;
  expectedVersion?: string;
}

let state: VersionCheckState = { kind: "unchecked" };

/**
 * Kernel version recorded from the managed runtime install record (set by the
 * runtime/app-update hooks). When present it is the preferred expected version
 * for the unified self-update flow — after a backend update the kernel is
 * verified against the manifest version, and the baked constant is only the
 * build-time fallback.
 */
let runtimeKernelVersion: string | null = null;

export function recordRuntimeKernelVersion(version: string | null | undefined): void {
  runtimeKernelVersion = version?.trim() || null;
}

/** The backend version the frontend currently expects to connect to. */
export function expectedBackendVersion(): string {
  return runtimeKernelVersion ?? EXPECTED_BACKEND_VERSION;
}

export function getVersionCheckState(): VersionCheckState {
  return state;
}

export function resetVersionCheck(): void {
  state = { kind: "unchecked" };
  runtimeKernelVersion = null;
}

/**
 * Allow the recovery UI to mount while the user has explicitly stopped or
 * uninstalled the managed runtime. Runtime control results reset this state
 * before a subsequently started backend can serve REST or WebSocket traffic.
 */
export function deferBackendVersionCheckForOfflineRuntime(): void {
  state = { kind: "deferred", reason: "managed-runtime-offline" };
}

function isDevBypassEnabled(): boolean {
  try {
    return import.meta.env.DEV === true && import.meta.env.VITE_HERMES_SKIP_VERSION_CHECK === "1";
  } catch {
    return false;
  }
}

function parseBackendVersion(data: unknown): BackendVersionInfo {
  if (!data || typeof data !== "object" || typeof (data as { version?: unknown }).version !== "string") {
    throw new Error("backend version response missing version string");
  }
  return data as BackendVersionInfo;
}

class BackendVersionHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`HTTP ${status}: ${body}`);
  }
}

function isExternalConnection(mode: ConnectionMode | undefined): boolean {
  return mode === "local" || mode === "remote";
}

function ipcErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isExternalBackendUnreachable(error: unknown): boolean {
  const code = ipcErrorCode(error);
  if (code === "dashboard_unreachable") return true;

  // reqwest reports a response timeout as api_proxy/proxy_error rather than a
  // connect error. It is still an unreachable target from the recovery UI's
  // perspective, while all other proxy errors remain strict.
  return code === "proxy_error"
    && error instanceof Error
    && (error.message.includes("Request timed out")
      || error.message.includes("backend unreachable"));
}

/**
 * Fetch /api/version without going through the compatibility-gated transport
 * helper. Tauri must use its Rust HTTP proxy: release WebViews load from a
 * custom protocol origin (`hermesui:` on macOS/Linux and
 * `http://hermesui.localhost` on Windows), so a native browser fetch would be
 * rejected by the dashboard's intentionally narrow localhost CORS policy.
 */
async function fetchBackendVersion(apiBaseUrl?: string): Promise<BackendVersionInfo> {
  if (runtime.platform === "tauri") {
    const request = window.hermesDesktop?.request;
    if (!request) {
      throw new Error("desktop IPC bridge unavailable");
    }
    const response = await request({ path: "/api/version", method: "GET" });
    if (!response.ok) {
      throw new BackendVersionHttpError(response.status, response.body);
    }
    return parseBackendVersion(JSON.parse(response.body));
  }

  const url = apiBaseUrl
    ? `${apiBaseUrl.replace(/\/$/, "")}/api/version`
    : runtime.getApiUrl("/api/version");
  const response = await fetch(url);
  if (!response.ok) {
    throw new BackendVersionHttpError(response.status, await response.text());
  }
  return parseBackendVersion(await response.json());
}

/**
 * 探活容错：内核可能还在 bind，或 Rust 侧还没把地址写进状态（首次启动 / 绿色版）。
 * 这类「连不上」的错误值得退避重试几次，别第一次失败就把界面钉死在离线壳。
 */
function isRetryableProbeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return (
    message.includes("backend unreachable") ||
    message.includes("builder error") ||
    message.includes("connection refused") ||
    message.includes("error sending request") ||
    message.includes("client error (connect)") ||
    message.includes("no backend address")
  );
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchBackendVersionWithRetry(apiBaseUrl?: string, attempts = 3) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetchBackendVersion(apiBaseUrl);
    } catch (error) {
      lastError = error;
      if (!isRetryableProbeError(error) || attempt === attempts - 1) throw error;
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastError;
}

export async function verifyBackendVersion(
  apiBaseUrl?: string,
  options: VersionCheckOptions = {},
): Promise<VersionCheckState> {
  const expected = options.expectedVersion ?? expectedBackendVersion();
  if (runtime.platform === "web") {
    // Web/browser-companion mode: no managed runtime; skip the gate.
    state = { kind: "ok", backendVersion: "web" };
    return state;
  }

  if (isDevBypassEnabled()) {
    state = { kind: "ok", backendVersion: expected };
    return state;
  }

  try {
    const info = await fetchBackendVersionWithRetry(apiBaseUrl);
    if (info.version !== expected) {
      state = {
        kind: "mismatch",
        backendVersion: info.version,
        expectedVersion: expected,
      };
      return state;
    }
    state = { kind: "ok", backendVersion: info.version };
    return state;
  } catch (error) {
    // A reachable backend that does not implement /api/version (official
    // upstream kernels have no such endpoint) is perfectly usable — the
    // version gate simply cannot judge it. Returning "deferred" here made the
    // bridge treat the backend as not-ready and fall back to the offline shell,
    // so report it as ok with an unknown version instead.
    if (error instanceof BackendVersionHttpError && error.status === 404) {
      // Attached kernels (local CLI dashboard / remote shell) have no
      // /api/version endpoint at all — they are usable, the version gate just
      // cannot judge them. Reporting "deferred" here made the bridge mark the
      // backend as not-ready and fall back to the offline shell. A managed
      // runtime, by contrast, ships the endpoint, so a 404 there is a real fault.
      if (isExternalConnection(options.connectionMode)) {
        state = { kind: "ok", backendVersion: "unknown" };
        return state;
      }
      state = {
        kind: "unavailable",
        reason: "HTTP 404: /api/version missing on the managed runtime",
      };
      return state;
    }
    if (isExternalConnection(options.connectionMode)) {
      // A 401 here means the kernel answered — it just wants credentials we
      // never sent for this probe. Still an auth prompt, not a dead backend.
      if (error instanceof BackendVersionHttpError && (error.status === 401 || error.status === 403)) {
        state = { kind: "deferred", reason: "external-backend-auth-required" };
        return state;
      }
      if (isExternalBackendUnreachable(error)) {
        state = { kind: "deferred", reason: "external-backend-unreachable" };
        return state;
      }
    }
    state = {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
    return state;
  }
}

async function fatalErrorAndExit(title: string, message: string): Promise<never> {
  if (runtime.platform === "tauri" && window.hermesDesktop?.fatalErrorAndExit) {
    await window.hermesDesktop.fatalErrorAndExit({ title, message });
  } else {
    // Fallback for web/dev/non-Tauri contexts.
    if (typeof window.alert === "function") {
      window.alert(`${title}\n\n${message}`);
    }
    if (typeof window.close === "function") {
      window.close();
    }
  }
  // Defensive: if the dialog/close did not terminate the process, throw.
  throw new Error(`${title}: ${message}`);
}

/**
 * Turn the proxy's raw error into an actionable sentence: the proxy reports a
 * down/unset backend as "backend unreachable: ..." or as a reqwest connect
 * failure, and echoing "builder error" tells the user nothing.
 */
export function explainBackendReason(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes("backend unreachable") || lower.includes("builder error")) {
    return "桌面端还没有连上 Hermes 内核（后端地址为空或内核未启动）。请先在本机运行 `hermes dashboard --port 9119`，再点重试。";
  }
  if (
    lower.includes("error sending request") ||
    lower.includes("connection refused") ||
    lower.includes("client error (connect)")
  ) {
    return "连接 Hermes 内核失败（连接被拒绝）。请确认内核已在 9119 端口运行，再点重试。";
  }
  if (lower.includes("401") || lower.includes("unauthorized")) {
    return "Hermes 内核要求鉴权（401）。请在连接设置里填写内核 token，或确认本机 loopback 访问已放行。";
  }
  return reason;
}

export function assertCompatible(): void {
  if (state.kind === "ok" || state.kind === "deferred") return;

  // Web/browser-companion mode has no managed runtime; skip the gate.
  if (runtime.platform === "web") {
    state = { kind: "ok", backendVersion: "web" };
    return;
  }

  if (state.kind === "mismatch") {
    const message =
      `前端与后端版本不兼容。\n` +
      `前端期望后端版本：${state.expectedVersion}\n` +
      `后端实际版本：${state.backendVersion}\n\n` +
      `请升级 Hermes Agent CN Desktop 到与后端匹配的版本。`;
    void fatalErrorAndExit("版本不匹配", message);
    throw new Error(`backend version mismatch: expected ${state.expectedVersion}, got ${state.backendVersion}`);
  }

  if (state.kind === "unavailable") {
    // The backend does not expose the API (very old backend) or is unreachable.
    // For strict enforcement, treat this as a fatal error in Tauri builds.
    const message =
      `无法验证后端版本：${explainBackendReason(state.reason)}\n\n` +
      `请确认后端已启动，且与当前桌面端版本兼容。`;
    void fatalErrorAndExit("版本验证失败", message);
    throw new Error(`backend version unavailable: ${state.reason}`);
  }

  // unchecked: trigger the async verification. The current call must still
  // fail fast so callers don't proceed against an unchecked backend.
  void verifyBackendVersion(undefined, { connectionMode: runtime.getConnectionMode() }).then((s) => {
    if (s.kind !== "ok" && s.kind !== "deferred") assertCompatible();
  });
  throw new Error("backend version check has not completed");
}
