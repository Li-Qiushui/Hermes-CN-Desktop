import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, X } from "lucide-react";
import s from "./new-task-dialog.module.css";

export interface NewTaskInput {
  title: string;
  body?: string;
  assignee?: string;
}

interface NewTaskDialogProps {
  open: boolean;
  assignees: string[];
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: NewTaskInput) => void;
}

export function NewTaskDialog({
  open,
  assignees,
  submitting,
  error,
  onClose,
  onSubmit,
}: NewTaskDialogProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [assignee, setAssignee] = useState(assignees[0] ?? "");

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setBody("");
    setAssignee(assignees[0] ?? "");
  }, [open, assignees]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  const canSubmit = title.trim().length > 0 && !submitting;

  return createPortal(
    <div className={s.backdrop} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className={s.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="新建任务"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={s.head}>
          <h2>新建任务</h2>
          <button type="button" className={s.close} onClick={onClose} aria-label="关闭新建任务">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className={s.body}>
          <label className={s.field}>
            <span>标题（必填）</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="一句话说清要做什么"
              autoFocus
              spellCheck={false}
            />
          </label>
          <label className={s.field}>
            <span>描述</span>
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="补充背景、验收标准，支持 Markdown"
              rows={6}
            />
          </label>
          <label className={s.field}>
            <span>负责人</span>
            <select value={assignee} onChange={(event) => setAssignee(event.target.value)}>
              {assignees.length === 0 ? <option value="">默认</option> : null}
              {assignees.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {error ? <p className={s.error} role="alert">{error}</p> : null}
        </div>

        <footer className={s.foot}>
          <button type="button" className={s.cancel} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={s.submit}
            disabled={!canSubmit}
            onClick={() =>
              onSubmit({
                title: title.trim(),
                body: body.trim() ? body : undefined,
                assignee: assignee || undefined,
              })
            }
          >
            <Plus size={15} aria-hidden="true" />
            {submitting ? "创建中…" : "创建任务"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
