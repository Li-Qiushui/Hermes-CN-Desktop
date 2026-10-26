import { useState } from "react";
import { ChevronDown, ChevronUp, Settings2, TriangleAlert, X } from "lucide-react";
import type { StreamErrorCard } from "@/stores/chat";
import s from "./stream-error-card.module.css";

export interface StreamErrorCardViewProps {
  card: StreamErrorCard;
  onDismiss: () => void;
  onOpenSettings?: (path: string) => void;
}

const SETTINGS_KINDS = new Set(["config", "auth"]);

export function StreamErrorCardView({ card, onDismiss, onOpenSettings }: StreamErrorCardViewProps) {
  const [showDetail, setShowDetail] = useState(true);
  const canOpenSettings = SETTINGS_KINDS.has(card.kind) && Boolean(onOpenSettings);

  return (
    <div className={s.card} role="alert" data-stream-error-card="true" data-kind={card.kind}>
      <div className={s.head}>
        <TriangleAlert className={s.icon} size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className={s.title}>{card.title}</span>
        {card.code ? <span className={s.code}>{card.code}</span> : null}
        <button
          type="button"
          className={s.close}
          onClick={onDismiss}
          title="关掉这张错误卡"
          aria-label="关闭错误提示"
          data-error-card-action="dismiss"
        >
          <X size={13} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {showDetail ? <div className={s.detail}>{card.detail}</div> : null}
      <div className={s.actions}>
        <button
          type="button"
          className={s.action}
          onClick={() => setShowDetail((open) => !open)}
          data-error-card-action="toggle-detail"
        >
          {showDetail ? (
            <ChevronUp size={13} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <ChevronDown size={13} strokeWidth={1.75} aria-hidden="true" />
          )}
          <span>{showDetail ? "隐藏详情" : "展开详情"}</span>
        </button>
        {canOpenSettings ? (
          <button
            type="button"
            className={`${s.action} ${s.actionPrimary}`}
            onClick={() => onOpenSettings?.("/models")}
            data-error-card-action="open-settings"
          >
            <Settings2 size={13} strokeWidth={1.75} aria-hidden="true" />
            <span>打开设置</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
