export type KernelMode =
  | "attached"
  | "spawned"
  | "remote"
  | "restarting"
  | "gave_up"
  | "failed"
  | "degraded"
  | (string & {});

export type RuntimeStatusPhase =
  | "starting"
  | "starting-dashboard"
  | "ready"
  | "degraded"
  | "error"
  | (string & {});

export const KERNEL_MODE_DEGRADED = "degraded";

export interface KernelStatusView {
  mode: KernelMode;
  baseUrl?: string | null;
  host?: string | null;
  port?: number | null;
  pid?: number | null;
  restarts?: number;
  portFallback?: boolean;
  lastError?: string | null;
}

export type KernelTone = "ok" | "warn" | "err";

export interface KernelStatusLine {
  tone: KernelTone;
  label: string;
  text: string;
  title: string;
}

function endpoint(status: KernelStatusView): string {
  if (status.host && status.port) return `${status.host}:${status.port}`;
  if (status.baseUrl) {
    try {
      return new URL(status.baseUrl).host;
    } catch {
      return status.baseUrl;
    }
  }
  return "—";
}

export function kernelEndpoint(status: KernelStatusView | null | undefined): string {
  return status ? endpoint(status) : "—";
}

export function kernelModeText(mode: string | null | undefined): string {
  switch (mode) {
    case "attached":
      return "已接管已有内核";
    case "spawned":
      return "桌面端启动";
    case "remote":
      return "远程 Hermes";
    case "restarting":
      return "重启中";
    case "gave_up":
      return "已停止重启";
    case "failed":
      return "启动失败";
    case "degraded":
      return "内核异常（已降级）";
    default:
      return mode?.trim() ? mode : "未接管";
  }
}

export function isKernelDegraded(status: KernelStatusView | null | undefined): boolean {
  return status?.mode === KERNEL_MODE_DEGRADED;
}

export function isKernelPortFallback(status: KernelStatusView | null | undefined): boolean {
  return status?.portFallback === true;
}

export const KERNEL_RETRY_QUERY_KEY = ["kernel-status"] as const;

export function isKernelReadyMode(mode: string | null | undefined): boolean {
  return mode === "attached" || mode === "spawned" || mode === "remote";
}

export interface KernelRuntimeSync {
  ready: boolean;
  baseUrlChanged: boolean;
  previousBaseUrl: string | null;
  baseUrl: string | null;
}

function runtimeBaseUrl(config: NonNullable<Window["__HERMES_RUNTIME__"]>): string | null {
  const api = (config.apiBaseUrl ?? "").trim();
  if (api) return api;
  const dashboard = (config.dashboardApiBaseUrl ?? "").trim();
  return dashboard || null;
}

export interface KernelRuntimeSyncOptions {
  refreshDegradedReason?: boolean;
}

export function syncKernelRuntime(
  status: KernelStatusView | null | undefined,
  options: KernelRuntimeSyncOptions = {},
): KernelRuntimeSync {
  const outcome: KernelRuntimeSync = {
    ready: false,
    baseUrlChanged: false,
    previousBaseUrl: null,
    baseUrl: null,
  };
  if (typeof window === "undefined") return outcome;
  const config = window.__HERMES_RUNTIME__;
  if (!config || !status?.mode) return outcome;

  if (isKernelReadyMode(status.mode)) {
    outcome.ready = true;
    config.backendDegraded = false;
    config.backendDegradedReason = undefined;
    const next = status.baseUrl?.trim();
    if (!next) return outcome;
    outcome.baseUrl = next;
    const previous = runtimeBaseUrl(config);
    outcome.previousBaseUrl = previous;
    if (previous === next) {
      config.dashboardApiBaseUrl = next;
      return outcome;
    }
    outcome.baseUrlChanged = true;
    if ((config.apiBaseUrl ?? "").trim()) config.apiBaseUrl = next;
    config.dashboardApiBaseUrl = next;
    return outcome;
  }

  if (status.mode === KERNEL_MODE_DEGRADED) {
    config.backendDegraded = true;
    if (options.refreshDegradedReason || !config.backendDegradedReason) {
      config.backendDegradedReason = status.lastError ?? undefined;
    }
  }
  return outcome;
}

export interface KernelRetryOutcome {
  ok: boolean;
  text: string;
}

export function describeKernelRetry(status: KernelStatusView | null | undefined): KernelRetryOutcome {
  if (!status?.mode) return { ok: false, text: "重新拉起内核没有返回状态" };
  if (isKernelReadyMode(status.mode)) return { ok: true, text: "内核已启动" };
  const preview = kernelErrorPreview(status.lastError ?? "");
  return { ok: false, text: preview ? `内核仍未启动：${preview}` : "内核仍未启动" };
}

export interface KernelRetrySync {
  status: KernelStatusView;
  sync: KernelRuntimeSync;
}

export async function retryKernelSync(): Promise<KernelRetrySync | null> {
  if (typeof window === "undefined") return null;
  const invoke = window.hermesDesktop?.retryKernel;
  if (typeof invoke !== "function") return null;

  let next: KernelStatusView;
  try {
    next = await invoke();
  } catch {
    return null;
  }
  if (!next || typeof next.mode !== "string") return null;

  const sync = syncKernelRuntime(next, { refreshDegradedReason: true });
  const config = window.__HERMES_RUNTIME__;
  if (config && sync.ready) config.backendReady = true;

  return { status: next, sync };
}

export async function retryKernel(): Promise<KernelStatusView | null> {
  const result = await retryKernelSync();
  return result ? result.status : null;
}

export function kernelErrorPreview(error: string | null | undefined, max = 120): string {
  const compact = (error ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

export function connectionTargetLabel(remote: boolean): string {
  return remote ? "远程 Hermes" : "本机内核";
}

export function kernelRestartDisabledReason(
  status: KernelStatusView | null | undefined,
): string | null {
  if (!status?.mode) return "内核状态尚未返回，暂时无法重启";
  switch (status.mode) {
    case "attached":
      return "内核由其它进程启动，桌面端不会杀它";
    case "remote":
      return "远程 Hermes 不受桌面端管理";
    case "restarting":
      return "内核正在重启，稍后自动完成";
    case "failed":
    case "gave_up":
      return "内核未在运行，请重新启动桌面端";
    case "degraded":
      return null;
    case "spawned":
      return null;
    default:
      return "当前内核状态不支持重启";
  }
}

export function describeKernelStatus(
  status: KernelStatusView | null | undefined,
): KernelStatusLine {
  if (!status || !status.mode) {
    const error = status?.lastError?.trim();
    return error
      ? { tone: "warn", label: "内核", text: `未接管 · ${error}`, title: error }
      : { tone: "warn", label: "内核", text: "未接管 · 等待桌面端准备", title: "kernel_status 尚未返回" };
  }

  const where = endpoint(status);
  const restarts = status.restarts ?? 0;
  const error = status.lastError?.trim();

  switch (status.mode) {
    case "attached":
      return {
        tone: "ok",
        label: "内核",
        text: `已接管 · ${where}`,
        title: `attached ${where}${status.pid ? ` pid=${status.pid}` : ""}`,
      };
    case "spawned":
      return {
        tone: "ok",
        label: "内核",
        text: `CN 启动 · ${where}${status.pid ? ` · pid ${status.pid}` : ""}`,
        title: `spawned ${where}${status.pid ? ` pid=${status.pid}` : ""}`,
      };
    case "remote":
      return {
        tone: "ok",
        label: "内核",
        text: `远程 ${where}`,
        title: `remote ${where}`,
      };
    case "restarting":
      return {
        tone: "warn",
        label: "内核",
        text: `重启中 · 第 ${restarts} 次${error ? ` · ${error}` : ""}`,
        title: error ?? `restarting ${restarts}`,
      };
    case "gave_up":
      return {
        tone: "err",
        label: "内核",
        text: `已停止重启${error ? ` · ${error}` : ""}`,
        title: error ?? "gave_up",
      };
    case "failed":
      return {
        tone: "err",
        label: "内核",
        text: error ? `启动失败 · ${error}` : "启动失败",
        title: error ?? "failed",
      };
    case "degraded":
      return {
        tone: "warn",
        label: "内核",
        text: `内核异常 · 已降级${where !== "—" ? ` · ${where}` : ""}`,
        title: error ?? `degraded ${where}`,
      };
    default:
      return {
        tone: error ? "warn" : "ok",
        label: "内核",
        text: error ? `${status.mode} · ${error}` : status.mode,
        title: error ?? status.mode,
      };
  }
}
