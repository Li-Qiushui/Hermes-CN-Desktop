import { Info } from "lucide-react";

import type { GatewayMode, SavedConnection } from "@/lib/connection-registry";
import { CONNECTION_KIND_LABELS, sshTargetSummary } from "@/lib/connection-registry";
import c from "./connection.module.css";

function Item({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className={c.deviceItem}>
      <span className={c.deviceLabel}>{label}</span>
      <span className={c.deviceValue} data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

function describeTarget(connection: SavedConnection): string {
  if (connection.kind === "ssh" && connection.ssh) return sshTargetSummary(connection.ssh);
  return connection.url || "未填写地址";
}

export function DevicePanel({
  kernelMode,
  kernelPort,
  kernelPid,
  version,
  gatewayState,
  activeMode,
  localKernelAddress,
  connections,
}: {
  kernelMode?: string | null;
  kernelPort?: number | null;
  kernelPid?: number | null;
  version?: string | null;
  gatewayState?: string | null;
  activeMode: GatewayMode;
  localKernelAddress: string;
  connections: SavedConnection[];
}) {
  return (
    <div data-testid="device-panel">
      <div className={c.notice} data-tone="warn" data-testid="device-panel-notice">
        <Info size={14} aria-hidden="true" />
        <span>内核未上报设备列表：当前内核没有可供查询的客户端清单接口，下面是本机可确认的内核与连接信息。</span>
      </div>

      <div className={c.deviceGrid}>
        <Item label="内核模式" value={kernelMode || "—"} testId="device-kernel-mode" />
        <Item label="内核端口" value={kernelPort ? String(kernelPort) : "—"} testId="device-kernel-port" />
        <Item label="内核 pid" value={kernelPid ? String(kernelPid) : "—"} testId="device-kernel-pid" />
        <Item label="内核版本" value={version || "—"} testId="device-kernel-version" />
        <Item label="网关状态" value={gatewayState || "—"} testId="device-gateway-state" />
        <Item label="连接模式" value={CONNECTION_KIND_LABELS[activeMode]} testId="device-active-mode" />
        <Item label="本机内核地址" value={localKernelAddress || "—"} testId="device-local-address" />
        <Item label="本机记录的目标数" value={String(connections.length)} testId="device-target-count" />
      </div>

      <div className={c.keyGroup} style={{ marginTop: 16 }}>
        <div className={c.keyGroupHead}>
          <span className={c.keyGroupTitle}>本机记录的连接目标</span>
          <span className={c.keyGroupSub}>这些是桌面端本地保存的配置，不代表远端在线</span>
        </div>
        {connections.length === 0 ? (
          <div className={c.empty}>暂无记录</div>
        ) : (
          <div className={c.list}>
            {connections.map((connection) => (
              <div key={connection.id} className={c.listRow} data-testid={`device-connection-${connection.id}`}>
                <div className={c.listRowMain}>
                  <div className={c.listRowTitle}>
                    {connection.name}
                    <span className={c.kindPill}>{CONNECTION_KIND_LABELS[connection.kind]}</span>
                  </div>
                  <div className={c.listRowSub}>{describeTarget(connection)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
