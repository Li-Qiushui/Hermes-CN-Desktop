import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import s from "./board-settings.module.css";

export interface BoardSettingsValues {
  autoCollapseEmpty: boolean;
  swimlanes: boolean;
  showDone: boolean;
}

interface BoardSettingsProps {
  open: boolean;
  values: BoardSettingsValues;
  showDoneAvailable: boolean;
  onChange: (patch: Partial<BoardSettingsValues>) => void;
  onClose: () => void;
}

export function BoardSettings({ open, values, showDoneAvailable, onChange, onClose }: BoardSettingsProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className={s.backdrop} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className={s.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="看板设置"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={s.head}>
          <h2>看板设置</h2>
          <button type="button" className={s.close} onClick={onClose} aria-label="关闭看板设置">
            <X size={15} aria-hidden="true" />
          </button>
        </header>

        <div className={s.body}>
          <label className={s.row}>
            <input
              type="checkbox"
              aria-label="自动折叠空列"
              checked={values.autoCollapseEmpty}
              onChange={(event) => onChange({ autoCollapseEmpty: event.target.checked })}
            />
            <span className={s.rowText}>
              <span className={s.rowLabel}>自动折叠空列</span>
              <span className={s.rowNote}>没有任务的列收成窄条，拖拽时自动展开</span>
            </span>
          </label>

          <label className={s.row}>
            <input
              type="checkbox"
              aria-label="按负责人分泳道"
              checked={values.swimlanes}
              onChange={(event) => onChange({ swimlanes: event.target.checked })}
            />
            <span className={s.rowText}>
              <span className={s.rowLabel}>按负责人分泳道</span>
              <span className={s.rowNote}>同一列内按负责人分组显示</span>
            </span>
          </label>

          <label className={s.row} data-disabled={showDoneAvailable ? undefined : "true"}>
            <input
              type="checkbox"
              aria-label="显示已完成"
              checked={values.showDone}
              disabled={!showDoneAvailable}
              onChange={(event) => onChange({ showDone: event.target.checked })}
            />
            <span className={s.rowText}>
              <span className={s.rowLabel}>显示已完成</span>
              <span className={s.rowNote}>
                {showDoneAvailable ? "已完成列的卡片默认折叠，开启后展开" : "已归档视图不适用"}
              </span>
            </span>
          </label>
        </div>

        <footer className={s.foot}>
          <span className={s.hint}>改动立即生效</span>
          <button type="button" className={s.done} onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
