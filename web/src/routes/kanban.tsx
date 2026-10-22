import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  Archive,
  Ban,
  CalendarClock,
  CheckCircle2,
  CircleDot,
  Copy,
  Eye,
  ExternalLink,
  Folder,
  Inbox,
  ListTodo,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  User,
  X,
} from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { Dropdown, type DropdownOption } from "@/components/ui/dropdown";
import { PageSkeleton } from "@/components/page-skeleton";
import { BoardColumn } from "@/components/kanban/board-column";
import { NewTaskDialog, type NewTaskInput } from "@/components/kanban/new-task-dialog";
import { TaskDrawer } from "@/components/kanban/task-drawer";
import {
  useAddKanbanComment,
  useBulkKanbanTasks,
  useCreateKanbanTask,
  useDeleteKanbanTask,
  useKanbanAssignees,
  useKanbanBoard,
  useKanbanBoards,
  useKanbanDiagnostics,
  useKanbanTask,
  useKanbanTaskLog,
  useKanbanWorkflow,
  useUpdateKanbanTask,
} from "@/hooks/use-kanban";
import { useKanbanEvents } from "@/hooks/use-kanban-events";
import { useStatus } from "@/hooks/use-status";
import { dashboardPageUrlFromInputs, dashboardUrlFromInputs } from "@/lib/dashboard-url";
import { openExternalUrl } from "@/lib/external-links";
import { cancelKanbanDispatch } from "@/lib/kanban-dispatch";
import { useConfirm } from "@/lib/use-confirm";
import {
  ALL_ASSIGNEES,
  ALL_PRIORITIES,
  ALL_WORKSPACES,
  ARCHIVED_COLUMN_KEY,
  allowedDropTargets,
  allowedStatusOptions,
  applyOverrides,
  buildBulkPatch,
  buildColumnViews,
  buildStatusPatch,
  canDropTask,
  collectAssigneeNames,
  collectWorkspaceOptions,
  columnCollapseStorageKey,
  deleteTasksSequentially,
  dragTargetKeys,
  filterTasks,
  findTask,
  hasActiveFilters,
  kanbanColumnLabel,
  parseCollapseMarks,
  projectBoardCards,
  projectColumnViews,
  resolveColumnCollapse,
  retainSelectableTasks,
  serializeCollapseMarks,
  setCollapseMark,
  toggleTaskSelection,
  type ColumnCollapseMarks,
  type ColumnView,
  type KanbanBoardView,
  type KanbanTask,
  type KanbanWorkflowColumn,
} from "@/lib/kanban";
import { SectionShell } from "./section-shell";
import s from "./kanban.module.css";

const COLUMN_ICONS: Record<string, typeof Inbox> = {
  triage: Inbox,
  todo: ListTodo,
  scheduled: CalendarClock,
  ready: Play,
  running: CircleDot,
  blocked: Ban,
  review: Eye,
  done: CheckCircle2,
  [ARCHIVED_COLUMN_KEY]: Archive,
};

interface Toast {
  id: number;
  tone: "ok" | "error" | "warn";
  message: string;
}

const SEARCH_DEBOUNCE_MS = 250;
const PRIORITY_VALUES = ["1", "2", "3"] as const;
const EMPTY_BULK_VALUE = "";

function ColumnIcon({ column }: { column: KanbanWorkflowColumn }) {
  const Icon = COLUMN_ICONS[column.key] ?? ListTodo;
  return <Icon size={14} />;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "未知错误");
}

function readCollapseMarks(slug: string): ColumnCollapseMarks {
  if (typeof window === "undefined") return {};
  try {
    return parseCollapseMarks(window.localStorage.getItem(columnCollapseStorageKey(slug)));
  } catch {
    return {};
  }
}

function writeCollapseMarks(slug: string, marks: ColumnCollapseMarks): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(columnCollapseStorageKey(slug), serializeCollapseMarks(marks));
  } catch {
    return;
  }
}

export function KanbanRoute() {
  const { confirm } = useConfirm();
  const { data: status, isError: statusError } = useStatus();
  const dashboardInputs = {
    healthUrl: status?.gateway_health_url,
    runtimeConfig: typeof window === "undefined" ? null : window.__HERMES_RUNTIME__,
    envOrigin: import.meta.env.VITE_HERMES_DASHBOARD_ORIGIN,
  };
  const dashboardUrl = dashboardUrlFromInputs(dashboardInputs);
  const kanbanUrl = dashboardPageUrlFromInputs(dashboardInputs, "/kanban");

  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const boardsQuery = useKanbanBoards();
  const [boardSlug, setBoardSlug] = useState("default");
  const [boardView, setBoardView] = useState<KanbanBoardView>("active");
  const boardSlugRef = useRef(false);
  const boards = boardsQuery.data?.boards ?? [];

  useEffect(() => {
    if (boardSlugRef.current) return;
    const current = boardsQuery.data?.current;
    if (current) {
      boardSlugRef.current = true;
      setBoardSlug(current);
    }
  }, [boardsQuery.data]);

  const workflowQuery = useKanbanWorkflow();
  const boardQuery = useKanbanBoard(boardSlug, boardView);
  const assigneesQuery = useKanbanAssignees();
  const events = useKanbanEvents({
    slug: boardSlug,
    since: boardQuery.data?.latest_event_id ?? null,
  });

  const workflowColumns = useMemo<KanbanWorkflowColumn[]>(
    () => workflowQuery.data?.columns ?? [],
    [workflowQuery.data],
  );

  const dragTargets = useMemo(() => dragTargetKeys(workflowColumns), [workflowColumns]);

  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState<string>(ALL_ASSIGNEES);
  const [priorityFilter, setPriorityFilter] = useState<string>(ALL_PRIORITIES);
  const [workspaceFilter, setWorkspaceFilter] = useState<string>(ALL_WORKSPACES);
  const [showDone, setShowDone] = useState(false);
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [autoCollapseEmpty, setAutoCollapseEmpty] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(searchInput), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bulkSelected, setBulkSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<number | null>(null);

  const [marksBySlug, setMarksBySlug] = useState<Record<string, ColumnCollapseMarks>>({});
  const collapseMarks = marksBySlug[boardSlug] ?? readCollapseMarks(boardSlug);
  const [dragging, setDragging] = useState(false);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const pushToast = useCallback((tone: Toast["tone"], message: string) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), tone, message });
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  useEffect(() => () => cancelKanbanDispatch(), []);

  const effectiveBoard = useMemo(() => {
    const data = boardQuery.data;
    if (!data) return undefined;
    const projected = projectBoardCards(data);
    return Object.keys(overrides).length > 0 ? applyOverrides(projected, overrides) : projected;
  }, [boardQuery.data, overrides]);

  const searchableBoard = useMemo(() => {
    const data = boardQuery.data;
    if (!data) return undefined;
    return Object.keys(overrides).length > 0 ? applyOverrides(data, overrides) : data;
  }, [boardQuery.data, overrides]);

  const filtersActive = hasActiveFilters({
    query,
    assignee: assigneeFilter,
    priority: priorityFilter,
    workspace: workspaceFilter,
  });

  const columnViews = useMemo<ColumnView[]>(() => {
    if (!searchableBoard) return [];
    if (boardView === "archived") {
      const source = searchableBoard.columns.find((column) => column.name === ARCHIVED_COLUMN_KEY)?.tasks ?? [];
      const matched = filterTasks(source, {
        query,
        assignee: assigneeFilter,
        priority: priorityFilter,
        workspace: workspaceFilter,
      });
      return projectColumnViews([
        {
          key: ARCHIVED_COLUMN_KEY,
          label: "已归档",
          dragTarget: false,
          tasks: matched,
          total: matched.length,
          unfilteredTotal: source.length,
          collapsed: false,
          hiddenCount: 0,
        },
      ]);
    }
    return projectColumnViews(
      buildColumnViews(workflowColumns, searchableBoard.columns, {
        query,
        assignee: assigneeFilter,
        priority: priorityFilter,
        workspace: workspaceFilter,
        showDone,
        doneExpanded,
      }),
    );
  }, [
    searchableBoard,
    workflowColumns,
    boardView,
    query,
    assigneeFilter,
    priorityFilter,
    workspaceFilter,
    showDone,
    doneExpanded,
  ]);

  const collapseStates = useMemo(
    () =>
      resolveColumnCollapse(columnViews, {
        marks: collapseMarks,
        autoCollapseEmpty,
        dragging,
        hoveredKey,
      }),
    [columnViews, collapseMarks, autoCollapseEmpty, dragging, hoveredKey],
  );

  const assigneeNames = useMemo(
    () => collectAssigneeNames(assigneesQuery.data?.assignees, effectiveBoard),
    [assigneesQuery.data, effectiveBoard],
  );

  const workspaceOptions = useMemo(
    () => collectWorkspaceOptions(effectiveBoard?.columns),
    [effectiveBoard],
  );

  const boardOptions = useMemo<DropdownOption[]>(
    () =>
      boards.length === 0
        ? [{ value: boardSlug, label: boardSlug }]
        : boards.map((board) => ({
            value: board.slug,
            label: board.name || board.slug,
            hint: board.description || board.slug,
            meta: typeof board.total === "number" ? String(board.total) : undefined,
          })),
    [boards, boardSlug],
  );

  const bulkStatusOptions = useMemo<DropdownOption[]>(
    () => [
      { value: EMPTY_BULK_VALUE, label: "移动到…" },
      ...workflowColumns
        .filter((column) => dragTargets.has(column.key))
        .map((column) => ({ value: column.key, label: kanbanColumnLabel(column.label) })),
    ],
    [dragTargets, workflowColumns],
  );

  const bulkPriorityOptions = useMemo<DropdownOption[]>(
    () => [
      { value: EMPTY_BULK_VALUE, label: "改优先级…" },
      ...PRIORITY_VALUES.map((value) => ({ value, label: `P${value}` })),
      { value: "0", label: "P0（清除）" },
    ],
    [],
  );

  const priorityOptions = useMemo<DropdownOption[]>(
    () => [
      { value: ALL_PRIORITIES, label: "全部优先级" },
      ...PRIORITY_VALUES.map((value) => ({ value, label: `P${value}` })),
    ],
    [],
  );

  const workspaceDropdownOptions = useMemo<DropdownOption[]>(
    () => [
      { value: ALL_WORKSPACES, label: "全部工作区" },
      ...workspaceOptions.map((option) => ({
        value: option.value,
        label: option.label,
        hint: option.path,
      })),
    ],
    [workspaceOptions],
  );

  const assigneeOptions = useMemo<DropdownOption[]>(
    () => [
      { value: ALL_ASSIGNEES, label: "全部负责人" },
      ...assigneeNames.map((name) => ({ value: name, label: name })),
    ],
    [assigneeNames],
  );

  const selectedTask = useMemo(
    () => findTask(effectiveBoard, selectedId),
    [effectiveBoard, selectedId],
  );
  const taskDetailQuery = useKanbanTask(boardSlug, selectedId);
  const diagnosticsQuery = useKanbanDiagnostics(boardSlug, selectedId !== null);
  const taskLogQuery = useKanbanTaskLog(boardSlug, selectedId, selectedId !== null);
  const updateMutation = useUpdateKanbanTask(boardSlug);
  const createMutation = useCreateKanbanTask(boardSlug);
  const commentMutation = useAddKanbanComment(boardSlug);
  const bulkMutation = useBulkKanbanTasks(boardSlug);
  const deleteMutation = useDeleteKanbanTask(boardSlug);

  const selectedDiagnostics = useMemo(() => {
    if (!selectedId) return null;
    const row = diagnosticsQuery.data?.diagnostics?.find((entry) => entry.task_id === selectedId);
    return row?.diagnostics?.length ? row.diagnostics : null;
  }, [diagnosticsQuery.data, selectedId]);

  useEffect(() => {
    setBulkSelected((previous) => {
      const next = retainSelectableTasks(previous, effectiveBoard);
      return next.length === previous.length ? previous : next;
    });
  }, [effectiveBoard]);

  const labelOf = useCallback(
    (key: string) =>
      kanbanColumnLabel(workflowColumns.find((column) => column.key === key)?.label ?? key),
    [workflowColumns],
  );

  const applyMarks = useCallback(
    (next: ColumnCollapseMarks) => {
      setMarksBySlug((previous) => ({ ...previous, [boardSlug]: next }));
      writeCollapseMarks(boardSlug, next);
    },
    [boardSlug],
  );

  const toggleCollapse = useCallback(
    (key: string) => {
      const current = collapseStates[key];
      const next = setCollapseMark(collapseMarks, key, current?.collapsed ? "expanded" : "collapsed");
      applyMarks(next);
    },
    [applyMarks, collapseMarks, collapseStates],
  );

  const clearFilters = useCallback(() => {
    setSearchInput("");
    setQuery("");
    setAssigneeFilter(ALL_ASSIGNEES);
    setPriorityFilter(ALL_PRIORITIES);
    setWorkspaceFilter(ALL_WORKSPACES);
  }, []);

  const toggleBulkSelection = useCallback((taskId: string) => {
    setBulkSelected((previous) => toggleTaskSelection(previous, taskId));
  }, []);

  const moveTask = useCallback(
    async (task: KanbanTask, target: string) => {
      setOverrides((previous) => ({ ...previous, [task.id]: target }));
      try {
        await updateMutation.mutateAsync({ id: task.id, body: buildStatusPatch(target) });
        setOverrides((previous) => {
          const next = { ...previous };
          delete next[task.id];
          return next;
        });
        pushToast("ok", `已移动到「${labelOf(target)}」`);
      } catch (error) {
        setOverrides((previous) => {
          const next = { ...previous };
          delete next[task.id];
          return next;
        });
        pushToast("error", `移动失败：${errorText(error)}`);
      }
    },
    [labelOf, pushToast, updateMutation],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const overId = event.over?.id ? String(event.over.id) : null;
    setHoveredKey(overId && overId.startsWith("col:") ? overId.slice(4) : null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDragging(false);
      setHoveredKey(null);
      const overId = event.over?.id ? String(event.over.id) : null;
      if (!overId || !overId.startsWith("col:")) return;
      const target = overId.slice(4);
      const taskId = String(event.active.id);
      const task = findTask(effectiveBoard, taskId);
      if (!task) return;
      const targets = allowedDropTargets(workflowQuery.data, task.status);
      if (!canDropTask(task, target, targets)) {
        if (task.status === target) return;
        if (!dragTargets.has(target)) {
          pushToast("warn", `「${labelOf(target)}」不接受手工拖放，只能拖到可编辑的列`);
        } else {
          pushToast("warn", `内核不允许从「${labelOf(task.status)}」直接切到「${labelOf(target)}」`);
        }
        return;
      }
      void moveTask(task, target);
    },
    [dragTargets, effectiveBoard, labelOf, moveTask, pushToast, workflowQuery.data],
  );

  const handleSaveDrawer = useCallback(
    async (patch: { status?: string; assignee?: string; title?: string }) => {
      if (!selectedId) return;
      const taskId = selectedId;
      if (patch.status) setOverrides((previous) => ({ ...previous, [taskId]: patch.status as string }));
      try {
        await updateMutation.mutateAsync({ id: taskId, body: patch });
        if (patch.status) {
          setOverrides((previous) => {
            const next = { ...previous };
            delete next[taskId];
            return next;
          });
        }
        pushToast("ok", "任务已更新");
      } catch (error) {
        if (patch.status) {
          setOverrides((previous) => {
            const next = { ...previous };
            delete next[taskId];
            return next;
          });
        }
        pushToast("error", `保存失败：${errorText(error)}`);
      }
    },
    [pushToast, selectedId, updateMutation],
  );

  const handleAddComment = useCallback(
    async (body: string) => {
      if (!selectedId) return false;
      try {
        await commentMutation.mutateAsync({ taskId: selectedId, body });
        pushToast("ok", "评论已发表");
        return true;
      } catch (error) {
        pushToast("error", `评论失败：${errorText(error)}`);
        return false;
      }
    },
    [commentMutation, pushToast, selectedId],
  );

  const runBulk = useCallback(
    async (patch: Record<string, unknown>, label: string) => {
      const ids = [...bulkSelected];
      if (ids.length === 0) return;
      const body = buildBulkPatch(patch);
      if (Object.keys(body).length === 0) return;
      try {
        const result = await bulkMutation.mutateAsync({ ids, patch: body });
        const failed = result.results.filter((entry) => !entry.ok);
        if (failed.length === 0) {
          pushToast("ok", `${label} · ${ids.length} 个任务`);
          setBulkSelected([]);
        } else {
          const first = failed[0]?.error ?? "部分失败";
          pushToast("warn", `${label} · ${ids.length - failed.length}/${ids.length} 成功（${first}）`);
          setBulkSelected(failed.map((entry) => entry.id));
        }
      } catch (error) {
        pushToast("error", `${label}失败：${errorText(error)}`);
      }
    },
    [bulkMutation, bulkSelected, pushToast],
  );

  const runBulkDelete = useCallback(async () => {
    const ids = [...bulkSelected];
    if (ids.length === 0) return;
    const confirmed = await confirm({
      title: "批量删除任务",
      body: `确认删除选中的 ${ids.length} 个任务？删除后无法恢复。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!confirmed) return;
    const failedIds = await deleteTasksSequentially(ids, (id) => deleteMutation.mutateAsync(id));
    if (failedIds.length === 0) {
      pushToast("ok", `已删除 ${ids.length} 个任务`);
      setBulkSelected([]);
    } else {
      pushToast("warn", `删除完成，${failedIds.length}/${ids.length} 失败`);
      setBulkSelected(failedIds);
    }
  }, [bulkSelected, confirm, deleteMutation, pushToast]);

  const archivedCount = useMemo(() => {
    if (boardView !== "archived" || !effectiveBoard) return 0;
    return effectiveBoard.columns.find((column) => column.name === ARCHIVED_COLUMN_KEY)?.tasks.length ?? 0;
  }, [boardView, effectiveBoard]);

  const handleCreate = useCallback(
    async (input: NewTaskInput) => {
      setCreateError(null);
      try {
        await createMutation.mutateAsync(input);
        setCreating(false);
        pushToast("ok", "任务已创建");
      } catch (error) {
        setCreateError(errorText(error));
      }
    },
    [createMutation, pushToast],
  );

  const openKanban = async () => {
    if (opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      const opened = await openExternalUrl(kanbanUrl);
      if (!opened) {
        setOpenError("没有可用的外部浏览器打开方式，请复制地址后手动打开。");
      }
    } finally {
      setOpening(false);
    }
  };

  const boardLoading = boardQuery.isPending || (workflowQuery.isPending && !workflowQuery.data);
  const boardLoadError = boardQuery.isError
    ? errorText(boardQuery.error)
    : workflowQuery.isError
      ? errorText(workflowQuery.error)
      : null;
  const statusTone = status ? "ready" : statusError ? "warn" : "checking";
  const statusLabel = status ? "内核已连接" : statusError ? "尚未确认内核在线" : "正在确认内核状态";
  const streamLabel =
    events.status === "open"
      ? "事件流已连接"
      : events.status === "reconnecting"
        ? "事件流重连中"
        : events.status === "connecting"
          ? "事件流连接中"
          : "事件流已停止";

  return (
    <SectionShell
      fill
      title="看板"
      sub="原生任务看板 · 读取内核 Kanban 插件"
      right={
        <div className={s.topActions}>
          <CopyButton variant="outline" size="md" className={s.secondaryButton} text={kanbanUrl}>
            <Copy size={15} />
            复制地址
          </CopyButton>
          <button type="button" className={s.secondaryButton} onClick={() => void openKanban()} disabled={opening}>
            <ExternalLink size={15} />
            {opening ? "正在打开…" : "打开官方看板"}
          </button>
          <button type="button" className={s.primaryButton} onClick={() => setCreating(true)}>
            <Plus size={16} />
            新建任务
          </button>
        </div>
      }
    >
      <div className={s.page}>
        <div className={s.toolbar}>
          <Dropdown
            ariaLabel="选择看板"
            prefix="看板"
            options={boardOptions}
            value={boardSlug}
            minWidth={180}
            onChange={(next) => {
              setBoardSlug(next);
              setOverrides({});
              setSelectedId(null);
              setBulkSelected([]);
            }}
          />

          <div className={s.segmented} role="group" aria-label="活跃或已归档">
            <button
              type="button"
              className={s.segment}
              data-active={boardView === "active" ? "true" : undefined}
              onClick={() => {
                setBoardView("active");
                setSelectedId(null);
                setBulkSelected([]);
                setOverrides({});
              }}
            >
              活跃
            </button>
            <button
              type="button"
              className={s.segment}
              data-active={boardView === "archived" ? "true" : undefined}
              onClick={() => {
                setBoardView("archived");
                setSelectedId(null);
                setBulkSelected([]);
                setOverrides({});
              }}
            >
              已归档
            </button>
          </div>

          <label className={s.searchBox}>
            <Search size={14} aria-hidden="true" />
            <input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="搜索标题、正文或最新进展…"
              aria-label="搜索任务"
              spellCheck={false}
            />
            {searchInput ? (
              <button type="button" className={s.clearSearch} onClick={() => setSearchInput("")} aria-label="清空搜索">
                <X size={13} aria-hidden="true" />
              </button>
            ) : null}
          </label>

          <Dropdown
            ariaLabel="按优先级筛选"
            icon={<SlidersHorizontal size={13} />}
            options={priorityOptions}
            value={priorityFilter}
            minWidth={150}
            onChange={setPriorityFilter}
          />

          <Dropdown
            ariaLabel="按工作区筛选"
            icon={<Folder size={13} />}
            options={workspaceDropdownOptions}
            value={workspaceFilter}
            minWidth={170}
            onChange={setWorkspaceFilter}
          />

          <Dropdown
            ariaLabel="按负责人筛选"
            icon={<User size={13} />}
            options={assigneeOptions}
            value={assigneeFilter}
            minWidth={160}
            onChange={setAssigneeFilter}
          />

          {filtersActive ? (
            <button type="button" className={s.clearFilters} onClick={clearFilters}>
              <X size={13} aria-hidden="true" />
              清除筛选
            </button>
          ) : null}

          <label className={s.toggle}>
            <input
              type="checkbox"
              checked={autoCollapseEmpty}
              onChange={(event) => setAutoCollapseEmpty(event.target.checked)}
            />
            <span>自动折叠空列</span>
          </label>

          {boardView === "active" ? (
            <label className={s.toggle}>
              <input
                type="checkbox"
                checked={showDone}
                onChange={(event) => {
                  setShowDone(event.target.checked);
                  setDoneExpanded(false);
                }}
              />
              <span>显示已完成</span>
            </label>
          ) : null}

          <span className={s.statusBadge} data-tone={statusTone}>
            {statusLabel}
          </span>

          <span className={s.streamBadge} data-state={events.status} title={streamLabel}>
            <Radio size={13} aria-hidden="true" />
            {streamLabel}
          </span>

          <button
            type="button"
            className={s.iconButton}
            onClick={() => void boardQuery.refetch()}
            disabled={boardQuery.isFetching}
            aria-label="刷新看板"
            title={dashboardUrl}
          >
            <RefreshCw size={14} className={boardQuery.isFetching ? s.spinning : undefined} />
          </button>
        </div>

        {openError ? (
          <div className={s.errorBox} role="alert">
            {openError}
          </div>
        ) : null}

        {boardLoadError ? (
          <div className={s.errorBox} role="alert">
            看板数据加载失败：{boardLoadError}
            <button type="button" className={s.inlineLink} onClick={() => void boardQuery.refetch()}>
              重试
            </button>
          </div>
        ) : boardLoading ? (
          <PageSkeleton variant="board" columns={workflowColumns.length || 6} label="正在加载看板" />
        ) : columnViews.length === 0 ? (
          <p className={s.emptyBoard}>这个看板还没有配置工作流列，先在官方 Dashboard 里检查 kanban workflow。</p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={pointerWithin}
            onDragStart={() => setDragging(true)}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={() => {
              setDragging(false);
              setHoveredKey(null);
            }}
          >
            <div className={s.board} data-dragging={dragging ? "true" : undefined}>
              {columnViews.map((view) => (
                <BoardColumn
                  key={view.key}
                  view={view}
                  collapse={collapseStates[view.key] ?? { collapsed: false, reason: null }}
                  filtersActive={filtersActive}
                  icon={
                    <ColumnIcon
                      column={
                        workflowColumns.find((column) => column.key === view.key) ?? {
                          key: view.key,
                          label: view.label,
                        }
                      }
                    />
                  }
                  selectedId={selectedId}
                  bulkSelectedIds={bulkSelected}
                  canDrag={boardView === "active"}
                  onOpenTask={setSelectedId}
                  onToggleSelectTask={toggleBulkSelection}
                  onExpandDone={() => setShowDone(true)}
                  onShowAllDone={() => setDoneExpanded(true)}
                  onToggleCollapse={() => toggleCollapse(view.key)}
                />
              ))}
            </div>
            {filtersActive && columnViews.every((view) => view.total === 0) ? (
              <p className={s.emptyBoard}>没有匹配的任务，换个关键词或点「清除筛选」。</p>
            ) : null}
            {boardView === "archived" && archivedCount === 0 ? (
              <p className={s.emptyBoard}>这个看板还没有归档任务。</p>
            ) : null}
          </DndContext>
        )}

        {bulkSelected.length > 0 ? (
          <div className={s.bulkBar} role="region" aria-label="批量操作">
            <span className={s.bulkCount}>已选 {bulkSelected.length} 个任务</span>
            <Dropdown
              ariaLabel="批量移动到列"
              options={bulkStatusOptions}
              value={EMPTY_BULK_VALUE}
              minWidth={150}
              onChange={(next) => {
                if (!next) return;
                void runBulk({ status: next }, `已移动到「${labelOf(next)}」`);
              }}
            />
            <Dropdown
              ariaLabel="批量改优先级"
              options={bulkPriorityOptions}
              value={EMPTY_BULK_VALUE}
              minWidth={140}
              onChange={(next) => {
                if (!next) return;
                void runBulk({ priority: Number(next) }, `优先级改为 P${next}`);
              }}
            />
            <button type="button" className={s.secondaryButton} onClick={() => void runBulk({ archive: true }, "已归档")}>
              <Archive size={14} aria-hidden="true" />
              归档
            </button>
            <button type="button" className={s.secondaryButton} onClick={() => void runBulkDelete()}>
              <Trash2 size={14} aria-hidden="true" />
              删除
            </button>
            <button type="button" className={s.iconButton} onClick={() => setBulkSelected([])} aria-label="清空选择">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>

      <TaskDrawer
        open={selectedId !== null}
        task={selectedTask}
        detail={taskDetailQuery.data ?? null}
        diagnostics={selectedDiagnostics}
        log={taskLogQuery.data ?? null}
        logLoading={taskLogQuery.isFetching && !taskLogQuery.data}
        loading={taskDetailQuery.isPending && selectedId !== null}
        error={taskDetailQuery.isError ? errorText(taskDetailQuery.error) : null}
        commentError={commentMutation.isError ? errorText(commentMutation.error) : null}
        commenting={commentMutation.isPending}
        columns={allowedStatusOptions(workflowQuery.data, selectedTask?.status ?? "", workflowColumns)}
        assignees={assigneeNames}
        saving={updateMutation.isPending}
        onClose={() => setSelectedId(null)}
        onSave={(patch) => void handleSaveDrawer(patch)}
        onAddComment={(body) => void handleAddComment(body)}
      />

      <NewTaskDialog
        open={creating}
        assignees={assigneeNames}
        submitting={createMutation.isPending}
        error={createError}
        onClose={() => {
          setCreating(false);
          setCreateError(null);
        }}
        onSubmit={(input) => void handleCreate(input)}
      />

      {toast ? (
        <div className={s.toast} data-tone={toast.tone} role="status">
          {toast.message}
        </div>
      ) : null}
    </SectionShell>
  );
}
