import { useState } from "react";
import { ChevronDown, RotateCcw, ShieldCheck } from "lucide-react";
import { Popover, StatusDot } from "@hermes/shared-ui";
import { useStatus } from "@/hooks/use-status";
import { useRuntimeInfo } from "@/hooks/use-runtime-update";
import { useGatewayRestartAction } from "@/hooks/use-gateway-restart";
import { dashboardPortFromUrl, dashboardUrlFromInputs } from "@/lib/dashboard-url";
import { runtime } from "@/lib/runtime";
import { buildSidebarVersionRows } from "./sidebar-version-tag";
import s from "./app-top-bar.module.css";

/**
 * 顶栏连接卡：外部 / 远端内核 + 端口，点开是连接详情与两个维护动作
 * （健康检查 / 重连网关）。
 */
export function ConnectionChip() {
  const [open, setOpen] = useState(false);
  const { data: status, isError: statusError, isFetching, refetch } = useStatus();
  const { data: runtimeInfo } = useRuntimeInfo();
  const gatewayRestart = useGatewayRestartAction();

  const dashboardUrl = dashboardUrlFromInputs({
    healthUrl: status?.gateway_health_url,
    runtimeConfig: typeof window === "undefined" ? null : window.__HERMES_RUNTIME__,
    envOrigin: import.meta.env.VITE_HERMES_DASHBOARD_ORIGIN,
  });
  const port = dashboardPortFromUrl(dashboardUrl);
  const gatewayOnline = !!status && !statusError;
  const modeLabel = runtime.isRemote() ? "远端" : "外部";
  const versionRows = buildSidebarVersionRows({ status, runtimeInfo });
  const restartDisabled = gatewayRestart.busy || gatewayRestart.locked;
  const tone = gatewayOnline ? "success" : statusError || status ? "danger" : "neutral";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={s.chip}
          data-state={open ? "open" : undefined}
          title={`${modeLabel} Hermes · ${dashboardUrl}`}
          aria-label={`${modeLabel} Hermes 连接 ${dashboardUrl}`}
          data-no-drag
        >
          <StatusDot tone={tone} size="sm" />
          <span>{modeLabel}</span>
          <span className={s.chipMeta}>{port}</span>
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
            <span className={s.popValue} data-tone={gatewayOnline ? undefined : "danger"}>
              {gatewayOnline ? "正常" : "异常"}
            </span>
          </div>
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
