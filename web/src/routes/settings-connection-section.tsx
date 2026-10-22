import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  Cable,
  CheckCircle2,
  ExternalLink,
  Globe2,
  RefreshCw,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { StatusResponse } from "@hermes/protocol";
import type {
  AuthIdentity,
  AuthProviderInfo,
  ConnectionConfigView,
  ConnectionMode,
  TestConnectionResult,
} from "@hermes/protocol";
import { Alert, Button, Input, LoadingIndicator } from "@hermes/shared-ui";
import { notifyConnectionAuthRestored } from "@/lib/connection-auth-events";
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

type ExternalTarget = "local" | "remote";
type ProbeStatus = "idle" | "probing" | "reachable" | "unreachable" | "authRequired";
type ConnectionMessage = { tone: "ok" | "error"; text: string; hint?: string };
type PendingAction = { target: ExternalTarget; kind: "test" | "save" | "apply" };

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
  const localReady = Boolean(trimmedLocalUrl);
  const readyFor = (target: ExternalTarget) => (target === "local" ? localReady : remoteReady);
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
    if (!desktop?.testConnectionConfig) return;
    setMessage(null);
    setPending({ target, kind: "test" });
    try {
      const result = await desktop.testConnectionConfig({
        mode: target,
        localUrl: target === "local" ? trimmedLocalUrl : undefined,
        remoteUrl: target === "remote" ? trimmedRemoteUrl : undefined,
        remoteToken: target === "remote" && !gated ? tokenInput || undefined : undefined,
        remoteAuthMode: target === "remote" ? (gated ? "oauth" : "token") : undefined,
      });
      setMessage(withLocalDashboardHint(testResultSummary(result), target));
    } catch (error) {
      setMessage(withLocalDashboardHint({ tone: "error", text: error instanceof Error ? error.message : String(error) }, target));
    } finally {
      setPending(null);
    }
  };

  const submit = async (target: ExternalTarget, apply: boolean) => {
    if (!readyFor(target)) {
      setMessage({
        tone: "error",
        text: target === "remote" ? "请先填写远程地址和会话令牌" : "请先填写本机连接地址",
      });
      return;
    }
    setMessage(null);
    setPending({ target, kind: apply ? "apply" : "save" });
    try {
      const payload = {
        mode: target as ConnectionMode,
        localUrl: target === "local" ? trimmedLocalUrl : undefined,
        remoteUrl: target === "remote" ? trimmedRemoteUrl : undefined,
        remoteToken: target === "remote" && !gated ? tokenInput || undefined : undefined,
        remoteAuthMode: target === "remote" ? (gated ? ("oauth" as const) : ("token" as const)) : undefined,
      };
      if (apply) {
        const result = await desktop!.applyConnectionConfig!(payload);
        if (result.ok) {
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
        setTokenInput("");
        setMessage({ tone: "ok", text: "已保存，重启桌面端后生效" });
      }
    } catch (error) {
      setMessage(withLocalDashboardHint({ tone: "error", text: error instanceof Error ? error.message : String(error) }, target));
    } finally {
      setPending(null);
    }
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

      {message && (
        <Alert className={s.connResult} tone={message.tone} size="sm">
          <div>{message.text}</div>
          {message.hint && <div className={s.connResultHint}>{message.hint}</div>}
        </Alert>
      )}
    </div>
  );
}
