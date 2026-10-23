import { useCallback, useEffect, useState } from "react";
import type { SessionSummary } from "@hermes/protocol";
import { exportSessionJson } from "@/lib/session-export";
import { renameSession, type RenameDeps } from "@/lib/session-rename";
import { togglePinnedSession, isSessionPinned, unpinSessions } from "@/lib/session-ui-state";
import type { DeleteSessionsFailure, DeleteSessionsResult } from "@/hooks/use-sessions";
import { showSessionDeleteNotice } from "./session-delete-notice";

export interface UseSessionRowActionsOptions {
  /** Delete sessions and resolve with the ids that succeeded plus per-id failures. */
  deleteSessions: (ids: string[]) => Promise<DeleteSessionsResult>;
  /** True while a delete request is in flight (disables menu/confirm buttons). */
  isDeleting: boolean;
  /** Gateway rename deps, typically destructured from `useGateway()`. */
  setSessionTitle: RenameDeps["setSessionTitle"];
  resumeSession: RenameDeps["resumeSession"];
  /** Archive a single session, typically `useArchiveSession().mutate`. */
  archive: (id: string) => void;
  profile?: string | null;
  /** Side effect after a successful delete (e.g. clear active session / route). */
  onDeleted?: (succeededIds: string[]) => void;
  /** Persist a read-state flip (local override + backend watermark). */
  setUnread?: (ids: string[], unread: boolean) => void;
  /** Persist a pin flip to the backend; falls back to local-only when absent. */
  setPinned?: (ids: string[], pinned: boolean) => void;
}

export interface UseSessionRowActions {
  // menu
  openMenuId: string | null;
  setOpenMenuId: (id: string | null) => void;
  /** True while a delete request is in flight (mirrors the injected option). */
  isDeleting: boolean;
  // pin (state itself lives in the caller via subscribeSessionUiStateChanges)
  togglePin: (sessionId: string) => void;
  // unread
  toggleUnread: (sessionId: string, unread?: boolean) => void;
  // copy id
  copySessionId: (sessionId: string) => Promise<boolean>;
  copiedSessionId: string | null;
  // rename
  renamingSession: SessionSummary | null;
  renameValue: string;
  renameError: string;
  renameSaving: boolean;
  startRename: (session: SessionSummary) => void;
  closeRename: () => void;
  setRenameValue: (next: string) => void;
  submitRename: () => Promise<void>;
  // archive
  handleArchive: (session: SessionSummary) => void;
  exportError: string;
  clearExportError: () => void;
  handleExport: (session: SessionSummary) => Promise<void>;
  // delete (array form works for single or many)
  deleteTargets: SessionSummary[] | null;
  deleteError: string;
  openDeleteDialog: (targets: SessionSummary[]) => void;
  closeDeleteDialog: () => void;
  confirmDelete: () => Promise<void>;
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function deleteFailureMessage(failed: DeleteSessionsFailure[], succeededCount: number): string {
  const reason = failed[0]?.error ?? "未知错误";
  if (succeededCount > 0) {
    return `已删除 ${succeededCount} 个会话，${failed.length} 个删除失败：${reason}`;
  }
  return failed.length === 1 ? `删除失败：${reason}` : `${failed.length} 个会话删除失败：${reason}`;
}

/**
 * State machine for a single session's row actions (pin / rename / export /
 * archive / delete) backing the shared `SessionRowMenu` + action modals.
 *
 * Deliberately excludes bulk-delete selection mode — that stays in the history
 * page. Pin state is not owned here: callers already track pinned ids via
 * `subscribeSessionUiStateChanges`, so `togglePin` only flips persistence and
 * lets the caller's subscription refresh.
 */
export function useSessionRowActions({
  deleteSessions,
  isDeleting: externalDeleting,
  setSessionTitle,
  resumeSession,
  archive,
  profile,
  onDeleted,
  setUnread,
  setPinned,
}: UseSessionRowActionsOptions): UseSessionRowActions {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renamingSession, setRenamingSession] = useState<SessionSummary | null>(null);
  const [renameValue, setRenameValueState] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<SessionSummary[] | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null);
  const isDeleting = submitting || externalDeleting;

  const togglePin = useCallback((sessionId: string) => {
    if (setPinned) setPinned([sessionId], !isSessionPinned(sessionId));
    else togglePinnedSession(sessionId);
  }, [setPinned]);

  const toggleUnread = useCallback(
    (sessionId: string, unread: boolean = false) => {
      setOpenMenuId(null);
      setUnread?.([sessionId], !unread);
    },
    [setUnread],
  );

  const copySessionId = useCallback(async (sessionId: string) => {
    const ok = await copyTextToClipboard(sessionId);
    if (!ok) return false;
    setCopiedSessionId(sessionId);
    window.setTimeout(
      () => setCopiedSessionId((current) => (current === sessionId ? null : current)),
      1500,
    );
    return true;
  }, []);

  // Editing the field clears any prior error, mirroring history's onChange.
  const setRenameValue = useCallback((next: string) => {
    setRenameValueState(next);
    setRenameError("");
  }, []);

  const startRename = useCallback((session: SessionSummary) => {
    setOpenMenuId(null);
    setRenamingSession(session);
    setRenameValueState(
      (session.title || session.preview || session.id).replace(/\s+/g, " ").trim(),
    );
    setRenameError("");
  }, []);

  const closeRename = useCallback(() => {
    setRenamingSession(null);
    setRenameValueState("");
    setRenameError("");
  }, []);

  const submitRename = useCallback(async () => {
    const session = renamingSession;
    if (!session) return;
    const title = renameValue.trim();
    if (!title) {
      setRenameError("请输入会话名称");
      return;
    }
    setRenameSaving(true);
    setRenameError("");
    try {
      await renameSession(session.id, title, { setSessionTitle, resumeSession });
      closeRename();
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : "重命名失败");
    } finally {
      setRenameSaving(false);
    }
  }, [closeRename, renameValue, renamingSession, resumeSession, setSessionTitle]);

  const handleArchive = useCallback(
    (session: SessionSummary) => {
      setOpenMenuId(null);
      archive(session.id);
    },
    [archive],
  );

  const clearExportError = useCallback(() => setExportError(""), []);

  const handleExport = useCallback(
    async (session: SessionSummary) => {
      setOpenMenuId(null);
      setExportError("");
      try {
        await exportSessionJson(session.id, profile);
      } catch (error) {
        setExportError(error instanceof Error ? error.message : "导出会话失败");
      }
    },
    [profile],
  );

  const openDeleteDialog = useCallback((targets: SessionSummary[]) => {
    const uniqueTargets = Array.from(
      new Map(targets.map((session) => [session.id, session])).values(),
    );
    if (uniqueTargets.length === 0) return;
    setOpenMenuId(null);
    setDeleteError("");
    setDeleteTargets(uniqueTargets);
  }, []);

  const closeDeleteDialog = useCallback(() => {
    if (submitting) return;
    setDeleteTargets(null);
    setDeleteError("");
  }, [submitting]);

  useEffect(() => {
    if (submitting) return;
    if (deleteTargets && deleteTargets.length === 0) setDeleteTargets(null);
  }, [deleteTargets, submitting]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTargets?.length || submitting) return;
    const targets = deleteTargets;
    const ids = targets.map((session) => session.id);
    setSubmitting(true);
    setDeleteError("");
    let succeededIds: string[] = [];
    let failed: DeleteSessionsFailure[] = [];
    try {
      const result = await deleteSessions(ids);
      succeededIds = result.succeededIds ?? [];
      failed = result.failed ?? [];
    } catch (error) {
      const reason = error instanceof Error ? error.message : "删除失败";
      failed = targets.map((session) => ({ id: session.id, error: reason }));
    } finally {
      setSubmitting(false);
    }
    if (succeededIds.length > 0) {
      // Defensive: the delete mutation already unpins, but unpinSessions is
      // idempotent (no write/event when nothing changed).
      unpinSessions(succeededIds);
      onDeleted?.(succeededIds);
    }
    if (failed.length === 0) {
      setDeleteError("");
      setDeleteTargets(null);
      return;
    }
    const message = deleteFailureMessage(failed, succeededIds.length);
    if (succeededIds.length > 0) {
      setDeleteError("");
      setDeleteTargets(null);
      showSessionDeleteNotice(message);
      return;
    }
    setDeleteError(message);
  }, [deleteSessions, deleteTargets, onDeleted, submitting]);

  return {
    openMenuId,
    setOpenMenuId,
    isDeleting,
    togglePin,
    toggleUnread,
    copySessionId,
    copiedSessionId,
    renamingSession,
    renameValue,
    renameError,
    renameSaving,
    startRename,
    closeRename,
    setRenameValue,
    submitRename,
    handleArchive,
    exportError,
    clearExportError,
    handleExport,
    deleteTargets,
    deleteError,
    openDeleteDialog,
    closeDeleteDialog,
    confirmDelete,
  };
}
