import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useLocation } from "react-router-dom";
import { Popover, StatusDot, type StatusDotTone } from "@hermes/shared-ui";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
} from "lucide-react";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { activeSessionIdAtom } from "@/stores/ui";
import { readUiValue, writeUiValue } from "@/lib/ui-store";
import { useActiveProfileName } from "@/hooks/use-profiles";
import {
  prefetchSessionMessages,
  useArchiveSession,
  useDeleteSessions,
  usePagedSessions,
  useSessions,
} from "@/hooks/use-sessions";
import { useGateway } from "@/hooks/use-gateway";
import { useSessionBranch } from "@/hooks/use-session-branch";
import {
  isSessionRunning,
  mergeLiveRuntimeSessions,
  sessionIdMatches,
} from "@/lib/session-activity";
import { sessionDisplayTitle } from "@/lib/session-title";
import { getSourceMeta } from "@/lib/source-meta";
import {
  readPinnedSessionIds,
  readSessionTitleOverrides,
  subscribeSessionUiStateChanges,
  unpinSessions,
  writePinnedSessionIds,
} from "@/lib/session-ui-state";
import {
  RECENT_SESSION_PAGE_SIZE,
  allSessionPagesLoaded,
  deriveSidebarWorkspaces,
  filterSessionsByQuery,
  groupSessionsByDay,
  mergeSessionPages,
  selectSessionsById,
  sessionPagesTotal,
  toggleSelectedSessionId,
  type SessionDayGroupKey,
} from "@/lib/sidebar-session-lists";
import {
  SessionDeleteModal,
  SessionBranchErrorModal,
  SessionExportErrorModal,
  SessionRenameModal,
  SessionRowMenu,
  useSessionRowActions,
  type UseSessionRowActions,
} from "@/components/session-actions";
import {
  readPinnedWorkspaceProjectPaths,
  readSessionWorkspaceMap,
  readWorkspaceProjects,
  subscribeWorkspaceChanges,
  unpinWorkspaceProjects,
  workspaceNameFromPath,
  type WorkspaceProject,
} from "@/lib/workspaces";
import type { SessionSummary } from "@hermes/protocol";
import s from "./workbench-sidebar.module.css";

type SidebarSessionsView = "recent" | "pinned" | "workspaces";

const SIDEBAR_VIEW_KEY = "hermes.sidebar-sessions-view";
const SIDEBAR_GROUPS_KEY = "hermes.sidebar-session-groups";
const FOCUSED_VIEW_LIMIT = 100;

const VIEW_OPTIONS: Array<{ value: SidebarSessionsView; label: string }> = [
  { value: "recent", label: "最近" },
  { value: "pinned", label: "置顶" },
  { value: "workspaces", label: "工作区" },
];

function readSidebarView(): SidebarSessionsView {
  const value = readUiValue<unknown>(SIDEBAR_VIEW_KEY, "recent");
  return value === "pinned" || value === "workspaces" ? value : "recent";
}

function readGroupExpanded(): Record<SessionDayGroupKey, boolean> {
  const raw = readUiValue<unknown>(SIDEBAR_GROUPS_KEY, {});
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  return {
    today: record.today !== false,
    yesterday: record.yesterday !== false,
    earlier: record.earlier !== false,
  };
}

function relTime(unixSec: number, now: Date) {
  const d = new Date(unixSec * 1000);
  if (d.toDateString() === now.toDateString()) {
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function elapsed(unixSec: number, now: Date) {
  const ms = now.getTime() - unixSec * 1000;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${s.toString().padStart(2, "0")}s`;
  }
  return `${Math.floor(ms / 3_600_000)}h`;
}

function modelShort(model: string | null | undefined) {
  if (!model) return "—";
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function KanbanQuickIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.2" y="2.4" width="11.6" height="11.2" rx="0" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 4.8v6.4M10 4.8v6.4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <rect x="3.8" y="4.5" width="2.2" height="3" rx="0" fill="currentColor" opacity="0.8" />
      <rect x="6.9" y="4.5" width="2.2" height="4.8" rx="0" fill="currentColor" opacity="0.58" />
      <rect x="10" y="4.5" width="2.2" height="2.6" rx="0" fill="currentColor" opacity="0.72" />
    </svg>
  );
}

interface SessionRowProps {
  session: SessionSummary;
  state: "live" | "ok" | "err" | "idle";
  active: boolean;
  selected: boolean;
  time: string;
  projectName?: string;
  pinned: boolean;
  menuDisabled?: boolean;
  actions: UseSessionRowActions;
  onClick: () => void;
  onToggleSelect: () => void;
  onHover?: () => void;
  onBranch: () => void;
  branching?: boolean;
}

function SessionRow({
  session,
  state,
  active,
  selected,
  time,
  projectName,
  pinned,
  menuDisabled = false,
  actions,
  onClick,
  onToggleSelect,
  onHover,
  onBranch,
  branching = false,
}: SessionRowProps) {
  const title = sessionDisplayTitle(session);
  const dotState = state === "idle" ? undefined : state;
  const dotTone: StatusDotTone | null = dotState === "live"
    ? "accent"
    : dotState === "ok"
      ? "neutral"
      : dotState === "err"
        ? "danger"
        : null;
  const source = session.source?.trim() ? getSourceMeta(session.source).label : null;
  const model = session.model ? modelShort(session.model) : null;
  const actionMenuDisabled = menuDisabled || actions.isDeleting || branching;
  return (
    <div
      className={s.sessionRow}
      data-session-row={session.id}
      data-active={active ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      role="button"
      tabIndex={0}
      onClick={(event) => {
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          onToggleSelect();
          return;
        }
        onClick();
      }}
      onContextMenu={(event) => {
        if (actionMenuDisabled) return;
        event.preventDefault();
        event.stopPropagation();
        actions.setOpenMenuId(session.id);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (event.ctrlKey || event.metaKey) {
            onToggleSelect();
            return;
          }
          onClick();
        }
      }}
      onMouseEnter={onHover}
      onFocus={onHover}
      title={title}
    >
      <span className={s.selectMark} data-checked={selected ? "true" : undefined} aria-hidden="true">
        {selected ? <Check size={11} strokeWidth={2.6} /> : null}
      </span>
      <div className={s.rowMain}>
        <div className={s.rowTop}>
          <span className={s.ttlText}>{title}</span>
          {pinned ? <span className={s.rowPinnedFlag}>置顶</span> : null}
          {dotTone ? <StatusDot tone={dotTone} size="sm" className={s.rowDot} /> : null}
        </div>
        <div className={s.rowBottom}>
          {source ? <span className={s.sourceChip}>{source}</span> : null}
          {model ? (
            <span className={s.rowModel} title={model}>
              {model}
            </span>
          ) : null}
          {projectName ? (
            <span className={s.rowProject} title={projectName}>
              {projectName}
            </span>
          ) : null}
          <span className={s.rowTime}>{time}</span>
        </div>
      </div>
      <Popover.Root
        open={!actionMenuDisabled && actions.openMenuId === session.id}
        onOpenChange={(open) => {
          actions.setOpenMenuId(open && !actionMenuDisabled ? session.id : null);
        }}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            className={s.rowMore}
            aria-label="会话操作"
            title={menuDisabled ? "运行中任务暂不可操作" : "会话操作"}
            disabled={actionMenuDisabled}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => {
              if (actionMenuDisabled) return;
              event.preventDefault();
              actions.setOpenMenuId(session.id);
            }}
          >
            <MoreHorizontal size={13} />
          </button>
        </Popover.Trigger>
        <SessionRowMenu
          pinned={pinned}
          disabled={actionMenuDisabled}
          onTogglePin={() => actions.togglePin(session.id)}
          onRename={() => actions.startRename(session)}
          onBranch={onBranch}
          onExport={() => void actions.handleExport(session)}
          onArchive={() => actions.handleArchive(session)}
          onDelete={() => actions.openDeleteDialog([session])}
        />
      </Popover.Root>
    </div>
  );
}

export function WorkbenchSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const setActiveId = useSetAtom(activeSessionIdAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const queryClient = useQueryClient();
  const profile = useActiveProfileName();

  const [view, setView] = useState<SidebarSessionsView>(readSidebarView);
  const [query, setQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<SessionDayGroupKey, boolean>>(readGroupExpanded);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set<string>());
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [titleOverrides, setTitleOverrides] = useState(readSessionTitleOverrides);
  const [pinnedSessionIds, setPinnedSessionIds] = useState(readPinnedSessionIds);
  const [projects, setProjects] = useState<WorkspaceProject[]>(readWorkspaceProjects);
  const [pinnedProjectPaths, setPinnedProjectPaths] = useState(readPinnedWorkspaceProjectPaths);
  const [sessionWorkspaceMap, setSessionWorkspaceMap] = useState(readSessionWorkspaceMap);

  const recentPages = usePagedSessions(RECENT_SESSION_PAGE_SIZE, { order: "recent" });
  const focusedEnabled = view === "workspaces" || pinnedSessionIds.size > 0;
  const focusedQuery = useSessions(FOCUSED_VIEW_LIMIT, 0, {
    cwdPrefix: workspacePath ?? undefined,
    order: "recent",
    enabled: focusedEnabled,
  });

  const archiveSession = useArchiveSession();
  const deleteSessions = useDeleteSessions();
  const { setSessionTitle, resumeSession } = useGateway();
  const sessionBranch = useSessionBranch();

  useEffect(() => {
    writeUiValue(SIDEBAR_VIEW_KEY, view);
  }, [view]);

  useEffect(() => {
    writeUiValue(SIDEBAR_GROUPS_KEY, expandedGroups);
  }, [expandedGroups]);

  useEffect(
    () =>
      subscribeSessionUiStateChanges(() => {
        setTitleOverrides(readSessionTitleOverrides());
        setPinnedSessionIds(readPinnedSessionIds());
      }),
    [],
  );
  useEffect(
    () =>
      subscribeWorkspaceChanges(() => {
        setProjects(readWorkspaceProjects());
        setPinnedProjectPaths(readPinnedWorkspaceProjectPaths());
        setSessionWorkspaceMap(readSessionWorkspaceMap());
      }),
    [],
  );

  const applyOverrides = useCallback(
    (sessions: SessionSummary[] | undefined) =>
      (sessions ?? []).map((sess) => {
        const override = titleOverrides[sess.id];
        return override ? { ...sess, title: override } : sess;
      }),
    [titleOverrides],
  );

  const recentSessions = useMemo(
    () => mergeSessionPages(recentPages.data?.pages ?? []),
    [recentPages.data?.pages],
  );

  const liveRecentSessions = useMemo(
    () => mergeLiveRuntimeSessions(applyOverrides(recentSessions), runtimeBySession),
    [applyOverrides, recentSessions, runtimeBySession],
  );

  const liveFocusedSessions = useMemo(
    () => mergeLiveRuntimeSessions(applyOverrides(focusedQuery.data?.sessions), runtimeBySession),
    [applyOverrides, focusedQuery.data?.sessions, runtimeBySession],
  );

  const recentPagesData = recentPages.data?.pages ?? [];
  const recentTotal = sessionPagesTotal(recentPagesData);
  const recentLoadedAll = recentPagesData.length > 0 && allSessionPagesLoaded(recentPagesData);

  useEffect(() => {
    if (pinnedSessionIds.size === 0 || !recentLoadedAll) return;
    if (recentTotal > liveRecentSessions.length) return;
    const liveIds = new Set(liveRecentSessions.map((session) => session.id));
    const staleIds = Array.from(pinnedSessionIds).filter((id) => !liveIds.has(id));
    if (staleIds.length > 0) setPinnedSessionIds(unpinSessions(staleIds));
  }, [liveRecentSessions, pinnedSessionIds, recentLoadedAll, recentTotal]);

  const [now, setNow] = useState(() => new Date());
  const [liveNow, setLiveNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => {
      const tick = new Date();
      setNow(tick);
      setLiveNow(tick);
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  const timeFor = useCallback(
    (sess: SessionSummary) =>
      isSessionRunning(sess, runtimeBySession)
        ? elapsed(sess.started_at, liveNow)
        : relTime(sess.ended_at ?? sess.started_at, now),
    [liveNow, now, runtimeBySession],
  );

  const pinnedSessions = useMemo(() => {
    const byId = new Map<string, SessionSummary>();
    for (const session of liveFocusedSessions) byId.set(session.id, session);
    for (const session of liveRecentSessions) if (!byId.has(session.id)) byId.set(session.id, session);
    return Array.from(pinnedSessionIds).flatMap((id) => {
      const session = byId.get(id);
      return session ? [session] : [];
    });
  }, [liveFocusedSessions, liveRecentSessions, pinnedSessionIds]);

  const projectNameBySessionId = useMemo(() => {
    const projectNameByPath = new Map(projects.map((project) => [project.path, project.name]));
    return new Map(
      Object.entries(sessionWorkspaceMap).flatMap(([sessionId, path]) => {
        const projectName = projectNameByPath.get(path) ?? workspaceNameFromPath(path);
        return projectName ? [[sessionId, projectName]] : [];
      }),
    );
  }, [projects, sessionWorkspaceMap]);

  const workspaces = useMemo(
    () => deriveSidebarWorkspaces(liveRecentSessions, projects, workspaceNameFromPath),
    [liveRecentSessions, projects],
  );

  useEffect(() => {
    if (pinnedProjectPaths.size === 0) return;
    const livePaths = new Set(projects.map((project) => project.path));
    const stalePaths = Array.from(pinnedProjectPaths).filter((path) => !livePaths.has(path));
    if (stalePaths.length > 0) setPinnedProjectPaths(unpinWorkspaceProjects(stalePaths));
  }, [pinnedProjectPaths, projects]);

  const goSession = (sess: SessionSummary) => {
    setActiveId(sess.id);
    navigate(`/tasks/${sess.id}`);
  };

  const hoverSession = (sess: SessionSummary) => {
    prefetchSessionMessages(queryClient, profile, sess.id);
  };

  const activeSessionId = location.pathname.startsWith("/tasks/")
    ? decodeURIComponent(location.pathname.slice("/tasks/".length))
    : null;

  const onSessionsDeleted = useCallback(
    (succeededIds: string[]) => {
      if (activeSessionId && succeededIds.includes(activeSessionId)) {
        setActiveId(null);
        navigate("/");
      }
    },
    [activeSessionId, navigate, setActiveId],
  );

  const rowActions = useSessionRowActions({
    deleteSessions: (ids) => deleteSessions.mutateAsync(ids),
    isDeleting: deleteSessions.isPending,
    setSessionTitle,
    resumeSession,
    archive: archiveSession.mutate,
    profile,
    onDeleted: onSessionsDeleted,
  });

  const activeSessions = useMemo(() => {
    const pinnedIdSet = new Set(pinnedSessionIds);
    return liveRecentSessions.filter(
      (session) => !pinnedIdSet.has(session.id) && isSessionRunning(session, runtimeBySession),
    );
  }, [liveRecentSessions, pinnedSessionIds, runtimeBySession]);

  const hasActiveSessions = activeSessions.length > 0;

  useEffect(() => {
    if (!hasActiveSessions) return;
    const timer = setInterval(() => setLiveNow(new Date()), 1_000);
    return () => clearInterval(timer);
  }, [hasActiveSessions]);

  const sessionTimes = useMemo(() => {
    const map = new Map<string, string>();
    for (const sess of liveRecentSessions) map.set(sess.id, timeFor(sess));
    for (const sess of liveFocusedSessions) {
      if (!map.has(sess.id)) map.set(sess.id, timeFor(sess));
    }
    return map;
  }, [liveFocusedSessions, liveRecentSessions, timeFor]);

  const visibleRecent = useMemo(() => {
    const pinnedIdSet = new Set(pinnedSessionIds);
    return filterSessionsByQuery(
      liveRecentSessions.filter((session) => !pinnedIdSet.has(session.id)),
      query,
    );
  }, [liveRecentSessions, pinnedSessionIds, query]);

  const visiblePinned = useMemo(
    () => filterSessionsByQuery(pinnedSessions, query),
    [pinnedSessions, query],
  );

  const visibleWorkspaceSessions = useMemo(
    () => filterSessionsByQuery(liveFocusedSessions, query),
    [liveFocusedSessions, query],
  );

  const visibleWorkspaces = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return workspaces;
    return workspaces.filter((workspace) =>
      workspace.name.toLowerCase().includes(needle)
      || workspace.path.toLowerCase().includes(needle),
    );
  }, [query, workspaces]);

  const dayGroups = useMemo(() => groupSessionsByDay(visibleRecent, now), [visibleRecent, now]);

  const orderedVisibleSessions = useMemo(() => {
    if (view === "pinned") return visiblePinned;
    if (view === "workspaces" && workspacePath) return visibleWorkspaceSessions;
    return visibleRecent;
  }, [view, visiblePinned, visibleRecent, visibleWorkspaceSessions, workspacePath]);

  const selectedSessions = useMemo(() => {
    const pool = [...liveRecentSessions, ...liveFocusedSessions, ...pinnedSessions];
    const unique = Array.from(new Map(pool.map((session) => [session.id, session])).values());
    return selectSessionsById(unique, selectedIds);
  }, [liveFocusedSessions, liveRecentSessions, pinnedSessions, selectedIds]);

  const visibleSessionIds = useMemo(
    () => new Set(orderedVisibleSessions.map((session) => session.id)),
    [orderedVisibleSessions],
  );

  useEffect(() => {
    setSelectedIds((current) => {
      if (current.size === 0) return current;
      const next = new Set(Array.from(current).filter((id) => visibleSessionIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [visibleSessionIds]);

  const clearSelection = useCallback(() => setSelectedIds(new Set<string>()), []);

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((current) => toggleSelectedSessionId(current, id));
  }, []);

  const bulkPinDisabled = selectedSessions.length === 0
    || selectedSessions.some((session) => pinnedSessionIds.has(session.id));
  const bulkArchiveDisabled = selectedSessions.length === 0
    || selectedSessions.some((session) => session.archived === true);

  const handleBulkPin = useCallback(() => {
    if (selectedSessions.length === 0) return;
    const next = new Set(pinnedSessionIds);
    for (const session of selectedSessions) next.add(session.id);
    setPinnedSessionIds(writePinnedSessionIds(next));
    clearSelection();
  }, [clearSelection, pinnedSessionIds, selectedSessions]);

  const handleBulkArchive = useCallback(() => {
    if (selectedSessions.length === 0) return;
    for (const session of selectedSessions) archiveSession.mutate(session.id);
    clearSelection();
  }, [archiveSession, clearSelection, selectedSessions]);

  const handleBulkDelete = useCallback(() => {
    if (selectedSessions.length === 0) return;
    rowActions.openDeleteDialog(selectedSessions);
    clearSelection();
  }, [clearSelection, rowActions, selectedSessions]);

  const rowState = (sess: SessionSummary): "live" | "ok" | "err" => {
    if (isSessionRunning(sess, runtimeBySession)) return "live";
    return sess.end_reason === "error" || sess.end_reason === "interrupted" ? "err" : "ok";
  };

  const renderRow = (sess: SessionSummary, menuDisabled = false) => (
    <SessionRow
      key={sess.id}
      session={sess}
      state={rowState(sess)}
      active={sessionIdMatches(sess.id, activeSessionId)}
      selected={selectedIds.has(sess.id)}
      time={sessionTimes.get(sess.id) ?? timeFor(sess)}
      projectName={projectNameBySessionId.get(sess.id)}
      pinned={pinnedSessionIds.has(sess.id)}
      menuDisabled={menuDisabled || isSessionRunning(sess, runtimeBySession)}
      actions={rowActions}
      onClick={() => goSession(sess)}
      onToggleSelect={() => toggleSelection(sess.id)}
      onHover={() => hoverSession(sess)}
      onBranch={() => void sessionBranch.branchSession(sess)}
      branching={sessionBranch.branchingSessionId === sess.id}
    />
  );

  const workspaceDetail = workspacePath
    ? workspaces.find((workspace) => workspace.path === workspacePath)
      ?? { path: workspacePath, name: workspaceNameFromPath(workspacePath), sessionCount: 0 }
    : null;

  const noMatchHint = (
    <div className={s.empty}>没有匹配的对话，搜索全部会话请用 ⌘K</div>
  );
  const searching = query.trim().length > 0;
  const recentPending = recentPages.isLoading && dayGroups.length === 0;
  const recentFailed = recentPages.isError && dayGroups.length === 0;

  const listLoading = (
    <div className={s.listSkeleton} data-state="loading" role="status">
      <span className={s.listStatus}>正在读取会话…</span>
      <span className={s.skeletonRow} aria-hidden="true" />
      <span className={s.skeletonRow} aria-hidden="true" />
      <span className={s.skeletonRow} aria-hidden="true" />
    </div>
  );

  const listError = (
    <div className={s.listError} data-state="error" role="alert">
      <span className={s.listStatus}>会话列表加载失败</span>
      <button
        type="button"
        className={s.retryButton}
        data-action="retry-sessions"
        onClick={() => void recentPages.refetch()}
      >
        重试
      </button>
    </div>
  );

  return (
    <aside className={s.sidebar} data-sidebar="sessions">
      <button type="button" className={s.newTask} onClick={() => navigate("/")}>
        <span className={s.newTaskLead}>
          <span className={s.entryIcon}>
            <Plus size={16} strokeWidth={2.2} />
          </span>
          <span className={s.entryLabel}>新建对话</span>
        </span>
      </button>

      <div className={s.quickNav}>
        <button
          type="button"
          className={s.quickNavButton}
          data-active={location.pathname.startsWith("/history") ? "true" : undefined}
          onClick={() => navigate("/history")}
        >
          <span className={s.entryIcon}>
            <MessageSquare size={16} />
          </span>
          <span className={s.entryLabel}>对话历史</span>
          <span className={s.entryCommand}>/history</span>
        </button>
        <button
          type="button"
          className={s.quickNavButton}
          data-active={location.pathname.startsWith("/projects") ? "true" : undefined}
          onClick={() => navigate("/projects")}
        >
          <span className={s.entryIcon}>
            <Folder size={16} />
          </span>
          <span className={s.entryLabel}>工作空间</span>
          <span className={s.entryCommand}>/workspace</span>
        </button>
        <button
          type="button"
          className={s.quickNavButton}
          data-active={location.pathname.startsWith("/kanban") ? "true" : undefined}
          onClick={() => navigate("/kanban")}
        >
          <span className={s.entryIcon}>
            <KanbanQuickIcon />
          </span>
          <span className={s.entryLabel}>看板</span>
          <span className={s.entryCommand}>/kanban</span>
        </button>
      </div>

      <div className={s.searchWrap}>
        <Search size={14} className={s.searchIcon} aria-hidden="true" />
        <input
          type="search"
          className={s.searchInput}
          value={query}
          placeholder="搜索对话"
          aria-label="搜索对话"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className={s.seg} role="radiogroup" aria-label="对话视图">
        {VIEW_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={view === option.value}
            className={s.segOption}
            data-active={view === option.value ? "true" : undefined}
            data-view={option.value}
            onClick={() => {
              setView(option.value);
              if (option.value !== "workspaces") setWorkspacePath(null);
              clearSelection();
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className={s.scrollY} data-view={view}>
        {view === "recent" ? (
          <>
            {activeSessions.length > 0 ? (
              <section className={s.section} data-section="active">
                <div className={s.label}>
                  <span>进行中</span>
                  <span className={s.labelCount}>{activeSessions.length}</span>
                </div>
                {activeSessions.map((sess) => renderRow(sess, true))}
              </section>
            ) : null}

            {recentPending ? (
              listLoading
            ) : recentFailed ? (
              listError
            ) : dayGroups.length === 0 ? (
              searching ? noMatchHint : <div className={s.empty}>还没有历史对话</div>
            ) : (
              dayGroups.map((group) => {
                const expanded = expandedGroups[group.key];
                return (
                  <section className={s.section} key={group.key} data-day-group={group.key}>
                    <button
                      type="button"
                      className={s.groupHeader}
                      aria-expanded={expanded}
                      onClick={() => {
                        setExpandedGroups((current) => ({
                          ...current,
                          [group.key]: !current[group.key],
                        }));
                      }}
                    >
                      <span className={s.groupChevron}>
                        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      </span>
                      <span className={s.groupLabel}>{group.label}</span>
                      <span className={s.labelCount}>{group.items.length}</span>
                    </button>
                    {expanded ? group.items.map((sess) => renderRow(sess)) : null}
                  </section>
                );
              })
            )}

            {visibleRecent.length > 0 ? (
              <div className={s.loadMoreRow}>
                {recentLoadedAll ? (
                  <span className={s.loadMoreDone}>已全部加载</span>
                ) : (
                  <button
                    type="button"
                    className={s.loadMore}
                    data-action="load-more"
                    disabled={recentPages.isFetchingNextPage}
                    onClick={() => void recentPages.fetchNextPage()}
                  >
                    {recentPages.isFetchingNextPage ? "加载中…" : "加载更多"}
                  </button>
                )}
              </div>
            ) : null}
          </>
        ) : null}

        {view === "pinned" ? (
          recentPending ? (
            listLoading
          ) : recentFailed ? (
            listError
          ) : visiblePinned.length === 0 ? (
            searching ? noMatchHint : <div className={s.empty}>还没有置顶对话</div>
          ) : (
            <section className={s.section} data-section="pinned">
              {visiblePinned.map((sess) => renderRow(sess))}
            </section>
          )
        ) : null}

        {view === "workspaces" ? (
          workspaceDetail ? (
            <>
              <button
                type="button"
                className={s.backButton}
                onClick={() => {
                  setWorkspacePath(null);
                  clearSelection();
                }}
              >
                <ArrowLeft size={14} />
                <span>全部工作区</span>
              </button>
              <div className={s.workspaceTitle} title={workspaceDetail.path}>
                <span className={s.workspaceTitleName}>{workspaceDetail.name}</span>
                <span className={s.labelCount}>{visibleWorkspaceSessions.length}</span>
              </div>
              {visibleWorkspaceSessions.length === 0 ? (
                searching ? noMatchHint : <div className={s.empty}>该工作区还没有对话</div>
              ) : (
                <section className={s.section} data-section="workspace-sessions">
                  {visibleWorkspaceSessions.map((sess) => renderRow(sess))}
                </section>
              )}
            </>
          ) : recentPending ? (
            listLoading
          ) : recentFailed ? (
            listError
          ) : searching && visibleWorkspaces.length === 0 ? (
            noMatchHint
          ) : workspaces.length === 0 ? (
            <div className={s.empty}>还没有工作区</div>
          ) : (
            <section className={s.section} data-section="workspaces">
              {visibleWorkspaces.map((workspace) => (
                <button
                  type="button"
                  key={workspace.path}
                  className={s.workspaceItem}
                  data-workspace-path={workspace.path}
                  onClick={() => setWorkspacePath(workspace.path)}
                  title={workspace.path}
                >
                  <span className={s.workspaceIcon}>
                    <Folder size={15} />
                  </span>
                  <span className={s.workspaceName}>{workspace.name}</span>
                  <span className={s.workspaceCount}>{workspace.sessionCount}</span>
                </button>
              ))}
            </section>
          )
        ) : null}
      </div>

      {selectedSessions.length > 0 ? (
        <div className={s.bulkBar} role="toolbar" aria-label="批量操作">
          <span className={s.bulkCount}>已选 {selectedSessions.length} 个</span>
          <div className={s.bulkActions}>
            <button
              type="button"
              className={s.bulkAction}
              disabled={bulkPinDisabled}
              title={bulkPinDisabled ? "选中的对话已包含置顶项" : "置顶选中的对话"}
              onClick={handleBulkPin}
            >
              置顶
            </button>
            <button
              type="button"
              className={s.bulkAction}
              disabled={bulkArchiveDisabled}
              title={bulkArchiveDisabled ? "选中的对话已包含归档项" : "归档选中的对话"}
              onClick={handleBulkArchive}
            >
              归档
            </button>
            <button
              type="button"
              className={s.bulkAction}
              data-tone="danger"
              onClick={handleBulkDelete}
            >
              删除
            </button>
            <button type="button" className={s.bulkAction} onClick={clearSelection}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      {rowActions.renamingSession ? (
        <SessionRenameModal
          value={rowActions.renameValue}
          saving={rowActions.renameSaving}
          error={rowActions.renameError}
          onChange={rowActions.setRenameValue}
          onClose={rowActions.closeRename}
          onSubmit={rowActions.submitRename}
        />
      ) : null}

      {rowActions.deleteTargets ? (
        <SessionDeleteModal
          sessions={rowActions.deleteTargets}
          deleting={rowActions.isDeleting}
          onClose={rowActions.closeDeleteDialog}
          onConfirm={rowActions.confirmDelete}
        />
      ) : null}

      {rowActions.exportError ? (
        <SessionExportErrorModal
          error={rowActions.exportError}
          onClose={rowActions.clearExportError}
        />
      ) : null}

      {sessionBranch.error ? (
        <SessionBranchErrorModal
          error={sessionBranch.error}
          onClose={sessionBranch.clearError}
        />
      ) : null}
    </aside>
  );
}
