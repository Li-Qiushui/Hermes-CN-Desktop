import { useEffect, useRef, useState } from "react";
import { ChevronDown, Clock, Paperclip, Pencil, RotateCcw, SendHorizontal, Trash2, TriangleAlert } from "lucide-react";
import {
  MAX_QUEUED_PER_SESSION,
  entryHasVolatileAttachments,
  type QueuedPromptEntry,
} from "@/stores/composer-queue";
import s from "./queue-panel.module.css";

interface QueuePanelProps {
  entries: QueuedPromptEntry[];
  busy: boolean;
  editingId: string | null;
  onSendNow: (id: string) => void;
  onEdit: (entry: QueuedPromptEntry) => void;
  onDelete: (id: string) => void;
}

export const DRAIN_AFTER_DELETE_DELAY_MS = 300;

function previewText(entry: QueuedPromptEntry): string {
  const text = entry.text.trim();
  if (text) return text;
  return entry.attachments.length > 0 ? "仅附件" : "空消息";
}

function attachmentWarning(entry: QueuedPromptEntry): string | null {
  const lost = entry.lostAttachments ?? 0;
  if (lost > 0) return `${lost} 个附件已丢失，需重新添加`;
  if (entryHasVolatileAttachments(entry)) return "附件重开窗口后会丢失";
  return null;
}

/** Compact list of prompts queued while the agent is busy. */
export function QueuePanel({ entries, busy, editingId, onSendNow, onEdit, onDelete }: QueuePanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const busyRef = useRef(busy);
  const entriesRef = useRef(entries);
  const sendNowRef = useRef(onSendNow);
  const drainTimerRef = useRef<number | null>(null);
  busyRef.current = busy;
  entriesRef.current = entries;
  sendNowRef.current = onSendNow;

  useEffect(
    () => () => {
      if (drainTimerRef.current !== null) window.clearTimeout(drainTimerRef.current);
      drainTimerRef.current = null;
    },
    [],
  );

  if (entries.length === 0) return null;

  const handleDelete = (id: string) => {
    onDelete(id);
    if (busyRef.current) return;
    if (entriesRef.current.filter((entry) => entry.id !== id).length === 0) return;
    if (drainTimerRef.current !== null) window.clearTimeout(drainTimerRef.current);
    drainTimerRef.current = window.setTimeout(() => {
      drainTimerRef.current = null;
      if (busyRef.current) return;
      const next = entriesRef.current.find((entry) => entry.id !== id);
      if (next) sendNowRef.current(next.id);
    }, DRAIN_AFTER_DELETE_DELAY_MS);
  };

  const full = entries.length >= MAX_QUEUED_PER_SESSION;

  return (
    <div className={s.panel}>
      <button
        type="button"
        className={s.head}
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
      >
        <Clock aria-hidden="true" />
        <span className={s.headLabel}>
          已排队 {entries.length} 条{full ? `（上限 ${MAX_QUEUED_PER_SESSION} 条）` : ""}
        </span>
        <ChevronDown className={s.chevron} data-collapsed={collapsed || undefined} aria-hidden="true" />
      </button>
      {!collapsed ? (
        <ul className={s.list}>
          {entries.map((entry) => {
            const warning = attachmentWarning(entry);
            return (
              <li
                key={entry.id}
                className={s.row}
                data-editing={entry.id === editingId || undefined}
                data-lost={(entry.lostAttachments ?? 0) > 0 || undefined}
                data-volatile={warning ? "true" : undefined}
                data-failed={entry.error ? "true" : undefined}
              >
                <div className={s.rowMain}>
                  <span className={s.preview} title={entry.text}>
                    {previewText(entry)}
                  </span>
                  {entry.attachments.length > 0 ? (
                    <span className={s.badge}>
                      <Paperclip aria-hidden="true" />
                      {entry.attachments.length}
                    </span>
                  ) : null}
                  {warning ? (
                    <span className={s.warning} title={warning}>
                      <TriangleAlert aria-hidden="true" />
                      {warning}
                    </span>
                  ) : null}
                  <span className={s.rowActions}>
                    <button
                      type="button"
                      className={s.action}
                      onClick={() => onEdit(entry)}
                      title="编辑"
                      aria-label="编辑此排队消息"
                    >
                      <Pencil aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={s.action}
                      onClick={() => onSendNow(entry.id)}
                      title={busy ? "立即发送（不等当前回合结束）" : "立即发送"}
                      aria-label="立即发送此排队消息"
                    >
                      <SendHorizontal aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={s.action}
                      data-danger="true"
                      onClick={() => handleDelete(entry.id)}
                      title="删除"
                      aria-label="删除此排队消息"
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </span>
                </div>
                {entry.error ? (
                  <span className={s.rowError} role="alert">
                    <TriangleAlert aria-hidden="true" />
                    <span className={s.errorText} title={entry.error}>
                      发送失败：{entry.error}
                    </span>
                    <button
                      type="button"
                      className={s.retry}
                      onClick={() => onSendNow(entry.id)}
                      title="重新发送这条排队消息"
                    >
                      <RotateCcw aria-hidden="true" />
                      <span>重试</span>
                    </button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
