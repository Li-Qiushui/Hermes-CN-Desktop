import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAtomValue, useSetAtom } from "jotai";
import { AlertCircle, History, MessageSquarePlus } from "lucide-react";
import type { SessionSummary } from "@hermes/protocol";
import { useCreateEmptySession } from "@/hooks/use-create-and-send-session";
import { useSessions } from "@/hooks/use-sessions";
import { activeSessionIdAtom } from "@/stores/ui";
import s from "./new-chat-entries.module.css";

export type NewChatEntriesVariant = "guide" | "inline";

export const RECENT_SESSION_LIMIT = 3;
const RECENT_SESSION_FETCH = RECENT_SESSION_LIMIT + 2;

export function pickRecentSessions(
  sessions: readonly SessionSummary[],
  activeSessionId: string | null | undefined,
  limit = RECENT_SESSION_LIMIT,
): SessionSummary[] {
  return sessions
    .filter((session) => session.id !== activeSessionId)
    .slice()
    .sort((a, b) => (b.ended_at ?? b.started_at) - (a.ended_at ?? a.started_at))
    .slice(0, limit);
}

export function recentSessionTime(unixSec: number | null | undefined, now: Date = new Date()): string {
  if (!unixSec) return "";
  const date = new Date(unixSec * 1000);
  if (date.toDateString() === now.toDateString()) {
    return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export interface NewChatEntriesProps {
  variant?: NewChatEntriesVariant;
  sessions?: readonly SessionSummary[];
}

export function NewChatEntries({ variant = "guide", sessions: providedSessions }: NewChatEntriesProps) {
  const navigate = useNavigate();
  const activeSessionId = useAtomValue(activeSessionIdAtom);
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);
  const createEmptySession = useCreateEmptySession();
  const recentQuery = useSessions(RECENT_SESSION_FETCH, 0, {
    enabled: providedSessions === undefined,
  });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const recent = useMemo(
    () => pickRecentSessions(providedSessions ?? recentQuery.data?.sessions ?? [], activeSessionId),
    [activeSessionId, providedSessions, recentQuery.data],
  );

  const openSession = useCallback(
    (sessionId: string) => {
      setActiveSessionId(sessionId);
      navigate(`/tasks/${sessionId}`);
    },
    [navigate, setActiveSessionId],
  );

  const createBlank = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      await createEmptySession();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  }, [createEmptySession, creating]);

  const inline = variant === "inline";

  return (
    <div className={inline ? s.inline : s.entries} data-new-chat-entries={variant}>
      <div className={s.actions}>
        <button
          type="button"
          className={s.primary}
          onClick={() => void createBlank()}
          disabled={creating}
          title="直接开一个空会话，先配好模型再开口"
          data-empty-create="true"
        >
          <MessageSquarePlus size={13} strokeWidth={1.75} aria-hidden="true" />
          <span>{creating ? "正在新建…" : "新建空会话"}</span>
        </button>
        {inline ? null : <span className={s.actionHint}>建好后先去选模型和工作区，再开口</span>}
      </div>
      {createError ? (
        <p className={s.error} data-empty-create-error="true">
          <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
          新建会话失败：{createError}
        </p>
      ) : null}
      {recent.length > 0 ? (
        <div className={inline ? s.recentInline : s.recent} data-empty-recent="true">
          <span className={s.recentLabel}>最近会话</span>
          <div className={inline ? s.recentListInline : s.recentList}>
            {recent.map((session) => (
              <button
                key={session.id}
                type="button"
                className={inline ? s.recentChip : s.recentItem}
                onClick={() => openSession(session.id)}
                title={session.title || session.id}
              >
                <History size={14} strokeWidth={1.75} aria-hidden="true" className={s.recentIcon} />
                <span className={inline ? s.recentChipTitle : s.recentTitle}>
                  {session.title?.trim() || "未命名会话"}
                </span>
                <span className={s.recentMeta}>
                  {recentSessionTime(session.ended_at ?? session.started_at)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
