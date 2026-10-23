import { useLayoutEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { Button, Dialog } from "@hermes/shared-ui";
import s from "./confirm-truncate-dialog.module.css";

export type TruncateDialogMode = "resend" | "delete";

export interface ConfirmTruncateDialogProps {
  open: boolean;
  /** 会被删除的后续消息条数；null = 拿不到精确定位，按「全部后续」措辞。 */
  removedCount: number | null;
  mode?: TruncateDialogMode;
  onCancel: () => void;
  onConfirm: () => void;
}

export function truncateRemovalSummary(removedCount: number | null): string {
  if (removedCount === null) return "它之后的所有消息（回复和后续提问）";
  return `它之后的 ${removedCount} 条消息（回复和后续提问）`;
}

const DELETE_TITLE = "删除这条提问及之后的消息？";
const DELETE_CONFIRM_LABEL = "删除";

export function truncateDialogCopy(
  removedCount: number | null,
  mode: TruncateDialogMode = "resend",
): { title: string; description: string; confirmLabel: string } {
  if (mode === "delete") {
    const count = removedCount === null ? "" : `，共 ${removedCount + 1} 条`;
    return {
      title: DELETE_TITLE,
      description: `将删除这条提问及其之后的全部消息（回复和后续提问）${count}，删了没法恢复。`,
      confirmLabel: DELETE_CONFIRM_LABEL,
    };
  }
  return {
    title: "删除后续消息并重发？",
    description: `重发会把这条消息换成你刚写的内容，${truncateRemovalSummary(removedCount)}会被内核删除，删了没法恢复。`,
    confirmLabel: "删除后续并重发",
  };
}

export function ConfirmTruncateDialog({
  open,
  removedCount,
  mode = "resend",
  onCancel,
  onConfirm,
}: ConfirmTruncateDialogProps) {
  const copy = truncateDialogCopy(removedCount, mode);
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
              <h2 className={s.title}>{copy.title}</h2>
            </Dialog.Title>
          </div>
          <Dialog.Description asChild>
            <p className={s.body}>{copy.description}</p>
          </Dialog.Description>
          <div className={s.foot}>
            <Button ref={cancelRef} variant="outline" onClick={onCancel}>
              取消
            </Button>
            <Button variant="outline" tone="danger" onClick={onConfirm}>
              {copy.confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
