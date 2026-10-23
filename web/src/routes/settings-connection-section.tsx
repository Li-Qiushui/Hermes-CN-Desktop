import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  Cable,
  CheckCircle2,
  Cloud,
  ExternalLink,
  Globe2,
  MonitorSmartphone,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  ShieldOff,
  Terminal,
  XCircle,
} from "lucide-react";
import { StatusResponse } from "@hermes/protocol";
import type {
  AuthIdentity,
  AuthProviderInfo,
  ConnectionConfigInput,
  ConnectionConfigView,
  ConnectionMode,
  TestConnectionResult,
} from "@hermes/protocol";
import { Alert, Button, Input, LoadingIndicator } from "@hermes/shared-ui";
import { notifyConnectionAuthRestored } from "@/lib/connection-auth-events";
import {
  CONNECTION_KIND_LABELS,
  DEFAULT_CLOUD_URL,
  DEFAULT_SSH_TARGET,
  createConnectionId,
  hasSshErrors,
  nextConnectionName,
  readActiveConnectionId,
  readConnectionRegistry,
  removeAndPersist,
  sshTargetSummary,
  tokenRefFor,
  upsertAndPersist,
  validateSshTarget,
  writeActiveConnectionId,
  type GatewayMode,
  type SavedConnection,
  type SavedSshTarget,
  type SshValidationErrors,
} from "@/lib/connection-registry";
import { loadSshHosts, type SshHostEntry } from "@/lib/ssh-config";
import { ApiKeysSection } from "@/components/settings/connection/api-keys-section";
import { ConnectionModeCards } from "@/components/settings/connection/mode-cards";
import { DevicePanel } from "@/components/settings/connection/device-panel";
import { SavedConnectionsList } from "@/components/settings/connection/saved-connections";
import { SshTargetFields } from "@/components/settings/connection/ssh-target-fields";
import { closeSshTunnel, openSshTunnel, probeSshTarget } from "@/components/settings/connection/ssh-bridge";
import {
  getSecretStorageStatus,
  readConnectionToken,
  saveConnectionToken,
  type SecretStorageStatus,
} from "@/components/settings/connection/secret-store";
import c from "@/components/settings/connection/connection.module.css";
import {
  connectionTargetLabel,
  isKernelDegraded,
  kernelEndpoint,
  kernelErrorPreview,
  kernelModeText,
  kernelRestartDisabledReason,
} from "@/lib/kernel-status";
import type { KernelStatusView } from "@/lib/kernel-status";
import { runtime } from "@/lib/runtime";
import { fetchJSON, postJSON } from "@/lib/transport";
import { useKernelRetry, useKernelStatusSnapshot } from "@/hooks/use-kernel-status";
import { SettingsHero } from "./settings-hero";
import s from "./settings.module.css";

interface SettingsSectionProps {
  showHeading?: boolean;
  externalOnly?: boolean;
  onApplied?: (mode: ConnectionMode) => Promise<void> | void;
}

type ExternalTarget = GatewayMode;
type ProbeStatus = "idle" | "probing" | "reachable" | "unreachable" | "authRequired";
type ConnectionMessage = { tone: "ok" | "error"; text: string; hint?: string };
type PendingAction = { target: ExternalTarget; kind: "test" | "save" | "apply" };
type PanelTab = "connection" | "devices" | "keys";

interface DiagnosticsSnapshot {
  version: string;
  gatewayState: string;
  platforms: Array<{ name: string; state: string }>;
}

const PROBE_DEBOUNCE_MS = 500;
const DEFAULT_LOCAL_URL = "http://127.0.0.1:9119";
const LOCAL_DASHBOARD_RECOVERY_HINT =
  "本机内核由桌面端托管（启动时自动执行 hermes serve）。若内核没起来，先点「重启内核」；仍失败就看诊断里的 lastError。";

function modeLabel(mode: ConnectionMode | undefined): string {
  if (mode === "remote") return "远程 Hermes";
  if (mode === "local") return "本机内核 · 已接管本机实例";
  return "本机内核";
}

function ConnSection({
  icon: Icon,
  title,
  description,
  badge,
  children,
}: {
  icon: typeof Globe2;
  title: string;
  description: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={s.connSection} aria-label={title}>
      <header className={s.connSectionHead}>
        <Icon size={16} aria-hidden="true" />
        <div>
          <h3>
            {title}
            {badge}
          </h3>
          <p>{description}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

function Kv({
  label,
  value,
  tone,
  testId,
}: {
  label: string;
  value: ReactNode;
  tone?: "warn" | "error";
  testId?: string;
}) {
  return (
    <div className={s.connKv}>
      <span className={s.connKvLabel}>{label}</span>
      <span className={s.connKvValue} data-tone={tone} data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

function testResultSummary(result: TestConnectionResult): ConnectionMessage {
  if (result.ok) {
    const version = result.version ? ` · Hermes ${result.version}` : "";
    return { tone: "ok", text: `连接正常（${result.baseUrl}${version}）` };
  }
  const detail = result.error ?? "连接失败";
  const parts = [
    `接口 ${result.httpOk ? "✓" : `✗${result.httpStatus ? ` (${result.httpStatus})` : ""}`}`,
    `实时连接 ${result.wsOk ? "✓" : "✗"}`,
  ];
  return { tone: "error", text: `${detail}　[${parts.join("，")}]` };
}

function withLocalDashboardHint(message: ConnectionMessage, target: ExternalTarget): ConnectionMessage {
  if (target !== "local" || message.tone !== "error") return message;
  return { ...message, hint: LOCAL_DASHBOARD_RECOVERY_HINT };
}

function initialGatewayMode(): GatewayMode {
  if (typeof window === "undefined") return "local";
  return window.__HERMES_RUNTIME__?.connectionMode === "remote" ? "remote" : "local";
}

function modeFromConnectionMode(mode: ConnectionMode | undefined): GatewayMode {
  return mode === "remote" ? "remote" : "local";
}

/**
 * 内核降级提示：desktop 起不来本机内核、退回配置地址时置顶显示。
 * 只做展示 + 一个重试回调，方便单测直接渲染。
 */
export function KernelDegradedCallout({
  status,
  onRetry,
  retrying = false,
}: {
  status: KernelStatusView | null | undefined;
  onRetry: () => void;
  retrying?: boolean;
}) {
  if (!isKernelDegraded(status)) return null;
  const error = (status?.lastError ?? "").replace(/\s+/g, " ").trim();
  const endpointText = kernelEndpoint(status);
  return (
    <div className={s.connDegraded} role="status" data-testid="kernel-degraded-callout">
      <AlertTriangle size={16} aria-hidden="true" />
      <div className={s.connDegradedBody}>
        <div className={s.connDegradedTitle}>内核未启动 / 启动失败，已降级到手动连接</div>
        <div className={s.connDegradedText}>
          桌面端已退回配置地址{endpointText !== "—" ? ` ${endpointText}` : ""}
          ，本机会话与实时网关可能不可用。可以先「重新连接内核」重试启动，仍失败就看下方最近错误。
        </div>
        {error && (
          <div className={s.connDegradedError} title={error} data-testid="kernel-degraded-error">
            {kernelErrorPreview(error)}
          </div>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={onRetry}
        loading={retrying}
        disabled={retrying}
        leadingIcon={<RotateCcw size={12} />}
        data-testid="kernel-degraded-retry"
      >
        重新连接内核
      </Button>
    </div>
  );
}

export function ConnectionSection({
  showHeading = true,
  externalOnly = false,
  onApplied,
}: SettingsSectionProps) {
  const desktop = typeof window !== "undefined" ? window.hermesDesktop : undefined;
  const supported = Boolean(desktop?.getConnectionConfig);
  const browserCompanion = Boolean(window.__HERMES_RUNTIME__?.browserCompanion);
  const kernel = useKernelStatusSnapshot();
  const kernelStatus = kernel.status;
  const remoteTarget = kernelStatus ? kernelStatus.mode === "remote" : runtime.isRemote();

  const [config, setConfig] = useState<ConnectionConfigView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [localUrl, setLocalUrl] = useState(DEFAULT_LOCAL_URL);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [probeStatus, setProbeStatus] = useState<ProbeStatus>("idle");
  const probeSeq = useRef(0);
  const [authProviders, setAuthProviders] = useState<AuthProviderInfo[]>([]);
  const [identity, setIdentity] = useState<AuthIdentity | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [pwUser, setPwUser] = useState("");
  const [pwPass, setPwPass] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [openingBrowser, setOpeningBrowser] = useState(false);
  const [browserMessage, setBrowserMessage] = useState<ConnectionMessage | null>(null);
  const [message, setMessage] = useState<ConnectionMessage | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartMessage, setRestartMessage] = useState<ConnectionMessage | null>(null);
  const [diagNonce, setDiagNonce] = useState(0);
  const [diag, setDiag] = useState<DiagnosticsSnapshot | null>(null);
  const [diagError, setDiagError] = useState("");
  const [diagLoading, setDiagLoading] = useState(false);

  const [mode, setMode] = useState<GatewayMode>(() => initialGatewayMode());
  const modeTouched = useRef(false);
  const [panel, setPanel] = useState<PanelTab>("connection");
  const [sshTarget, setSshTarget] = useState<SavedSshTarget>({ ...DEFAULT_SSH_TARGET });
  const [sshErrors, setSshErrors] = useState<SshValidationErrors>({});
  const [sshHosts, setSshHosts] = useState<SshHostEntry[]>([]);
  const [sshConfigPath, setSshConfigPath] = useState<string | null>(null);
  const [sshConfigError, setSshConfigError] = useState("");
  const [sshHostsLoading, setSshHostsLoading] = useState(false);
  const [probeMessage, setProbeMessage] = useState<ConnectionMessage | null>(null);
  const [cloudUrl, setCloudUrl] = useState(DEFAULT_CLOUD_URL);
  const [registry, setRegistry] = useState<SavedConnection[]>(() => readConnectionRegistry());
  const [activeId, setActiveId] = useState<string | null>(() => readActiveConnectionId());
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [secretStatus, setSecretStatus] = useState<SecretStorageStatus | null>(null);

  const selectMode = (next: GatewayMode) => {
    modeTouched.current = true;
    setMode(next);
    setMessage(null);
    setProbeMessage(null);
  };

  const changeSshTarget = (patch: Partial<SavedSshTarget>) => {
    setSshTarget((current) => {
      const merged = { ...current, ...patch };
      if (patch.host !== undefined) {
        const entry = sshHosts.find((item) => item.aliases.includes(patch.host!.trim()));
        if (entry) {
          merged.user = entry.user ?? "";
          merged.port = entry.port ?? DEFAULT_SSH_TARGET.port;
          merged.keyPath = entry.identityFile ?? "";
        }
      }
      return merged;
    });
    setSshErrors({});
  };

  useEffect(() => {
    if (!supported) return;
    const desktopBridge = window.hermesDesktop;
    if (!desktopBridge?.windowType) return;
    setSshHostsLoading(true);
    loadSshHosts()
      .then((result) => {
        setSshHosts(result.hosts);
        setSshConfigPath(result.configPath);
        setSshConfigError(result.error ?? "");
      })
      .finally(() => setSshHostsLoading(false));
  }, [supported]);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void getSecretStorageStatus().then((status) => {
      if (!cancelled) setSecretStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, [supported]);

  useEffect(() => {
    if (!desktop?.getConnectionConfig) return;
    desktop
      .getConnectionConfig()
      .then((view) => {
        setConfig(view);
        setLocalUrl(view.localUrl || DEFAULT_LOCAL_URL);
        setRemoteUrl(view.remoteUrl);
      })
      .catch((error) => {
        setLoadError(error instanceof Error ? error.message : String(error));
      });
  }, [desktop, externalOnly]);

  const envOverride = config?.envOverride ?? false;
  const busy = pending !== null;
  const disabled = !supported || envOverride || busy || (externalOnly && !config);

  useEffect(() => {
    if (!config || modeTouched.current) return;
    setMode(modeFromConnectionMode(config.mode));
  }, [config]);

  const trimmedLocalUrl = localUrl.trim() || DEFAULT_LOCAL_URL;
  const trimmedRemoteUrl = remoteUrl.trim();
  const effectiveMode = config?.effectiveMode ?? "managed";

  useEffect(() => {
    if (envOverride || !/^https?:\/\//i.test(trimmedRemoteUrl)) {
      setProbeStatus("idle");
      return;
    }
    const seq = ++probeSeq.current;
    setProbeStatus("probing");
    const timer = window.setTimeout(() => {
      desktop
        ?.probeConnectionConfig?.(trimmedRemoteUrl)
        .then((result) => {
          if (seq !== probeSeq.current) return;
          if (!result.reachable) setProbeStatus("unreachable");
          else if (result.authRequired) {
            setProbeStatus("authRequired");
            setAuthProviders(result.authProviders ?? []);
          } else {
            setProbeStatus("reachable");
            setAuthProviders([]);
          }
        })
        .catch(() => {
          if (seq !== probeSeq.current) return;
          setProbeStatus("unreachable");
        });
    }, PROBE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [trimmedRemoteUrl, envOverride, desktop]);

  const gated = probeStatus === "authRequired";

  useEffect(() => {
    setIdentity(null);
    if (!gated || !/^https?:\/\//i.test(trimmedRemoteUrl)) return;
    let cancelled = false;
    desktop
      ?.connectionAuthMe?.(trimmedRemoteUrl)
      .then((r) => {
        if (!cancelled && r.ok && r.identity) setIdentity(r.identity);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [gated, trimmedRemoteUrl, desktop]);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    setDiagLoading(true);
    setDiagError("");
    fetchJSON<StatusResponse>("/api/status", undefined, StatusResponse)
      .then((status) => {
        if (cancelled) return;
        setDiag({
          version: status.version,
          gatewayState: status.gateway_state || (status.gateway_running ? "running" : "stopped"),
          platforms: Object.entries(status.gateway_platforms ?? {}).map(([name, value]) => ({
            name,
            state: value.state ?? "unknown",
          })),
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDiagError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setDiagLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [desktop, diagNonce]);

  const handleOauthLogin = async (): Promise<void> => {
    if (!desktop?.connectionOauthLogin) return;
    setLoggingIn(true);
    setMessage(null);
    try {
      const r = await desktop.connectionOauthLogin(trimmedRemoteUrl);
      if (r.ok) {
        setIdentity(r.identity ?? null);
        setMessage({ tone: "ok", text: "登录成功" });
        notifyConnectionAuthRestored();
      } else {
        setMessage({ tone: "error", text: r.error ?? "登录失败" });
      }
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoggingIn(false);
    }
  };

  const handlePasswordLogin = async (provider: string): Promise<void> => {
    if (!desktop?.connectionPasswordLogin) return;
    setLoggingIn(true);
    setMessage(null);
    try {
      const r = await desktop.connectionPasswordLogin({
        remoteUrl: trimmedRemoteUrl,
        provider,
        username: pwUser,
        password: pwPass,
      });
      if (r.ok) {
        setIdentity(r.identity ?? null);
        setPwPass("");
        setMessage({ tone: "ok", text: "登录成功" });
        notifyConnectionAuthRestored();
      } else {
        setMessage({ tone: "error", text: r.error ?? "登录失败" });
      }
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = async (): Promise<void> => {
    if (!desktop?.connectionOauthLogout) return;
    try {
      await desktop.connectionOauthLogout(trimmedRemoteUrl);
    } catch {}
    setIdentity(null);
    setMessage({ tone: "ok", text: "已注销" });
  };

  const remoteReady = gated
    ? Boolean(identity)
    : Boolean(trimmedRemoteUrl && (tokenInput.trim() || config?.remoteTokenSet));
  const cloudReady = gated
    ? Boolean(identity)
    : Boolean(cloudUrl.trim() && (tokenInput.trim() || config?.remoteTokenSet));
  const localReady = Boolean(trimmedLocalUrl);
  const readyFor = (target: ExternalTarget) =>
    target === "local" ? localReady : target === "cloud" ? cloudReady : target === "ssh" ? true : remoteReady;
  const identityLabel = identity
    ? identity.displayName || identity.email || identity.userId || "已登录"
    : null;
  const restartBlockedReason = kernelRestartDisabledReason(kernelStatus);
  const restartBlocked = restartBlockedReason !== null;

  const handleRestartKernel = async () => {
    if (restartBlocked || restarting) return;
    setRestarting(true);
    setRestartMessage(null);
    try {
      await postJSON("/api/gateway/restart", {});
      setRestartMessage({ tone: "ok", text: "已请求重启内核，就绪后界面会自动重连。" });
      kernel.refresh();
      window.setTimeout(() => kernel.refresh(), 3_000);
    } catch (error) {
      setRestartMessage({
        tone: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRestarting(false);
    }
  };

  const handleRetryKernel = useKernelRetry({
    fallback: () => handleRestartKernel(),
    onRetried: () => kernel.refresh(),
  });

  const handleTest = async (target: ExternalTarget) => {
    setMessage(null);
    if (target === "ssh") {
      const errors = validateSshTarget(sshTarget);
      setSshErrors(errors);
      if (hasSshErrors(errors)) {
        setMessage({ tone: "error", text: "SSH 目标字段有误，先修正标红的项" });
        return;
      }
      setPending({ target, kind: "test" });
      setProbeMessage(null);
      try {
        const result = await probeSshTarget(sshTarget);
        setProbeMessage(
          result.ok
            ? {
                tone: "ok",
                text: `SSH 可达（${result.host}${result.version ? ` · ${result.version}` : ""}）`,
              }
            : {
                tone: "error",
                text: result.error ?? "SSH 探测失败",
                hint: result.stderr?.trim() || undefined,
              },
        );
      } finally {
        setPending(null);
      }
      return;
    }
    if (!desktop?.testConnectionConfig) return;
    const remoteUrlForTarget = target === "local" ? undefined : target === "cloud" ? cloudUrl.trim() : trimmedRemoteUrl;
    setPending({ target, kind: "test" });
    try {
      const result = await desktop.testConnectionConfig({
        mode: target === "local" ? "local" : "remote",
        localUrl: target === "local" ? trimmedLocalUrl : undefined,
        remoteUrl: remoteUrlForTarget,
        remoteToken: target === "local" || gated ? undefined : tokenInput || undefined,
        remoteAuthMode: target === "local" ? undefined : gated ? "oauth" : "token",
      });
      setMessage(withLocalDashboardHint(testResultSummary(result), target));
    } catch (error) {
      setMessage(withLocalDashboardHint({ tone: "error", text: error instanceof Error ? error.message : String(error) }, target));
    } finally {
      setPending(null);
    }
  };

  const targetUrl = (target: ExternalTarget): string => {
    if (target === "local") return trimmedLocalUrl;
    if (target === "cloud") return cloudUrl.trim();
    return trimmedRemoteUrl;
  };

  const persistRegistryEntry = async (
    kind: GatewayMode,
    name: string,
    url: string,
    token: string,
    ssh: SavedSshTarget | null,
  ): Promise<SavedConnection> => {
    const existing = registry.find((item) =>
      kind === "ssh" ? item.kind === "ssh" && sshTargetSummary(item.ssh ?? DEFAULT_SSH_TARGET) === name : item.kind === kind && item.url === url,
    );
    const id = existing?.id ?? createConnectionId(kind);
    let tokenRef: string | null = existing?.tokenRef ?? null;
    if (token.trim()) {
      const saved = await saveConnectionToken(tokenRefFor(id), token.trim());
      if (saved.ok) tokenRef = tokenRefFor(id);
      else if (saved.reason === "unsupported") {
        setMessage({
          tone: "error",
          text: "本系统未启用加密存储，令牌不会落盘；连接后如需切换请重新填写。",
        });
      }
    }
    const entry: SavedConnection = {
      id,
      kind,
      name: existing?.name ?? (name || nextConnectionName(registry, kind)),
      url,
      tokenRef,
      ssh: ssh ? { ...ssh } : null,
      createdAt: existing?.createdAt ?? Date.now(),
      lastUsedAt: Date.now(),
    };
    setRegistry(upsertAndPersist(entry));
    setActiveId(entry.id);
    writeActiveConnectionId(entry.id);
    return entry;
  };

  const submit = async (target: ExternalTarget, apply: boolean) => {
    if (target === "ssh") {
      const errors = validateSshTarget(sshTarget);
      setSshErrors(errors);
      if (hasSshErrors(errors)) {
        setMessage({ tone: "error", text: "SSH 目标字段有误，先修正标红的项" });
        return;
      }
      setMessage(null);
      setPending({ target, kind: apply ? "apply" : "save" });
      try {
        const entry = await persistRegistryEntry(
          "ssh",
          sshTargetSummary(sshTarget),
          "",
          "",
          sshTarget,
        );
        if (!apply) {
          setMessage({ tone: "ok", text: "已保存 SSH 目标，之后可在连接列表里一键切换" });
          return;
        }
        const tunnel = await openSshTunnel(`conn-${entry.id}`, sshTarget);
        const result = await desktop!.applyConnectionConfig!({ mode: "local", localUrl: tunnel.remoteUrl });
        if (result.ok) {
          setMessage({ tone: "ok", text: `SSH 隧道已建立（本地端口 ${tunnel.localPort}），正在重新加载界面…` });
          if (onApplied) {
            await onApplied("local");
            return;
          }
          window.setTimeout(() => window.location.reload(), 600);
          return;
        }
        await closeSshTunnel(`conn-${entry.id}`);
        setMessage({ tone: "error", text: result.error ?? "SSH 隧道已断开：远端内核没连上" });
      } catch (error) {
        setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
      } finally {
        setPending(null);
      }
      return;
    }

    if (!readyFor(target)) {
      setMessage({
        tone: "error",
        text: target === "remote" || target === "cloud" ? "请先填写地址和会话令牌" : "请先填写本机连接地址",
      });
      return;
    }
    setMessage(null);
    setPending({ target, kind: apply ? "apply" : "save" });
    try {
      const url = targetUrl(target);
      const payload = {
        mode: (target === "local" ? "local" : "remote") as ConnectionMode,
        localUrl: target === "local" ? trimmedLocalUrl : undefined,
        remoteUrl: target === "local" ? undefined : url,
        remoteToken: target === "local" || gated ? undefined : tokenInput || undefined,
        remoteAuthMode: target === "local" ? undefined : gated ? ("oauth" as const) : ("token" as const),
      };
      if (apply) {
        const result = await desktop!.applyConnectionConfig!(payload);
        if (result.ok) {
          await persistRegistryEntry(target, url || CONNECTION_KIND_LABELS[target], url, tokenInput, null);
          setMessage({ tone: "ok", text: "已切换，正在重新加载界面…" });
          if (onApplied) {
            await onApplied(target as ConnectionMode);
            return;
          }
          window.setTimeout(() => window.location.reload(), 600);
          return;
        }
        setMessage(withLocalDashboardHint({ tone: "error", text: result.error ?? "切换失败" }, target));
      } else {
        const view = await desktop!.saveConnectionConfig!(payload);
        setConfig(view);
        await persistRegistryEntry(target, url || CONNECTION_KIND_LABELS[target], url, tokenInput, null);
        setTokenInput("");
        setMessage({ tone: "ok", text: "已保存，重启桌面端后生效" });
      }
    } catch (error) {
      setMessage(withLocalDashboardHint({ tone: "error", text: error instanceof Error ? error.message : String(error) }, target));
    } finally {
      setPending(null);
    }
  };

  const handleSwitchConnection = async (connection: SavedConnection) => {
    setMessage(null);
    setSwitchingId(connection.id);
    try {
      let payload: ConnectionConfigInput;
      if (connection.kind === "local") {
        payload = { mode: "local", localUrl: connection.url || trimmedLocalUrl };
      } else if (connection.kind === "ssh") {
        const tunnel = await openSshTunnel(`conn-${connection.id}`, connection.ssh ?? DEFAULT_SSH_TARGET);
        payload = { mode: "local", localUrl: tunnel.remoteUrl };
      } else {
        const token = connection.tokenRef ? await readConnectionToken(connection.tokenRef) : null;
        payload = {
          mode: "remote",
          remoteUrl: connection.url,
          remoteToken: token ?? undefined,
          remoteAuthMode: "token",
        };
      }
      const result = await desktop!.applyConnectionConfig!(payload);
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error ?? "切换失败" });
        return;
      }
      writeActiveConnectionId(connection.id);
      setActiveId(connection.id);
      setRegistry(upsertAndPersist({ ...connection, lastUsedAt: Date.now() }));
      setMessage({ tone: "ok", text: `已切换到「${connection.name}」，正在重新加载界面…` });
      if (onApplied) {
        await onApplied(connection.kind === "ssh" ? "local" : payload.mode ?? "local");
        return;
      }
      window.setTimeout(() => window.location.reload(), 600);
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSwitchingId(null);
    }
  };

  const handleDeleteConnection = (connection: SavedConnection) => {
    const next = removeAndPersist(connection.id);
    setRegistry(next);
    if (activeId === connection.id) setActiveId(null);
    if (connection.kind === "ssh") void closeSshTunnel(`conn-${connection.id}`);
    setMessage({ tone: "ok", text: `已删除「${connection.name}」` });
  };

  const handleOpenBrowser = async () => {
    if (!desktop?.openBrowserCompanion) return;
    setOpeningBrowser(true);
    setBrowserMessage(null);
    try {
      await desktop.openBrowserCompanion();
      setBrowserMessage({ tone: "ok", text: "已在系统浏览器中打开社区桌面版" });
    } catch (error) {
      setBrowserMessage({
        tone: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setOpeningBrowser(false);
    }
  };

  if (!supported) {
    if (browserCompanion) {
      return (
        <div>
          {showHeading && <h2 className={s.heading}>连接</h2>}
          <SettingsHero
            icon={<Globe2 size={24} />}
            eyebrow="浏览器伴生模式"
            title="连接由社区桌面版代管"
            description="当前浏览器的 REST 与实时网关通信都由桌面端转发，连接目标也由桌面端管理。这里不做探活，真实连通情况以桌面端连接页为准；要换内核请回桌面端操作。"
            badge={<span className={s.statusBadge}>已配置（未探活）</span>}
          />
        </div>
      );
    }
    return (
      <div>
        {showHeading && <h2 className={s.heading}>连接</h2>}
        <div className={s.rowSub}>连接配置仅在桌面端可用。</div>
      </div>
    );
  }

  const tokenPlaceholder = config?.remoteTokenSet
    ? `已保存（${config.remoteTokenPreview ?? "已保存"}），留空保持不变`
    : "粘贴远程后端的会话令牌";
  const connectionLoaded = Boolean(config) && !loadError;
  const connectionTitle = !connectionLoaded
    ? "正在读取连接状态"
    : envOverride
      ? "连接由环境变量覆盖"
      : `当前连接目标：${modeLabel(effectiveMode)}`;
  const connectionDescription = envOverride
    ? `当前会话由环境变量强制连接到远程端（${config?.remoteUrl ?? "远程地址"}），需取消环境变量后才能在此修改。`
    : remoteTarget
      ? "当前连接目标是远程 Hermes，本机内核信息仅作参考。"
      : "本机内核由桌面端启动并守护；只有需要接入另一台机器时才用远程连接。";
  const connectionBadge = !connectionLoaded ? "读取中" : envOverride ? "环境变量" : modeLabel(effectiveMode);
  const kernelHealthy = Boolean(
    kernelStatus && (kernelStatus.mode === "attached" || kernelStatus.mode === "spawned"),
  );
  const connectionHealthy = connectionLoaded && !remoteTarget && kernelHealthy;
  const kernelAddressValue = kernelStatus
    ? kernelEndpoint(kernelStatus)
    : (window.__HERMES_RUNTIME__?.dashboardApiBaseUrl ?? "—");
  const kernelTone = kernelStatus?.mode && kernelStatus.mode !== "attached" && kernelStatus.mode !== "spawned"
    ? "warn"
    : undefined;

  return (
    <div>
      {showHeading && <h2 className={s.heading}>连接</h2>}

      {!externalOnly && (
        <SettingsHero
          ok={connectionHealthy}
          icon={remoteTarget || envOverride ? <Globe2 size={24} /> : <Cable size={24} />}
          eyebrow="Hermes Agent 连接"
          title={connectionTitle}
          description={connectionDescription}
          badge={<span className={s.statusBadge} data-on={connectionHealthy}>{connectionBadge}</span>}
        />
      )}

      {!externalOnly && desktop?.openBrowserCompanion && (
        <div className={s.connBrowserCompanion}>
          <div className={s.connBrowserCompanionCopy}>
            <div className={s.connBrowserCompanionTitle}>在浏览器中使用社区桌面版</div>
            <div className={s.rowSub}>
              由当前桌面端安全转发内核连接，无需在浏览器里复制会话令牌。
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleOpenBrowser()}
            loading={openingBrowser}
            leadingIcon={<ExternalLink size={12} />}
          >
            在浏览器中打开社区桌面版
          </Button>
        </div>
      )}

      {browserMessage && (
        <Alert className={s.connResult} tone={browserMessage.tone} size="sm">
          {browserMessage.text}
        </Alert>
      )}

      {loadError && <div className={s.connResult} data-tone="error">{loadError}</div>}

      {envOverride && (
        <div className={s.connEnvWarn}>
          <AlertTriangle size={16} aria-hidden="true" />
          <div>
            <div style={{ fontWeight: 600 }}>当前会话由环境变量强制为远程模式（{config?.remoteUrl}）。</div>
            <div style={{ marginTop: 4 }}>
              取消设置 <code>HERMES_DESKTOP_REMOTE_URL</code> 和 <code>HERMES_DESKTOP_REMOTE_TOKEN</code>{" "}
              后才能在此修改连接。
            </div>
          </div>
        </div>
      )}

      <KernelDegradedCallout
        status={kernelStatus}
        onRetry={() => void handleRetryKernel.retry()}
        retrying={handleRetryKernel.retrying}
      />

      {handleRetryKernel.message && (
        <Alert
          className={s.connResult}
          tone={handleRetryKernel.message.tone}
          size="sm"
          data-testid="kernel-retry-result"
        >
          {handleRetryKernel.message.text}
        </Alert>
      )}

      {!externalOnly && (
        <div className={c.tabBar} role="tablist" aria-label="连接子页">
          <button
            type="button"
            role="tab"
            aria-selected={panel === "connection"}
            className={c.tab}
            data-active={panel === "connection" ? "true" : "false"}
            data-testid="panel-tab-connection"
            onClick={() => setPanel("connection")}
          >
            <Cable size={13} aria-hidden="true" />
            连接
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={panel === "devices"}
            className={c.tab}
            data-active={panel === "devices" ? "true" : "false"}
            data-testid="panel-tab-devices"
            onClick={() => setPanel("devices")}
          >
            <MonitorSmartphone size={13} aria-hidden="true" />
            设备
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={panel === "keys"}
            className={c.tab}
            data-active={panel === "keys" ? "true" : "false"}
            data-testid="panel-tab-keys"
            onClick={() => setPanel("keys")}
          >
            <ShieldCheck size={13} aria-hidden="true" />
            API 密钥
          </button>
        </div>
      )}

      {!externalOnly && panel === "devices" ? (
        <ConnSection
          icon={MonitorSmartphone}
          title="设备"
          description="当前内核与桌面端的连接情况。内核没有上报客户端清单的接口，这里列出本机可确认的信息。"
        >
          <DevicePanel
            kernelMode={kernelStatus?.mode ?? null}
            kernelPort={kernelStatus?.port ?? null}
            kernelPid={kernelStatus?.pid ?? null}
            version={diag?.version ?? null}
            gatewayState={diag?.gatewayState ?? null}
            activeMode={mode}
            localKernelAddress={kernelAddressValue}
            connections={registry}
          />
        </ConnSection>
      ) : !externalOnly && panel === "keys" ? (
        <ApiKeysSection showHeading={false} />
      ) : (
        <>
          {!externalOnly && (
            <ConnSection
              icon={Cable}
              title="连接模式"
              description="先选目标类型，再填这一类的连接参数；保存后会进下面的连接列表。"
            >
              <ConnectionModeCards
                value={mode}
                onChange={selectMode}
                disabled={disabled}
                currentMode={modeFromConnectionMode(config?.mode)}
              />
              <div
                className={c.notice}
                data-tone={secretStatus?.available ? "ok" : "warn"}
                data-testid="secret-storage-status"
              >
                {secretStatus?.available ? (
                  <ShieldCheck size={14} aria-hidden="true" />
                ) : (
                  <ShieldOff size={14} aria-hidden="true" />
                )}
                <span>
                  {secretStatus === null
                    ? "正在检测系统加密存储…"
                    : secretStatus.available
                      ? `连接令牌使用系统 DPAPI 加密存储（${secretStatus.scheme.toUpperCase()}），磁盘上只有密文，连接时再解密。`
                      : "本系统未启用加密存储：连接令牌不会写入磁盘，切换连接时需要重新填写。"}
                </span>
              </div>
            </ConnSection>
          )}

          {!externalOnly && (
            <ConnSection
              icon={MonitorSmartphone}
              title="已保存的连接"
              description="本机保存过的连接目标，点「切换」直接生效；令牌只存加密引用。"
            >
              <SavedConnectionsList
                items={registry}
                activeId={activeId}
                onSelect={(connection) => void handleSwitchConnection(connection)}
                onDelete={handleDeleteConnection}
                busyId={switchingId}
                disabled={disabled}
              />
            </ConnSection>
          )}

      {(mode === "local" || externalOnly) && (
      <ConnSection
        icon={Cable}
        title="本机内核"
        description="桌面端启动时会自动接管或拉起本机内核（hermes serve），并负责进程号、崩溃重启与退出清理。"
        badge={
          effectiveMode !== "remote" ? <span className={s.connSectionBadge}>当前目标</span> : undefined
        }
      >
        <div className={s.connKvGrid}>
          <Kv label="模式" value={kernelModeText(kernelStatus?.mode)} testId="kernel-mode" tone={kernelTone} />
          <Kv label="地址" value={kernelAddressValue} testId="kernel-address" />
          <Kv label="pid" value={kernelStatus?.pid ?? "—"} testId="kernel-pid" />
          <Kv label="重启次数" value={kernelStatus?.restarts ?? 0} testId="kernel-restarts" />
          <Kv
            label="最近错误"
            value={kernelStatus?.lastError?.trim() || kernel.error || "无"}
            testId="kernel-last-error"
            tone={kernelStatus?.lastError?.trim() ? "error" : undefined}
          />
        </div>

        <div className={s.row} style={{ borderBottom: "none" }}>
          <div className={s.rowLeft}>
            <div className={s.rowLabel}>本机连接地址</div>
            <div className={s.rowSub}>
              仅用于手动接管本机其它实例；默认连桌面端托管的那个内核，一般不用改。
            </div>
          </div>
          <div className={s.rowRight}>
            <Input
              mono
              style={{ minWidth: 280 }}
              value={localUrl}
              placeholder={DEFAULT_LOCAL_URL}
              disabled={disabled}
              onChange={(e) => setLocalUrl(e.target.value)}
              spellCheck={false}
            />
          </div>
        </div>

        <div className={s.connSectionActions}>
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleRestartKernel()}
            disabled={restartBlocked || restarting || disabled}
            loading={restarting}
            leadingIcon={<RotateCcw size={12} />}
            title={restartBlockedReason ?? "重启本机内核（桌面端启动的那个进程）"}
            data-testid="kernel-restart-button"
          >
            重启内核
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleTest("local")}
            disabled={disabled || !localReady}
            loading={pending?.target === "local" && pending.kind === "test"}
            leadingIcon={<Cable size={12} />}
          >
            测试连接
          </Button>
          <Button
            type="button"
            variant="solid"
            tone="accent"
            onClick={() => void submit("local", true)}
            disabled={disabled || !localReady}
            loading={pending?.target === "local" && pending.kind === "apply"}
          >
            {externalOnly ? "连接并进入桌面端" : "保存并连接本机内核"}
          </Button>
        </div>
        {restartMessage && (
          <Alert className={s.connResult} tone={restartMessage.tone} size="sm">
            {restartMessage.text}
          </Alert>
        )}
      </ConnSection>
      )}

      {(mode === "remote" || externalOnly) && (
      <ConnSection
        icon={Globe2}
        title="远程连接"
        description="接入另一台机器上的 Hermes：填地址 + 会话令牌，或完成 OAuth 登录。保存后需重启桌面端生效。"
        badge={effectiveMode === "remote" ? <span className={s.connSectionBadge}>当前目标</span> : undefined}
      >
        <div className={s.row}>
          <div className={s.rowLeft}>
            <div className={s.rowLabel}>远程地址</div>
            <div className={s.rowSub}>
              远程 Hermes 后端的地址，支持路径前缀（如 https://gateway.example.com/hermes）。
            </div>
            {probeStatus !== "idle" && (
              <div
                className={s.connProbe}
                data-tone={probeStatus === "reachable" ? "ok" : probeStatus === "probing" ? undefined : "error"}
                aria-live="polite"
              >
                {probeStatus === "probing" && <LoadingIndicator size="xs" />}
                {probeStatus === "reachable" && <CheckCircle2 size={12} />}
                {(probeStatus === "unreachable" || probeStatus === "authRequired") && <XCircle size={12} />}
                {probeStatus === "probing" && "正在检测连接方式…"}
                {probeStatus === "reachable" && "后端可达"}
                {probeStatus === "unreachable" && "暂时无法连接，检查地址与网络后会自动重试"}
                {probeStatus === "authRequired" && "该后端启用了登录门，请在下方登录后再连接"}
              </div>
            )}
          </div>
          <div className={s.rowRight}>
            <Input
              mono
              style={{ minWidth: 280 }}
              value={remoteUrl}
              placeholder="https://gateway.example.com/hermes"
              disabled={disabled}
              onChange={(e) => setRemoteUrl(e.target.value)}
              spellCheck={false}
            />
          </div>
        </div>

        {!gated && (
          <div className={s.row}>
            <div className={s.rowLeft}>
              <div className={s.rowLabel}>会话令牌</div>
              <div className={s.rowSub}>
                连接远程后端时使用的会话令牌，仅保存在本机，留空保持不变。
              </div>
            </div>
            <div className={s.rowRight}>
              <Input
                type="password"
                style={{ minWidth: 280 }}
                value={tokenInput}
                placeholder={tokenPlaceholder}
                disabled={disabled}
                onChange={(e) => setTokenInput(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
        )}

        {gated && (
          <div className={s.row}>
            <div className={s.rowLeft}>
              <div className={s.rowLabel}>登录</div>
              <div className={s.rowSub}>
                {identityLabel
                  ? `已登录：${identityLabel}`
                  : "该网关需要登录后才能连接。选择下方登录方式完成登录。"}
              </div>
            </div>
            <div className={s.rowRight} style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
              {identityLabel ? (
                <Button type="button" variant="outline" onClick={() => void handleLogout()} disabled={disabled}>
                  注销
                </Button>
              ) : (
                <>
                  {authProviders
                    .filter((p) => !p.supportsPassword)
                    .map((p) => (
                      <Button
                        key={p.name}
                        type="button"
                        variant="solid"
                        tone="accent"
                        onClick={() => void handleOauthLogin()}
                        disabled={disabled}
                        loading={loggingIn}
                      >
                        使用 {p.displayName} 登录
                      </Button>
                    ))}
                  {authProviders
                    .filter((p) => p.supportsPassword)
                    .map((p) => (
                      <div key={p.name} style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 280 }}>
                        <Input
                          style={{ minWidth: 280 }}
                          value={pwUser}
                          placeholder={`${p.displayName} 用户名`}
                          disabled={disabled || loggingIn}
                          onChange={(e) => setPwUser(e.target.value)}
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <Input
                          type="password"
                          style={{ minWidth: 280 }}
                          value={pwPass}
                          placeholder="密码"
                          disabled={disabled || loggingIn}
                          onChange={(e) => setPwPass(e.target.value)}
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <Button
                          type="button"
                          variant="solid"
                          tone="accent"
                          onClick={() => void handlePasswordLogin(p.name)}
                          disabled={disabled || !pwUser || !pwPass}
                          loading={loggingIn}
                        >
                          登录
                        </Button>
                      </div>
                    ))}
                  {authProviders.length === 0 && (
                    <div className={s.rowSub}>网关未注册任何登录方式，请检查网关配置。</div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        <div className={s.connSectionActions}>
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleTest("remote")}
            disabled={disabled || !trimmedRemoteUrl}
            loading={pending?.target === "remote" && pending.kind === "test"}
            leadingIcon={<Cable size={12} />}
          >
            测试连接
          </Button>
          {!externalOnly && (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={() => { window.location.hash = "#/guide"; }}
              >
                重新运行使用引导
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void submit("remote", false)}
                disabled={disabled || !remoteReady}
                loading={pending?.target === "remote" && pending.kind === "save"}
              >
                仅保存（重启后生效）
              </Button>
            </>
          )}
          <Button
            type="button"
            variant="solid"
            tone="accent"
            onClick={() => void submit("remote", true)}
            disabled={disabled || !remoteReady}
            loading={pending?.target === "remote" && pending.kind === "apply"}
          >
            {externalOnly ? "连接并进入桌面端" : "保存并连接远程"}
          </Button>
        </div>
        <div className={s.connSectionNote}>
          切换远程连接后需要重启桌面端生效；本机内核与远程连接互斥，同一时间只有一个连接目标。
        </div>
      </ConnSection>
      )}

      {mode === "cloud" && (
      <ConnSection
        icon={Cloud}
        title="云端实例"
        description="连接 Nous 云端托管的 Hermes 实例：地址由云端控制台给出，令牌用于鉴权。"
        badge={config?.mode === "remote" && cloudUrl.trim() && config.remoteUrl === cloudUrl.trim() ? <span className={s.connSectionBadge}>当前目标</span> : undefined}
      >
        <div className={s.row}>
          <div className={s.rowLeft}>
            <div className={s.rowLabel}>实例地址</div>
            <div className={s.rowSub}>云端实例网关地址，形如 https://your-agent.cloud.nousresearch.com</div>
          </div>
          <div className={s.rowRight}>
            <Input
              mono
              style={{ minWidth: 280 }}
              value={cloudUrl}
              placeholder={DEFAULT_CLOUD_URL}
              disabled={disabled}
              onChange={(event) => setCloudUrl(event.target.value)}
              spellCheck={false}
              data-testid="cloud-url-input"
            />
          </div>
        </div>

        <div className={s.row}>
          <div className={s.rowLeft}>
            <div className={s.rowLabel}>实例令牌</div>
            <div className={s.rowSub}>云端实例的会话令牌，保存时走系统加密存储，磁盘上只留密文引用。</div>
          </div>
          <div className={s.rowRight}>
            <Input
              type="password"
              style={{ minWidth: 280 }}
              value={tokenInput}
              placeholder={tokenPlaceholder}
              disabled={disabled}
              onChange={(event) => setTokenInput(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              data-testid="cloud-token-input"
            />
          </div>
        </div>

        <div className={s.connSectionActions}>
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleTest("cloud")}
            disabled={disabled || !cloudUrl.trim()}
            loading={pending?.target === "cloud" && pending.kind === "test"}
            leadingIcon={<Cable size={12} />}
          >
            测试连接
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void submit("cloud", false)}
            disabled={disabled || !cloudReady}
            loading={pending?.target === "cloud" && pending.kind === "save"}
          >
            仅保存
          </Button>
          <Button
            type="button"
            variant="solid"
            tone="accent"
            onClick={() => void submit("cloud", true)}
            disabled={disabled || !cloudReady}
            loading={pending?.target === "cloud" && pending.kind === "apply"}
          >
            保存并连接云端
          </Button>
        </div>
        <div className={s.connSectionNote}>
          云端实例复用远程连接通道（协议侧仍是 remote），切换后同样需要重载界面生效。
        </div>
      </ConnSection>
      )}

      {mode === "ssh" && (
      <ConnSection
        icon={Terminal}
        title="SSH 远端"
        description="用 ssh 端口转发接入远端内核：桌面端起 -L 隧道，再把连接目标指向本地隧道端口。"
      >
        <SshTargetFields
          target={sshTarget}
          errors={sshErrors}
          onChange={changeSshTarget}
          hosts={sshHosts}
          hostsLoading={sshHostsLoading}
          configPath={sshConfigPath}
          configError={sshConfigError}
          disabled={disabled}
        />

        {probeMessage && (
          <Alert className={s.connResult} tone={probeMessage.tone} size="sm" data-testid="ssh-probe-result">
            <div>{probeMessage.text}</div>
            {probeMessage.hint && <div className={s.connResultHint}>{probeMessage.hint}</div>}
          </Alert>
        )}

        <div className={s.connSectionActions}>
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleTest("ssh")}
            disabled={disabled || !sshTarget.host.trim()}
            loading={pending?.target === "ssh" && pending.kind === "test"}
            leadingIcon={<Terminal size={12} />}
            data-testid="ssh-probe-button"
          >
            测试连接（ssh 探针）
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void submit("ssh", false)}
            disabled={disabled}
            loading={pending?.target === "ssh" && pending.kind === "save"}
          >
            仅保存
          </Button>
          <Button
            type="button"
            variant="solid"
            tone="accent"
            onClick={() => void submit("ssh", true)}
            disabled={disabled}
            loading={pending?.target === "ssh" && pending.kind === "apply"}
            data-testid="ssh-connect-button"
          >
            建立隧道并连接
          </Button>
        </div>
        <div className={s.connSectionNote}>
          探针会在远端执行 <code>hermes --version</code>，用真实 ssh 连接判断可达性；隧道建好后由内核从远端页面读取会话令牌。
        </div>
      </ConnSection>
      )}

      <ConnSection
        icon={Activity}
        title="诊断"
        description="只读信息，用于排查内核没起来或网关没连上的情况。"
      >
        <div className={s.connKvGrid}>
          <Kv label="kernel_status().mode" value={kernelStatus?.mode ?? "—"} />
          <Kv label="桌面端目标" value={connectionTargetLabel(remoteTarget)} />
          <Kv label="kernel_status().port" value={kernelStatus?.port ?? "—"} />
          <Kv label="kernel_status().pid" value={kernelStatus?.pid ?? "—"} />
          <Kv label="kernel_status().restarts" value={kernelStatus?.restarts ?? 0} />
          <Kv label="/api/status.version" value={diag?.version ?? (diagLoading ? "读取中…" : "—")} />
          <Kv
            label="/api/status.gateway_state"
            value={diag?.gatewayState ?? (diagError ? "不可用" : diagLoading ? "读取中…" : "—")}
            tone={diag?.gatewayState && diag.gatewayState !== "running" ? "warn" : undefined}
          />
          <Kv
            label="平台状态"
            value={
              diag
                ? diag.platforms.length
                  ? diag.platforms.map((platform) => `${platform.name}:${platform.state}`).join(" · ")
                  : "未启用"
                : diagError
                  ? "不可用"
                  : "—"
            }
          />
          <Kv
            label="kernel_status().lastError"
            value={kernelStatus?.lastError?.trim() || kernel.error || "无"}
            tone={kernelStatus?.lastError?.trim() ? "error" : undefined}
          />
        </div>
        {diagError && <div className={s.connSectionNote}>/api/status 读取失败：{diagError}</div>}
        <div className={s.connSectionActions}>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              kernel.refresh();
              setDiagNonce((value) => value + 1);
            }}
            loading={diagLoading}
            leadingIcon={<RefreshCw size={12} />}
          >
            刷新诊断
          </Button>
        </div>
      </ConnSection>
        </>
      )}

      {message && (
        <Alert className={s.connResult} tone={message.tone} size="sm">
          <div>{message.text}</div>
          {message.hint && <div className={s.connResultHint}>{message.hint}</div>}
        </Alert>
      )}

      {!externalOnly && (
        <div className={s.connSectionActions} data-testid="api-keys-entry">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setPanel("keys")}
          >
            打开「API 密钥」分区（工具密钥 / 网关密钥）
          </Button>
        </div>
      )}
    </div>
  );
}
