import { Cloud, Globe2, Monitor, Terminal } from "lucide-react";

import type { GatewayMode, SavedConnection } from "@/lib/connection-registry";
import { CONNECTION_KIND_LABELS, sshTargetSummary } from "@/lib/connection-registry";
import { Button } from "@hermes/shared-ui";
import c from "./connection.module.css";

const KIND_ICON: Record<GatewayMode, typeof Monitor> = {
  local: Monitor,
  remote: Globe2,
  cloud: Cloud,
  ssh: Terminal,
};

function summary(connection: SavedConnection): string {
  if (connection.kind === "ssh") return sshTargetSummary(connection.ssh ?? { host: "", user: "", port: 22, keyPath: "", remoteHermesPath: "", remoteProfile: "", remotePort: 9119 });
  if (!connection.url) return "未填写地址";
  return connection.url;
}

export function SavedConnectionsList({
  items,
  activeId,
  onSelect,
  onDelete,
  busyId,
  disabled,
}: {
  items: SavedConnection[];
  activeId: string | null;
  onSelect: (connection: SavedConnection) => void;
  onDelete: (connection: SavedConnection) => void;
  busyId?: string | null;
  disabled?: boolean;
}) {
  if (items.length === 0) {
    return (
      <div className={c.empty} data-testid="saved-connections-empty">
        还没有保存过连接。上面四张卡片里填好目标后点「保存」，就会出现在这里，之后可以一键切换。
      </div>
    );
  }

  return (
    <div className={c.list} data-testid="saved-connections-list">
      {items.map((connection) => {
        const Icon = KIND_ICON[connection.kind];
        const active = connection.id === activeId;
        return (
          <div
            key={connection.id}
            className={c.listRow}
            data-active={active ? "true" : "false"}
            data-testid={`saved-connection-${connection.id}`}
          >
            <Icon size={16} aria-hidden="true" />
            <div className={c.listRowMain}>
              <div className={c.listRowTitle}>
                {connection.name}
                <span className={c.kindPill}>{CONNECTION_KIND_LABELS[connection.kind]}</span>
                {active && <span className={c.modeCardBadge}>当前目标</span>}
              </div>
              <div className={c.listRowSub}>{summary(connection)}</div>
            </div>
            <div className={c.listRowActions}>
              <Button
                type="button"
                variant="outline"
                onClick={() => onSelect(connection)}
                disabled={disabled || busyId === connection.id}
                loading={busyId === connection.id}
                data-testid={`saved-connection-switch-${connection.id}`}
              >
                切换
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onDelete(connection)}
                disabled={disabled}
                data-testid={`saved-connection-delete-${connection.id}`}
              >
                删除
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
