import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useLocation } from "react-router-dom";
import { Popover } from "@hermes/shared-ui";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  GripVertical,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { activeSessionIdAtom } from "@/stores/ui";
import { readUiValue, writeUiValue } from "@/lib/ui-store";
import { useActiveProfileName } from "@/hooks/use-profiles";
import {
  prefetchSessionMessages,
  searchResultsToSummaries,
  useArchiveSession,
  useDeleteSessions,
  usePagedSessions,
  useSessionSearch,
  useSessions,
  useSetSessionFlags,
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
  SESSION_STATUS_BUCKETS,
  SESSION_STATUS_BUCKET_LABELS,
  SIDEBAR_GROUPING_LABELS,
  SIDEBAR_GROUPING_VALUES,
  SIDEBAR_SORT_KEYS,
  SIDEBAR_SORT_LABELS,
  distinctSessionProfiles,
  filterSessionsByStatusBuckets,
  groupSessionsForSidebar,
  isSessionUnread,
  markSessionsReadLocally,
  markSessionsUnreadLocally,
  needsInputCountsByProfile,
  readPinnedSessionIds,
  readSessionTitleOverrides,
  readSidebarGrouping,
  readSidebarProfileScope,
  readSidebarSort,
  readSidebarStatusFilter,
  readUnreadOverrides,
  reconcileUnreadOverrides,
  resolveSessionDotState,
  sortSessionsForSidebar,
  subscribeSessionUiStateChanges,
  toggleStatusFilterBucket,
  unpinSessions,
  writePinnedSessionIds,
  writeSidebarGrouping,
  writeSidebarProfileScope,
  writeSidebarSort,
  writeUnreadOverrides,
  type SessionDotState,
  type SessionStatusBucket,
  type SidebarGrouping,
  type SidebarProfileScope,
  type SidebarSortKey,
  type UnreadOverrides,
} from "@/lib/session-ui-state";
import { usePinnedReorder } from "./use-pinned-reorder";
import { resolveRowDotState, useSidebarListState } from "./use-sidebar-session-state";
import {
  RECENT_SESSION_PAGE_SIZE,
  allSessionPagesLoaded,
  deriveSidebarWorkspaces,
  filterSessionsByQuery,
  mergeSessionPages,
  selectSessionsById,
  sessionPagesTotal,
  toggleSelectedSessionId,
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
  newSessionHrefForWorkspace,
  readPinnedWorkspaceProjectPaths,
  readSessionWorkspaceMap,
  readWorkspacePath,
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
const PIN_WRITE_GUARD_MS = 15_000;

const VIEW_OPTIONS: Array<{ value: SidebarSessionsView; label: string }> = [
  { value: "recent", label: "最近" },
  { value: "pinned", label: "置顶" },
  { value: "workspaces", label: "工作区" },
];

function readSidebarView(): SidebarSessionsView {
  const value = readUiValue<unknown>(SIDEBAR_VIEW_KEY, "recent");
  return value === "pinned" || value === "workspaces" ? value : "recent";
}

function readGroupExpanded(): Record<string, boolean> {
  const raw = readUiValue<unknown>(SIDEBAR_GROUPS_KEY, {});
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  return record as Record<string, boolean>;
}

function isGroupExpanded(state: Record<string, boolean>, key: string): boolean {
  return state[key] !== false;
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

const DOT_LABELS: Record<SessionDotState, string> = {
  "needs-input": "等待回答",
  working: "运行中",
  stalled: "无响应",
  background: "后台任务进行中",
  unread: "未读",
  draft: "草稿",
  idle: "闲置",
};

function SessionStatusMark({ state }: { state: SessionDotState }) {
  return (
    <span
      className={s.rowDot}
      data-state={state}
      role="status"
      aria-label={DOT_LABELS[state]}
      title={DOT_LABELS[state]}
    />
  );
}

interface SessionRowProps {
  session: SessionSummary;
  state: SessionDotState;
  active: boolean;
  selected: boolean;
  time: string;
  projectName?: string;
  pinned: boolean;
  unread?: boolean;
  snippet?: string;
  searchHit?: boolean;
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
  unread = false,
  snippet,
  searchHit = false,
  menuDisabled = false,
  actions,
  onClick,
  onToggleSelect,
  onHover,
  onBranch,
  branching = false,
}: SessionRowProps) {
  const title = sessionDisplayTitle(session);
  const source = session.source?.trim() ? getSourceMeta(session.source).label : null;
  const model = session.model ? modelShort(session.model) : null;
  const actionMenuDisabled = menuDisabled || actions.isDeleting || branching;
  return (
    <div
      className={s.sessionRow}
      data-session-row={session.id}
      data-active={active ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-unread={unread ? "true" : undefined}
      data-search-hit={searchHit ? "true" : undefined}
      data-dot-state={state}
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
          <span className={s.ttlText} data-unread={unread ? "true" : undefined}>{title}</span>
          {pinned ? <span className={s.rowPinnedFlag}>置顶</span> : null}
          <SessionStatusMark state={state} />
        </div>
        <div className={s.rowBottom}>
          {source ? <span className={s.sourceChip}>{source}</span> : null}
          {snippet ? (
            <span className={s.rowSnippet} title={snippet}>{snippet}</span>
          ) : null}
          {!snippet && model ? (
            <span className={s.rowModel} title={model}>
              {model}
            </span>
          ) : null}
          {!snippet && projectName ? (
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
          unread={unread}
          disabled={actionMenuDisabled}
          onTogglePin={() => actions.togglePin(session.id)}
          onToggleUnread={() => actions.toggleUnread(session.id)}
          onCopyId={() => void actions.copySessionId(session.id)}
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

interface SortablePinnedRowProps {
  id: string;
  sortable: boolean;
  children: ReactNode;
}

function SortablePinnedRow({ id, sortable, children }: SortablePinnedRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !sortable,
  });
  return (
    <div
      ref={setNodeRef}
      className={s.sortableRow}
      data-sortable-row={id}
      data-dragging={isDragging ? "true" : undefined}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        className={s.dragHandle}
        data-enabled={sortable ? "true" : "false"}
        disabled={!sortable}
        title={sortable ? "拖动调整置顶顺序" : "切回「最近更新」排序后可拖动换序"}
        onClick={(event) => event.stopPropagation()}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={12} aria-hidden="true" />
      </button>
      {children}
    </div>
  );
}

interface SidebarListToolsProps {
  sort: SidebarSortKey;
  grouping: SidebarGrouping;
  statusFilter: SidebarSessionStatusBuckets;
  unreadCount: number;
  onSort: (key: SidebarSortKey) => void;
  onGrouping: (grouping: SidebarGrouping) => void;
  onToggleStatus: (bucket: SessionStatusBucket) => void;
  onClearStatus: () => void;
  onMarkAllRead: () => void;
}

type SidebarSessionStatusBuckets = SessionStatusBucket[];

function SidebarListTools({
  sort,
  grouping,
  statusFilter,
  unreadCount,
  onSort,
  onGrouping,
  onToggleStatus,
  onClearStatus,
  onMarkAllRead,
}: SidebarListToolsProps) {
  const [open, setOpen] = useState(false);
  const activeCount = statusFilter.length;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={s.toolIconButton}
          data-active={open || activeCount > 0 ? "true" : undefined}
          data-action="list-tools"
          aria-label="排序、分组与筛选"
          title="排序、分组与筛选"
        >
          <SlidersHorizontal size={14} aria-hidden="true" />
          {activeCount > 0 ? <span className={s.toolIconBadge}>{activeCount}</span> : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={s.toolsPanel}
          align="end"
          side="bottom"
          sideOffset={6}
          role="dialog"
          aria-label="排序、分组与筛选"
        >
          <div className={s.toolsSection} data-section="sort">
            <div className={s.toolsHeading}>排序</div>
            <div role="radiogroup" aria-label="排序方式">
              {SIDEBAR_SORT_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={sort === key}
                  className={s.toolsOption}
                  data-active={sort === key ? "true" : undefined}
                  data-sort-key={key}
                  onClick={() => onSort(key)}
                >
                  <span className={s.toolsOptionLabel}>{SIDEBAR_SORT_LABELS[key]}</span>
                  {sort === key ? <Check size={12} aria-hidden="true" /> : null}
                </button>
              ))}
            </div>
          </div>

          <div className={s.toolsSection} data-section="grouping">
            <div className={s.toolsHeading}>分组</div>
            <div role="radiogroup" aria-label="分组方式">
              {SIDEBAR_GROUPING_VALUES.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={grouping === value}
                  className={s.toolsOption}
                  data-active={grouping === value ? "true" : undefined}
                  data-grouping-value={value}
                  onClick={() => onGrouping(value)}
                >
                  <span className={s.toolsOptionLabel}>{SIDEBAR_GROUPING_LABELS[value]}</span>
                  {grouping === value ? <Check size={12} aria-hidden="true" /> : null}
                </button>
              ))}
            </div>
          </div>

          <div className={s.toolsSection} data-section="status">
            <div className={s.toolsHeading}>筛选</div>
            <div role="group" aria-label="按状态筛选">
              {SESSION_STATUS_BUCKETS.map((bucket) => (
                <button
                  key={bucket}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={statusFilter.includes(bucket)}
                  className={s.toolsOption}
                  data-active={statusFilter.includes(bucket) ? "true" : undefined}
                  data-status-bucket={bucket}
                  onClick={() => onToggleStatus(bucket)}
                >
                  <span className={s.filterDot} data-state={bucket} aria-hidden="true" />
                  <span className={s.toolsOptionLabel}>{SESSION_STATUS_BUCKET_LABELS[bucket]}</span>
                  {statusFilter.includes(bucket) ? <Check size={12} aria-hidden="true" /> : null}
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                className={s.toolsOption}
                data-action="clear-status-filter"
                disabled={activeCount === 0}
                onClick={onClearStatus}
              >
                <span className={s.toolsOptionLabel}>清除筛选</span>
              </button>
            </div>
          </div>

          <div className={s.toolsSection} data-section="actions">
            <button
              type="button"
              className={s.toolsOption}
              data-action="mark-all-read"
              disabled={unreadCount === 0}
              title={unreadCount === 0 ? "没有未读会话" : `把 ${unreadCount} 个会话标为已读`}
              onClick={onMarkAllRead}
            >
              <span className={s.toolsOptionLabel}>全部已读</span>
              <span className={s.toolsOptionMeta}>{unreadCount}</span>
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
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
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(readGroupExpanded);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set<string>());
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [titleOverrides, setTitleOverrides] = useState(readSessionTitleOverrides);
  const [pinnedSessionIds, setPinnedSessionIds] = useState(readPinnedSessionIds);
  const [unreadOverrides, setUnreadOverrides] = useState<UnreadOverrides>(readUnreadOverrides);
  const [projects, setProjects] = useState<WorkspaceProject[]>(readWorkspaceProjects);
  const [pinnedProjectPaths, setPinnedProjectPaths] = useState(readPinnedWorkspaceProjectPaths);
  const [sessionWorkspaceMap, setSessionWorkspaceMap] = useState(readSessionWorkspaceMap);
  const [profileScope, setProfileScope] = useState<SidebarProfileScope>(readSidebarProfileScope);
  const [lastWorkspace] = useState(() => readWorkspacePath());
  const { sort, grouping, statusFilter, setSort, setGrouping, toggleStatus, clearStatus } =
    useSidebarListState();

  const recentPages = usePagedSessions(RECENT_SESSION_PAGE_SIZE, { order: "recent" });
  const focusedEnabled = view === "workspaces" || pinnedSessionIds.size > 0;
  const focusedQuery = useSessions(FOCUSED_VIEW_LIMIT, 0, {
    cwdPrefix: workspacePath ?? undefined,
    order: "recent",
    enabled: focusedEnabled,
  });
  const serverSearch = useSessionSearch(query);
  const setSessionFlags = useSetSessionFlags();
  const [nowMs, setNowMs] = useState(() => Date.now());

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
        setUnreadOverrides(readUnreadOverrides());
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

  const pinWriteGuard = useRef(new Map<string, { pinned: boolean; at: number }>());

  useEffect(() => {
    if (liveRecentSessions.length === 0) return;
    const guard = pinWriteGuard.current;
    const nowMs2 = Date.now();
    const usable = (id: string) => {
      const entry = guard.get(id);
      return !entry || nowMs2 - entry.at > PIN_WRITE_GUARD_MS;
    };
    const serverPinned = liveRecentSessions.flatMap((session) =>
      session.pinned === true && usable(session.id) ? [session.id] : [],
    );
    const serverUnpinned = liveRecentSessions.flatMap((session) =>
      session.pinned === false && usable(session.id) ? [session.id] : [],
    );
    if (serverPinned.length === 0 && serverUnpinned.length === 0) return;
    setPinnedSessionIds((current) => {
      const next = new Set(current);
      let changed = false;
      for (const id of serverPinned) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      for (const id of serverUnpinned) {
        if (next.delete(id)) changed = true;
      }
      return changed ? writePinnedSessionIds(next) : current;
    });
  }, [liveRecentSessions]);

  const unreadOverridesRef = useRef(unreadOverrides);
  unreadOverridesRef.current = unreadOverrides;

  const setSessionUnread = useCallback(
    (ids: string[], unread: boolean) => {
      if (ids.length === 0) return;
      const next = unread
        ? markSessionsUnreadLocally(ids)
        : markSessionsReadLocally(ids);
      setUnreadOverrides(next);
      setSessionFlags.mutate({ ids, unread });
    },
    [setSessionFlags],
  );

  useEffect(() => {
    if (liveRecentSessions.length === 0) return;
    const reconciled = reconcileUnreadOverrides(unreadOverridesRef.current, liveRecentSessions);
    if (reconciled !== unreadOverridesRef.current) {
      setUnreadOverrides(writeUnreadOverrides(reconciled));
    }
  }, [liveRecentSessions]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

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
    if (isSessionUnread(sess, unreadOverridesRef.current)) {
      setSessionUnread([sess.id], false);
    }
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

  const setSessionPinned = useCallback(
    (ids: string[], pinned: boolean) => {
      if (ids.length === 0) return;
      const nowTs = Date.now();
      for (const id of ids) pinWriteGuard.current.set(id, { pinned, at: nowTs });
      setPinnedSessionIds((current) => {
        const next = new Set(current);
        for (const id of ids) {
          if (pinned) next.add(id);
          else next.delete(id);
        }
        return writePinnedSessionIds(next);
      });
      setSessionFlags.mutate({ ids, pinned });
    },
    [setSessionFlags],
  );

  const rowActions = useSessionRowActions({
    deleteSessions: (ids) => deleteSessions.mutateAsync(ids),
    isDeleting: deleteSessions.isPending,
    setSessionTitle,
    resumeSession,
    archive: archiveSession.mutate,
    profile,
    onDeleted: onSessionsDeleted,
    setUnread: setSessionUnread,
    setPinned: setSessionPinned,
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

  const dotStateOf = useCallback(
    (sess: SessionSummary): SessionDotState =>
      resolveRowDotState(sess, runtimeBySession[sess.id], {
        unread: isSessionUnread(sess, unreadOverrides),
        now: nowMs,
      }),
    [nowMs, runtimeBySession, unreadOverrides],
  );

  const profilePool = useMemo(() => {
    const pool = [...pinnedSessions, ...liveFocusedSessions, ...liveRecentSessions];
    return Array.from(new Map(pool.map((session) => [session.id, session])).values());
  }, [liveFocusedSessions, liveRecentSessions, pinnedSessions]);

  const availableProfiles = useMemo(
    () => distinctSessionProfiles(profilePool, (session) => session.profile),
    [profilePool],
  );

  const needsInputByProfile = useMemo(
    () => needsInputCountsByProfile(profilePool, (session) => session.profile, dotStateOf),
    [dotStateOf, profilePool],
  );

  const activeNeedsInput = needsInputByProfile[profile] ?? 0;
  const profileScopeEnabled = availableProfiles.length > 1;

  useEffect(() => {
    if (profileScope !== "all") return;
    if (availableProfiles.length > 1) return;
    setProfileScope(writeSidebarProfileScope("active"));
  }, [availableProfiles, profileScope]);

  const effectiveGrouping: SidebarGrouping = profileScope === "all" ? "profile" : grouping;

  const { sensors: pinnedSensors, handleDragEnd: handlePinnedDragEnd, reorderEnabled } =
    usePinnedReorder({
      enabled: view === "pinned" && sort === "updated",
      onReorder: (next) => setPinnedSessionIds(next),
    });

  const searching = query.trim().length > 0;

  const visibleRecent = useMemo(() => {
    const pinnedIdSet = new Set(pinnedSessionIds);
    const scoped = filterSessionsByQuery(
      liveRecentSessions.filter((session) => !pinnedIdSet.has(session.id)),
      query,
    );
    const filtered = filterSessionsByStatusBuckets(scoped, statusFilter, dotStateOf);
    return sortSessionsForSidebar(filtered, sort, dotStateOf);
  }, [dotStateOf, liveRecentSessions, pinnedSessionIds, query, sort, statusFilter]);

  const visiblePinned = useMemo(
    () => sortSessionsForSidebar(
      filterSessionsByStatusBuckets(
        filterSessionsByQuery(pinnedSessions, query),
        statusFilter,
        dotStateOf,
      ),
      sort,
      dotStateOf,
    ),
    [dotStateOf, pinnedSessions, query, sort, statusFilter],
  );

  const visibleWorkspaceSessions = useMemo(
    () => sortSessionsForSidebar(
      filterSessionsByStatusBuckets(
        filterSessionsByQuery(liveFocusedSessions, query),
        statusFilter,
        dotStateOf,
      ),
      sort,
      dotStateOf,
    ),
    [dotStateOf, liveFocusedSessions, query, sort, statusFilter],
  );

  const visibleWorkspaces = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return workspaces;
    return workspaces.filter((workspace) =>
      workspace.name.toLowerCase().includes(needle)
      || workspace.path.toLowerCase().includes(needle),
    );
  }, [query, workspaces]);

  const localSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of liveRecentSessions) ids.add(session.id);
    for (const session of liveFocusedSessions) ids.add(session.id);
    for (const session of pinnedSessions) ids.add(session.id);
    return ids;
  }, [liveFocusedSessions, liveRecentSessions, pinnedSessions]);

  const remoteSearchSessions = useMemo(() => {
    if (!searching || serverSearch.results.length === 0) return [];
    const summaries = searchResultsToSummaries(serverSearch.results);
    return summaries.filter((session) => !localSessionIds.has(session.id));
  }, [localSessionIds, searching, serverSearch.results]);

  const activeList = view === "pinned"
    ? visiblePinned
    : view === "workspaces" && workspacePath
      ? visibleWorkspaceSessions
      : visibleRecent;

  const dayGroups = useMemo(
    () =>
      groupSessionsForSidebar(activeList, effectiveGrouping, {
        now,
        stateOf: dotStateOf,
        projectOf: (session) => projectNameBySessionId.get(session.id),
        profileOf: (session) => session.profile,
      }),
    [activeList, dotStateOf, effectiveGrouping, now, projectNameBySessionId],
  );

  const orderedVisibleSessions = activeList;

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
    setSessionPinned(selectedSessions.map((session) => session.id), true);
    clearSelection();
  }, [clearSelection, selectedSessions, setSessionPinned]);

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

  const rowState = (sess: SessionSummary): SessionDotState => dotStateOf(sess);

  const renderRow = (sess: SessionSummary, menuDisabled = false, snippet?: string) => (
    <SessionRow
      key={sess.id}
      session={sess}
      state={rowState(sess)}
      active={sessionIdMatches(sess.id, activeSessionId)}
      selected={selectedIds.has(sess.id)}
      time={sessionTimes.get(sess.id) ?? timeFor(sess)}
      projectName={projectNameBySessionId.get(sess.id)}
      pinned={pinnedSessionIds.has(sess.id)}
      unread={isSessionUnread(sess, unreadOverrides)}
      snippet={snippet}
      searchHit={snippet !== undefined}
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
    <div className={s.empty}>
      {serverSearch.searchPending ? "正在搜索全部会话…" : "没有匹配的对话"}
    </div>
  );
  const recentPending = recentPages.isLoading && dayGroups.length === 0;
  const recentFailed = recentPages.isError && dayGroups.length === 0;

  const unreadSessions = useMemo(() => {
    const pool = [...liveRecentSessions, ...liveFocusedSessions, ...pinnedSessions];
    const unique = Array.from(new Map(pool.map((session) => [session.id, session])).values());
    return unique.filter((session) => isSessionUnread(session, unreadOverrides));
  }, [liveFocusedSessions, liveRecentSessions, pinnedSessions, unreadOverrides]);

  const handleMarkAllRead = useCallback(() => {
    if (unreadSessions.length === 0) return;
    setSessionUnread(unreadSessions.map((session) => session.id), false);
  }, [setSessionUnread, unreadSessions]);

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
      <button
        type="button"
        className={s.newTask}
        data-action="new-session"
        title={lastWorkspace ? `在 ${lastWorkspace} 新建对话` : "新建对话"}
        onClick={() => navigate(newSessionHrefForWorkspace(lastWorkspace))}
      >
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

      <div className={s.searchRow}>
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
        <SidebarListTools
          sort={sort}
          grouping={grouping}
          statusFilter={statusFilter}
          unreadCount={unreadSessions.length}
          onSort={setSort}
          onGrouping={setGrouping}
          onToggleStatus={toggleStatus}
          onClearStatus={clearStatus}
          onMarkAllRead={handleMarkAllRead}
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
            ) : dayGroups.length === 0 && remoteSearchSessions.length === 0 ? (
              searching ? noMatchHint : <div className={s.empty}>还没有历史对话</div>
            ) : (
              dayGroups.map((group) => {
                const expanded = isGroupExpanded(expandedGroups, group.key);
                return (
                  <section
                    className={s.section}
                    key={group.key}
                    data-day-group={effectiveGrouping === "day" ? group.key : undefined}
                    data-group-key={group.key}
                    data-grouping={effectiveGrouping}
                  >
                    <button
                      type="button"
                      className={s.groupHeader}
                      aria-expanded={expanded}
                      onClick={() => {
                        setExpandedGroups((current) => ({
                          ...current,
                          [group.key]: !isGroupExpanded(current, group.key),
                        }));
                      }}
                    >
                      <span className={s.groupChevron}>
                        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      </span>
                      <span className={s.groupLabel}>{group.label}</span>
                      <span className={s.labelCount}>{group.items.length}</span>
                      {effectiveGrouping === "profile" && (needsInputByProfile[group.label] ?? 0) > 0 ? (
                        <span
                          className={s.groupNeedsInput}
                          title={`${needsInputByProfile[group.label]} 个会话等你处理`}
                        >
                          {needsInputByProfile[group.label]}
                        </span>
                      ) : null}
                    </button>
                    {expanded ? group.items.map((sess) => renderRow(sess)) : null}
                  </section>
                );
              })
            )}

            {remoteSearchSessions.length > 0 ? (
              <section className={s.section} data-section="server-search">
                <div className={s.label}>
                  <span>未加载的会话命中</span>
                  <span className={s.labelCount}>{remoteSearchSessions.length}</span>
                </div>
                {remoteSearchSessions.map((sess) =>
                  renderRow(sess, false, sess.preview ?? undefined),
                )}
              </section>
            ) : null}

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
            <section className={s.section} data-section="pinned" data-reorder={reorderEnabled ? "on" : "off"}>
              <DndContext
                sensors={pinnedSensors}
                collisionDetection={closestCenter}
                onDragEnd={handlePinnedDragEnd}
              >
                <SortableContext
                  items={visiblePinned.map((sess) => sess.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {visiblePinned.map((sess) => (
                    <SortablePinnedRow key={sess.id} id={sess.id} sortable={reorderEnabled}>
                      {renderRow(sess)}
                    </SortablePinnedRow>
                  ))}
                </SortableContext>
              </DndContext>
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
                <div
                  key={workspace.path}
                  className={s.workspaceItem}
                  data-workspace-path={workspace.path}
                  title={workspace.path}
                >
                  <button
                    type="button"
                    className={s.workspaceOpen}
                    onClick={() => setWorkspacePath(workspace.path)}
                    title={workspace.path}
                  >
                    <span className={s.workspaceIcon}>
                      <Folder size={15} />
                    </span>
                    <span className={s.workspaceName}>{workspace.name}</span>
                    <span className={s.workspaceCount}>{workspace.sessionCount}</span>
                  </button>
                  <button
                    type="button"
                    className={s.workspaceNew}
                    data-action="new-session-in-workspace"
                    aria-label={`在 ${workspace.name} 新建对话`}
                    title={`在 ${workspace.name} 新建对话`}
                    onClick={(event) => {
                      event.stopPropagation();
                      navigate(newSessionHrefForWorkspace(workspace.path));
                    }}
                  >
                    <Plus size={13} />
                  </button>
                </div>
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
          error={rowActions.deleteError}
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
