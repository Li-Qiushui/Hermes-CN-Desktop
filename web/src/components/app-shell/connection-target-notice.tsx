import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { LoadingIndicator } from "@hermes/shared-ui";
import {
  externalConnectionFailureSummary,
  summarizeExternalConnectionHealth,
} from "@/lib/external-connection-health";
import { runtime } from "@/lib/runtime";
import { connectionTargetLabel } from "@/lib/kernel-status";
import s from "./connection-target-notice.module.css";

export function ConnectionTargetNotice() {
  const navigate = useNavigate();
  const attached = runtime.isAttached();
  const remote = runtime.isRemote();
  const label = connectionTargetLabel(remote);
  const runtimeConfig = window.__HERMES_RUNTIME__;
  const target = runtimeConfig?.dashboardApiBaseUrl ?? runtimeConfig?.apiBaseUrl ?? label;
  const desktop = window.hermesDesktop;
  const canCheck = attached && Boolean(desktop?.getConnectionConfig && desktop?.testConnectionConfig);
  const health = useQuery({
    queryKey: ["external-connection-health", remote ? "remote" : "local", target],
    enabled: canCheck,
    retry: false,
    staleTime: 10_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!desktop?.getConnectionConfig || !desktop.testConnectionConfig) {
        throw new Error("当前桌面版本不支持外部连接检测");
      }
      const config = await desktop.getConnectionConfig();
      return desktop.testConnectionConfig({
        mode: remote ? "remote" : "local",
        localUrl: remote ? undefined : target,
        remoteUrl: remote ? target : undefined,
        remoteToken: remote && config.remoteAuthMode === "token"
          ? runtimeConfig?.sessionToken
          : undefined,
        remoteAuthMode: remote ? config.remoteAuthMode : undefined,
      });
    },
  });

  if (!attached) return null;

  const summary = health.data
    ? summarizeExternalConnectionHealth(health.data, label)
    : health.error
      ? externalConnectionFailureSummary(health.error, label)
      : null;
  const failed = summary?.ok === false;

  // 连接正常时不再占用工作台顶部横幅：右上 chip 与底部状态栏已表达同一信息。
  // 只在真的连不上/需要重新登录时才出现告警。
  if (!failed) return null;

  return (
    <div className={s.notice} data-tone="error" role="alert">
      <AlertTriangle size={16} aria-hidden="true" />
      <div className={s.copy}>
        <div className={s.heading}>
          <strong>{summary.title}</strong>
          <span>{target}</span>
        </div>
        <div className={s.detail}>{summary.detail}</div>
      </div>
      <div className={s.actions}>
        <button type="button" onClick={() => navigate("/connection")}>检查连接设置</button>
        {canCheck && (
          <button
            type="button"
            className={s.iconButton}
            onClick={() => void health.refetch()}
            disabled={health.isFetching}
            aria-label={`重新检测${label}`}
            title="重新检测"
          >
            {health.isFetching
              ? <LoadingIndicator size="xs" />
              : <RefreshCw size={12} aria-hidden="true" />}
          </button>
        )}
      </div>
    </div>
  );
}
