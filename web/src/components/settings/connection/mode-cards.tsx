import { Check, Cloud, Globe2, Monitor, Terminal } from "lucide-react";

import type { GatewayMode } from "@/lib/connection-registry";
import c from "./connection.module.css";

export interface ModeOption {
  mode: GatewayMode;
  label: string;
  description: string;
  icon: typeof Monitor;
}

export const MODE_OPTIONS: readonly ModeOption[] = [
  {
    mode: "local",
    label: "本机内核",
    description: "桌面端托管或接管本机 hermes serve，开箱即用。",
    icon: Monitor,
  },
  {
    mode: "remote",
    label: "远程 Hermes",
    description: "直连另一台机器的网关地址，用会话令牌或 OAuth 登录。",
    icon: Globe2,
  },
  {
    mode: "cloud",
    label: "云端实例",
    description: "连接 Nous 云端托管的 Hermes 实例，登录后按实例地址接入。",
    icon: Cloud,
  },
  {
    mode: "ssh",
    label: "SSH 远端",
    description: "通过 ssh 端口转发接入远端内核，适合内网或跳板机场景。",
    icon: Terminal,
  },
];

export function ConnectionModeCards({
  value,
  onChange,
  disabled,
  currentMode,
}: {
  value: GatewayMode;
  onChange: (mode: GatewayMode) => void;
  disabled?: boolean;
  currentMode?: GatewayMode | null;
}) {
  return (
    <div className={c.modeGrid} role="radiogroup" aria-label="连接模式" data-testid="connection-mode-cards">
      {MODE_OPTIONS.map((option) => {
        const Icon = option.icon;
        const active = value === option.mode;
        return (
          <button
            key={option.mode}
            type="button"
            role="radio"
            aria-checked={active}
            className={c.modeCard}
            data-active={active ? "true" : "false"}
            data-testid={`mode-card-${option.mode}`}
            disabled={disabled}
            onClick={() => onChange(option.mode)}
          >
            <span className={c.modeCardHead}>
              <Icon size={14} aria-hidden="true" />
              {option.label}
              {active && <Check className={c.modeCardCheck} size={14} aria-hidden="true" />}
            </span>
            <span className={c.modeCardDesc}>{option.description}</span>
            {currentMode === option.mode && <span className={c.modeCardBadge}>当前目标</span>}
          </button>
        );
      })}
    </div>
  );
}
