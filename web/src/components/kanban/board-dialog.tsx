import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, X } from "lucide-react";
import { buildCreateBoardBody, checkBoardSlug } from "@/lib/kanban-orchestration";
import s from "./board-dialog.module.css";

export interface BoardCreateInput {
  slug: string;
  name: string;
  icon: string;
}

export interface BoardDialogProps {
  open: boolean;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: BoardCreateInput) => void;
}

export function BoardDialog({ open, submitting, error, onClose, onSubmit }: BoardDialogProps) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");

  useEffect(() => {
    if (!open) return;
    setSlug("");
    setName("");
    setIcon("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  const slugCheck = checkBoardSlug(slug);
  const preview = buildCreateBoardBody({ slug, name, icon });

  const submit = () => {
    if (!preview.ok || submitting) return;
    onSubmit({ slug: slugCheck.slug, name: name.trim(), icon: icon.trim() });
  };

  return createPortal(
    <div className={s.backdrop} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={s.dialog} role="dialog" aria-modal="true" aria-label="新建看板" onMouseDown={(event) => event.stopPropagation()}>
        <header className={s.head}>
          <span className={s.headTitle}>
            <Plus size={15} aria-hidden="true" /> 新建看板
          </span>
          <button type="button" className={s.close} onClick={onClose} aria-label="关闭新建看板">
            <X size={15} aria-hidden="true" />
          </button>
        </header>

        <div className={s.body}>
          <label className={s.field}>
            <span>slug（不可重复，建好后不可改）</span>
            <input
              className={s.input}
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              placeholder="例如 hermes-cn-desktop"
              aria-label="看板 slug"
              spellCheck={false}
            />
          </label>
          {slug && !slugCheck.ok ? <p className={s.error}>{slugCheck.error}</p> : null}
          {slug && slugCheck.ok && slugCheck.slug !== slug.trim().toLowerCase() ? (
            <p className={s.hint}>实际会创建为 {slugCheck.slug}</p>
          ) : null}

          <label className={s.field}>
            <span>名称</span>
            <input
              className={s.input}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="留空就用 slug"
              aria-label="看板名称"
              spellCheck={false}
            />
          </label>

          <label className={s.field}>
            <span>图标（单个字符或 emoji，可选）</span>
            <input
              className={s.input}
              value={icon}
              onChange={(event) => setIcon(event.target.value.slice(0, 4))}
              placeholder="🗂"
              aria-label="看板图标"
              spellCheck={false}
            />
          </label>

          {error ? (
            <p className={s.error} role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className={s.foot}>
          <span className={s.hint}>建好后会自动切到新看板。</span>
          <button type="button" className={s.primary} onClick={submit} disabled={!preview.ok || submitting}>
            {submitting ? "创建中…" : "创建看板"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
