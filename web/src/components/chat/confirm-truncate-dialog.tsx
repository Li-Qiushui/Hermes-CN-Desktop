import { useLayoutEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { Button, Dialog } from "@hermes/shared-ui";
import s from "./confirm-truncate-dialog.module.css";

export interface ConfirmTruncateDialogProps {
  open: boolean;
  /** 会被删除的后续消息条数；null = 拿不到精确定位，按「全部后续」措辞。 */
  removedCount: number | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function truncateRemovalSummary(removedCount: number | null): string {
  if (removedCount === null) return "它之后的所有消息（回复和后续提问）";
  return `它之后的 ${removedCount} 条消息（回复和后续提问）`;
}

export function ConfirmTruncateDialog({
  open,
  removedCount,
  onCancel,
  onConfirm,
}: ConfirmTruncateDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    restoreFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
  }, [open]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content
          className={s.dialog}
          role="alertdialog"
          aria-modal="true"
          onCloseAutoFocus={(event) => {
            const target = restoreFocusRef.current;
            restoreFocusRef.current = null;
            if (!target || !target.isConnected) return;
            event.preventDefault();
            target.focus({ preventScroll: true });
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
        >
          <div className={s.head}>
            <AlertTriangle size={14} strokeWidth={1.75} aria-hidden className={s.icon} />
            <Dialog.Title asChild>
              <h2 className={s.title}>删除后续消息并重发？</h2>
            </Dialog.Title>
          </div>
          <Dialog.Description asChild>
            <p className={s.body}>
              重发会把这条消息换成你刚写的内容，{truncateRemovalSummary(removedCount)}
              会被内核删除，删了没法恢复。
            </p>
          </Dialog.Description>
          <div className={s.foot}>
            <Button ref={cancelRef} variant="outline" onClick={onCancel}>
              取消
            </Button>
            <Button variant="outline" tone="danger" onClick={onConfirm}>
              删除后续并重发
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
