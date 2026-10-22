import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, ChevronDown, RotateCcw, ShieldCheck } from "lucide-react";
import { Popover, StatusDot } from "@hermes/shared-ui";
import { useStatus } from "@/hooks/use-status";
import { useRuntimeInfo } from "@/hooks/use-runtime-update";
import { useGatewayRestartAction } from "@/hooks/use-gateway-restart";
import { useModelInfo } from "@/hooks/use-config";
import { dashboardPortFromUrl, dashboardUrlFromInputs } from "@/lib/dashboard-url";
import { connectionTargetLabel, kernelErrorPreview } from "@/lib/kernel-status";
import { formatContext, formatModelShort } from "@/lib/model-label";
import { runtime } from "@/lib/runtime";
import { buildSidebarVersionRows } from "./sidebar-version-tag";
import s from "./app-top-bar.module.css";

/**
 * 顶栏状态卡：连接状态 + 端口 + 当前模型 + 上下文长度合成一枚 chip，
 * 点开是连接详情、模型信息与两个维护动作。
 */
export function StatusChip() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { data: status, isError: statusError, isFetching, refetch } = useStatus();
  const { data: runtimeInfo } = useRuntimeInfo();
  const gatewayRestart = useGatewayRestartAction();
  const { data: modelInfo } = useModelInfo();

  const dashboardUrl = dashboardUrlFromInputs({
    healthUrl: status?.gateway_health_url,
    runtimeConfig: typeof window === "undefined" ? null : window.__HERMES_RUNTIME__,
    envOrigin: import.meta.env.VITE_HERMES_DASHBOARD_ORIGIN,
  });
  const port = dashboardPortFromUrl(dashboardUrl);
  const gatewayOnline = !!status && !statusError;
  const modeLabel = connectionTargetLabel(runtime.isRemote());
  const versionRows = buildSidebarVersionRows({ status, runtimeInfo });
  const restartDisabled = gatewayRestart.busy || gatewayRestart.locked;
  const kernelDegraded = runtime.isBackendDegraded?.() === true;
  const degradedReason = (
    typeof window === "undefined" ? "" : (window.__HERMES_RUNTIME__?.backendDegradedReason ?? "")
  ).trim();
  const tone = kernelDegraded ? "danger" : gatewayOnline ? "success" : statusError || status ? "danger" : "neutral";

  const modelLabel = formatModelShort(modelInfo?.model);
  const hasModel = modelLabel !== "—";
  const contextLabel = formatContext(
    modelInfo?.effective_context_length ?? modelInfo?.auto_context_length,
  );
  const connectionLabel = kernelDegraded ? "内核异常" : gatewayOnline ? port : statusError ? "未连接" : "连接中";
  const summary = [
    kernelDegraded ? "内核异常 · 已降级到手动连接" : `${modeLabel} ${gatewayOnline ? port : "未连接"}`,
    hasModel ? `模型 ${modelLabel}` : null,
    `上下文 ${contextLabel}`,
  ].filter(Boolean).join(" · ");

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={s.chip}
          data-state={open ? "open" : undefined}
          title={`${summary} · ${dashboardUrl}`}
          aria-label={`连接 ${dashboardUrl}（${modeLabel}），模型 ${modelLabel}，上下文 ${contextLabel}`}
          data-no-drag
        >
          <StatusDot tone={tone} size="sm" />
          <span className={s.chipStatus} data-tone={kernelDegraded || !gatewayOnline ? "danger" : undefined}>
            {connectionLabel}
          </span>
          <span className={s.chipSep} aria-hidden="true">·</span>
          {hasModel ? (
            <>
              <span className={s.chipValue}>{modelLabel}</span>
              <span className={s.chipSep} aria-hidden="true">·</span>
            </>
          ) : null}
          <span className={s.chipMeta}>{contextLabel}</span>
          <ChevronDown size={12} className={s.chipChevron} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={s.connectionPopover} side="bottom" align="end">
          <div className={s.popRow}>
            <span className={s.popLabel}>连接</span>
            <span className={s.popValueMono} title={dashboardUrl}>
              {dashboardUrl}
            </span>
          </div>
          <div className={s.popRow}>
            <span className={s.popLabel}>内核</span>
            <span className={s.popValue} title={versionRows.kernel}>
              {versionRows.kernelLine.version}
            </span>
          </div>
          <div className={s.popRow}>
            <span className={s.popLabel}>界面</span>
            <span className={s.popValue} title={versionRows.ui}>
              {versionRows.uiLine.version}
            </span>
          </div>
          <div className={s.popRow}>
            <span className={s.popLabel}>健康</span>
            <span className={s.popValue} data-tone={kernelDegraded || !gatewayOnline ? "danger" : undefined}>
              {kernelDegraded ? "内核异常（已降级）" : gatewayOnline ? "正常" : "异常"}
            </span>
          </div>
          {kernelDegraded && (
            <div className={s.popRow}>
              <span className={s.popLabel}>降级原因</span>
              <span
                className={s.popValue}
                data-tone="danger"
                title={degradedReason || undefined}
                data-testid="status-chip-degraded-reason"
              >
                {kernelErrorPreview(degradedReason) || "内核未启动，已降级到手动连接"}
              </span>
            </div>
          )}
          <hr className={s.popDivider} />
          <div className={s.popRow}>
            <span className={s.popLabel}>模型</span>
            <span className={s.popValue} title={modelLabel}>
              {modelLabel}
            </span>
          </div>
          <div className={s.popRow}>
            <span className={s.popLabel}>上下文</span>
            <span className={s.popValue} title={contextLabel}>
              {contextLabel}
            </span>
          </div>
          <button
            type="button"
            className={s.popLink}
            onClick={() => {
              setOpen(false);
              navigate("/models");
            }}
          >
            <span>打开 配置 · 模型</span>
            <ArrowRight size={12} aria-hidden="true" />
          </button>
          <hr className={s.popDivider} />
          <div className={s.popActions}>
            <button
              type="button"
              className={s.popButton}
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              <ShieldCheck size={12} aria-hidden="true" />
              <span>{isFetching ? "检查中…" : "健康检查"}</span>
            </button>
            <button
              type="button"
              className={s.popButton}
              data-tone="primary"
              onClick={() => void gatewayRestart.restart()}
              disabled={restartDisabled}
              aria-busy={gatewayRestart.busy}
              title={
                gatewayRestart.phase === "idle"
                  ? "重启目标端 Hermes Gateway 并重连"
                  : (gatewayRestart.message ?? "正在重连网关…")
              }
            >
              <RotateCcw size={12} aria-hidden="true" />
              <span>{gatewayRestart.busy ? "重连中…" : "重连网关"}</span>
            </button>
          </div>
          {gatewayRestart.phase !== "idle" && gatewayRestart.message && (
            <div
              className={s.popMessage}
              data-tone={gatewayRestart.phase === "error" ? "danger" : undefined}
              aria-live="polite"
            >
              {gatewayRestart.message}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
