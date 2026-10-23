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
  FolderPlus,
  Inbox,
  ListTodo,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { Dropdown, type DropdownOption } from "@/components/ui/dropdown";
import { PageSkeleton } from "@/components/page-skeleton";
import { BoardColumn } from "@/components/kanban/board-column";
import { BoardDialog, type BoardCreateInput } from "@/components/kanban/board-dialog";
import { BoardSettings } from "@/components/kanban/board-settings";
import { KanbanMenu, type KanbanMenuItem } from "@/components/kanban/kanban-menu";
import { NewTaskDialog, type NewTaskInput } from "@/components/kanban/new-task-dialog";
import { TaskDrawer } from "@/components/kanban/task-drawer";
import { KanbanToolsetNotice } from "@/components/kanban/toolset-notice";
import {
  useAddKanbanComment,
  useAddKanbanLink,
  useArchiveKanbanBoard,
  useBulkKanbanTasks,
  useCreateKanbanBoard,
  useCreateKanbanTask,
  useDecomposeKanbanTask,
  useDeleteKanbanAttachment,
  useDeleteKanbanTask,
  useKanbanAssignees,
  useKanbanBoard,
  useKanbanBoards,
  useKanbanDiagnostics,
  useKanbanProfiles,
  useKanbanTask,
  useKanbanTaskLog,
  useKanbanWorkflow,
  useReassignKanbanTask,
  useReclaimKanbanTask,
  useRemoveKanbanLink,
  useUpdateKanbanTask,
  useUploadKanbanAttachment,
} from "@/hooks/use-kanban";
import { useKanbanEvents } from "@/hooks/use-kanban-events";
import { useStatus } from "@/hooks/use-status";
import { dashboardPageUrlFromInputs } from "@/lib/dashboard-url";
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
import {
  buildBlockPatch,
  buildUnblockPatch,
  parseDecomposeOutcome,
  profileOptions,
  type DecomposeOutcome,
  type LinkCandidate,
} from "@/lib/kanban-orchestration";
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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  const filterCount =
    (priorityFilter === ALL_PRIORITIES ? 0 : 1) +
    (workspaceFilter === ALL_WORKSPACES ? 0 : 1) +
    (assigneeFilter === ALL_ASSIGNEES ? 0 : 1);

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

  const bulkOptions = useMemo<DropdownOption[]>(
    () => [
      { value: EMPTY_BULK_VALUE, label: "选择操作…" },
      ...workflowColumns
        .filter((column) => dragTargets.has(column.key))
        .map((column) => ({
          value: `status:${column.key}`,
          label: `移动到「${kanbanColumnLabel(column.label)}」`,
        })),
      ...PRIORITY_VALUES.map((value) => ({ value: `priority:${value}`, label: `优先级改 P${value}` })),
      { value: "priority:0", label: "清除优先级" },
      { value: "archive", label: "归档所选" },
    ],
    [dragTargets, workflowColumns],
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

  const profilesQuery = useKanbanProfiles();
  const addLinkMutation = useAddKanbanLink(boardSlug);
  const removeLinkMutation = useRemoveKanbanLink(boardSlug);
  const reassignMutation = useReassignKanbanTask(boardSlug);
  const reclaimMutation = useReclaimKanbanTask(boardSlug);
  const decomposeMutation = useDecomposeKanbanTask(boardSlug);
  const uploadMutation = useUploadKanbanAttachment(boardSlug);
  const deleteAttachmentMutation = useDeleteKanbanAttachment(boardSlug);
  const createBoardMutation = useCreateKanbanBoard();
  const archiveBoardMutation = useArchiveKanbanBoard();

  const [swimlanes, setSwimlanes] = useState(false);
  const [boardDialogOpen, setBoardDialogOpen] = useState(false);
  const [boardDialogError, setBoardDialogError] = useState<string | null>(null);
  const [decomposeOutcome, setDecomposeOutcome] = useState<DecomposeOutcome | null>(null);

  const profileNames = useMemo(
    () => profileOptions(profilesQuery.data?.profiles).map((option) => option.value),
    [profilesQuery.data],
  );

  const boardTasks = useMemo<LinkCandidate[]>(() => {
    const columns = searchableBoard?.columns ?? [];
    return columns.flatMap((column) =>
      column.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status })),
    );
  }, [searchableBoard]);

  const orchestrationBusy = decomposeMutation.isPending
    ? "decompose"
    : addLinkMutation.isPending ||
        removeLinkMutation.isPending ||
        reassignMutation.isPending ||
        uploadMutation.isPending ||
        deleteAttachmentMutation.isPending ||
        updateMutation.isPending
      ? "action"
      : null;

  const orchestrationError = useMemo(() => {
    for (const mutation of [
      addLinkMutation,
      removeLinkMutation,
      reassignMutation,
      uploadMutation,
      deleteAttachmentMutation,
    ]) {
      if (mutation.isError) return errorText(mutation.error);
    }
    return null;
  }, [addLinkMutation, removeLinkMutation, reassignMutation, uploadMutation, deleteAttachmentMutation]);

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

  const resetSelection = useCallback(() => {
    setSelectedId(null);
    setBulkSelected([]);
    setOverrides({});
  }, []);

  const switchView = useCallback(
    (view: KanbanBoardView) => {
      setBoardView(view);
      resetSelection();
    },
    [resetSelection],
  );

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

  useEffect(() => {
    setDecomposeOutcome(null);
  }, [selectedId]);

  const handleAddLink = useCallback(
    async (role: "parent" | "child", otherId: string) => {
      if (!selectedId) return;
      const parentId = role === "parent" ? otherId : selectedId;
      const childId = role === "parent" ? selectedId : otherId;
      try {
        await addLinkMutation.mutateAsync({ parentId, childId, taskId: selectedId });
        pushToast("ok", role === "parent" ? "已加为父任务" : "已加为子任务");
      } catch (error) {
        pushToast("error", `加依赖失败：${errorText(error)}`);
      }
    },
    [addLinkMutation, pushToast, selectedId],
  );

  const handleRemoveLink = useCallback(
    async (role: "parent" | "child", otherId: string) => {
      if (!selectedId) return;
      const parentId = role === "parent" ? otherId : selectedId;
      const childId = role === "parent" ? selectedId : otherId;
      try {
        await removeLinkMutation.mutateAsync({ parentId, childId, taskId: selectedId });
        pushToast("ok", "依赖已移除");
      } catch (error) {
        pushToast("error", `移除依赖失败：${errorText(error)}`);
      }
    },
    [pushToast, removeLinkMutation, selectedId],
  );

  const patchSelected = useCallback(
    async (body: Record<string, unknown>, okMessage: string) => {
      if (!selectedId) return;
      try {
        await updateMutation.mutateAsync({ id: selectedId, body });
        pushToast("ok", okMessage);
      } catch (error) {
        pushToast("error", `操作失败：${errorText(error)}`);
      }
    },
    [pushToast, selectedId, updateMutation],
  );

  const handleBlock = useCallback(
    (reason: string) => void patchSelected(buildBlockPatch(reason), "已标记为阻塞"),
    [patchSelected],
  );

  const handleUnblock = useCallback(
    () => void patchSelected(buildUnblockPatch(), "阻塞已解除"),
    [patchSelected],
  );

  const handleDecompose = useCallback(async () => {
    if (!selectedId) return;
    try {
      const result = await decomposeMutation.mutateAsync({ taskId: selectedId });
      const outcome = parseDecomposeOutcome(result);
      setDecomposeOutcome(outcome);
      pushToast(outcome.ok ? "ok" : "warn", outcome.message);
    } catch (error) {
      const message = errorText(error);
      setDecomposeOutcome({ ok: false, message, childIds: [], newTitle: null });
      pushToast("error", `拆解请求失败：${message}`);
    }
  }, [decomposeMutation, pushToast, selectedId]);

  const handleReassign = useCallback(
    async (profile: string, reclaimFirst: boolean) => {
      if (!selectedId) return;
      try {
        await reassignMutation.mutateAsync({ taskId: selectedId, profile, reclaimFirst });
        pushToast("ok", `已重派给 ${profile}`);
      } catch (error) {
        pushToast("error", `重派失败：${errorText(error)}`);
      }
    },
    [pushToast, reassignMutation, selectedId],
  );

  const handleUploadAttachment = useCallback(
    async (file: File) => {
      if (!selectedId) return;
      try {
        await uploadMutation.mutateAsync({ taskId: selectedId, file });
        pushToast("ok", `已上传 ${file.name}`);
      } catch (error) {
        pushToast("error", `上传失败：${errorText(error)}`);
      }
    },
    [pushToast, selectedId, uploadMutation],
  );

  const handleDeleteAttachment = useCallback(
    async (attachmentId: number) => {
      if (!selectedId) return;
      const confirmed = await confirm({
        title: "删除附件",
        body: "确认删除这个附件？文件会从磁盘上移除。",
        confirmLabel: "删除",
        danger: true,
      });
      if (!confirmed) return;
      try {
        await deleteAttachmentMutation.mutateAsync({ taskId: selectedId, attachmentId });
        pushToast("ok", "附件已删除");
      } catch (error) {
        pushToast("error", `删除附件失败：${errorText(error)}`);
      }
    },
    [confirm, deleteAttachmentMutation, pushToast, selectedId],
  );

  const handleDiagnosticAction = useCallback(
    async (kind: string, payload?: Record<string, unknown> | null) => {
      if (!selectedId) return;
      if (kind === "unblock") {
        handleUnblock();
        return;
      }
      if (kind === "reclaim") {
        try {
          await reclaimMutation.mutateAsync({ taskId: selectedId, reason: "手动回收（看板诊断）" });
          pushToast("ok", "已回收占用，任务回到待执行");
        } catch (error) {
          pushToast("error", `回收失败：${errorText(error)}`);
        }
        return;
      }
      const reclaimFirst = payload?.reclaim_first === true;
      pushToast(
        "warn",
        kind === "reassign"
          ? `在下方「重派」里选 profile${reclaimFirst ? "（建议勾选先回收占用）" : ""}`
          : "这条建议需要手动处理",
      );
    },
    [handleUnblock, pushToast, reclaimMutation, selectedId],
  );

  const handleCreateBoard = useCallback(
    async (input: BoardCreateInput) => {
      setBoardDialogError(null);
      try {
        const result = await createBoardMutation.mutateAsync({
          body: { slug: input.slug, name: input.name || undefined, icon: input.icon || undefined, switch: true },
        });
        const created = result?.board?.slug ?? input.slug;
        setBoardDialogOpen(false);
        boardSlugRef.current = true;
        setBoardSlug(created);
        setBoardView("active");
        resetSelection();
        pushToast("ok", `看板 ${created} 已创建`);
      } catch (error) {
        setBoardDialogError(errorText(error));
      }
    },
    [createBoardMutation, pushToast, resetSelection],
  );

  const handleArchiveBoard = useCallback(async () => {
    const board = boards.find((item) => item.slug === boardSlug);
    const label = board?.name || boardSlug;
    const confirmed = await confirm({
      title: "归档当前看板",
      body: `确认归档「${label}」？看板会移到 boards/_archived/，卡不会再出现在任何视图里，之后可以手动恢复。`,
      confirmLabel: "归档",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await archiveBoardMutation.mutateAsync({ slug: boardSlug });
      boardSlugRef.current = true;
      setBoardSlug("default");
      resetSelection();
      pushToast("ok", `已归档「${label}」`);
    } catch (error) {
      pushToast("error", `归档失败：${errorText(error)}`);
    }
  }, [archiveBoardMutation, boardSlug, boards, confirm, pushToast, resetSelection]);

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

  const copyKanbanUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(kanbanUrl);
      pushToast("ok", "看板地址已复制");
    } catch {
      pushToast("error", "复制失败，请手动复制地址");
    }
  }, [kanbanUrl, pushToast]);

  const handleBulkAction = useCallback(
    (value: string) => {
      if (value === "archive") {
        void runBulk({ archive: true }, "已归档");
        return;
      }
      const [kind, raw] = value.split(":");
      if (kind === "status" && raw) {
        void runBulk({ status: raw }, `已移动到「${labelOf(raw)}」`);
        return;
      }
      if (kind === "priority" && raw) {
        void runBulk({ priority: Number(raw) }, raw === "0" ? "已清除优先级" : `优先级改为 P${raw}`);
      }
    },
    [labelOf, runBulk],
  );

  const moreItems = useMemo<KanbanMenuItem[]>(
    () => [
      { key: "settings", label: "看板设置…", icon: <Settings2 size={14} /> },
      { key: "new-board", label: "新建看板…", icon: <FolderPlus size={14} /> },
      {
        key: "archive-board",
        label: "归档当前看板",
        icon: <Archive size={14} />,
        hint: boards.length <= 1 ? "至少保留一个看板" : undefined,
        disabled: boards.length <= 1,
      },
      { key: "refresh", label: "刷新看板", icon: <RefreshCw size={14} /> },
      { key: "copy-url", label: "复制看板地址", icon: <Copy size={14} /> },
      { key: "open-dashboard", label: "打开官方看板", icon: <ExternalLink size={14} /> },
    ],
    [boards.length],
  );

  const handleMoreAction = useCallback(
    (key: string) => {
      if (key === "settings") {
        setSettingsOpen(true);
        return;
      }
      if (key === "new-board") {
        setBoardDialogError(null);
        setBoardDialogOpen(true);
        return;
      }
      if (key === "archive-board") {
        void handleArchiveBoard();
        return;
      }
      if (key === "refresh") {
        void boardQuery.refetch();
        return;
      }
      if (key === "copy-url") {
        void copyKanbanUrl();
        return;
      }
      if (key === "open-dashboard") void openKanban();
    },
    [boardQuery, copyKanbanUrl, handleArchiveBoard, openKanban],
  );

  const boardLoading = boardQuery.isPending || (workflowQuery.isPending && !workflowQuery.data);
  const boardLoadError = boardQuery.isError
    ? errorText(boardQuery.error)
    : workflowQuery.isError
      ? errorText(workflowQuery.error)
      : null;
  const streamLabel =
    events.status === "open"
      ? "事件流已连接"
      : events.status === "reconnecting"
        ? "事件流重连中"
        : events.status === "connecting"
          ? "事件流连接中"
          : "事件流已停止";
  const healthLabel =
    events.status !== "open" ? streamLabel : statusError ? "内核未确认" : status ? null : "正在确认内核";
  const healthTone = statusError || events.status === "reconnecting" ? "warn" : "idle";

  return (
    <SectionShell
      fill
      title="看板"
      sub="原生任务看板 · 读取内核 Kanban 插件"
      right={
        <div className={s.topActions}>
          <button type="button" className={s.primaryButton} onClick={() => setCreating(true)}>
            <Plus size={15} aria-hidden="true" />
            新建任务
          </button>
        </div>
      }
    >
      <div className={s.page}>
        <KanbanToolsetNotice />
        <div className={s.toolbar}>
          <Dropdown
            ariaLabel="选择看板"
            prefix="看板"
            options={boardOptions}
            value={boardSlug}
            minWidth={180}
            onChange={(next) => {
              setBoardSlug(next);
              resetSelection();
            }}
          />

          <div className={s.segmented} role="group" aria-label="活跃或已归档">
            <button
              type="button"
              className={s.segment}
              data-active={boardView === "active" ? "true" : undefined}
              onClick={() => switchView("active")}
            >
              活跃
            </button>
            <button
              type="button"
              className={s.segment}
              data-active={boardView === "archived" ? "true" : undefined}
              onClick={() => switchView("archived")}
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

          <button
            type="button"
            className={s.filterButton}
            data-active={filtersOpen || filterCount > 0 ? "true" : undefined}
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((previous) => !previous)}
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            筛选
            {filterCount > 0 ? <span className={s.filterCount}>{filterCount}</span> : null}
          </button>

          {healthLabel ? (
            <span className={s.healthChip} data-tone={healthTone}>
              {healthLabel}
            </span>
          ) : null}

          <KanbanMenu
            label="更多操作"
            icon={<MoreHorizontal size={16} aria-hidden="true" />}
            items={moreItems}
            onSelect={handleMoreAction}
          />
        </div>

        {filtersOpen ? (
          <div className={s.filterPanel} role="group" aria-label="筛选条件">
            <Dropdown
              ariaLabel="按优先级筛选"
              prefix="优先级"
              options={priorityOptions}
              value={priorityFilter}
              minWidth={150}
              onChange={setPriorityFilter}
            />

            <Dropdown
              ariaLabel="按工作区筛选"
              prefix="工作区"
              options={workspaceDropdownOptions}
              value={workspaceFilter}
              minWidth={170}
              onChange={setWorkspaceFilter}
            />

            <Dropdown
              ariaLabel="按负责人筛选"
              prefix="负责人"
              options={assigneeOptions}
              value={assigneeFilter}
              minWidth={160}
              onChange={setAssigneeFilter}
            />

            <button type="button" className={s.clearFilters} onClick={clearFilters} disabled={!filtersActive}>
              清除筛选
            </button>
          </div>
        ) : null}

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
          <p className={s.emptyBoard}>这个看板还没有工作流列，去 Dashboard 的 kanban workflow 里配置。</p>
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
                  swimlanes={swimlanes}
                  onOpenTask={setSelectedId}
                  onToggleSelectTask={toggleBulkSelection}
                  onExpandDone={() => setShowDone(true)}
                  onShowAllDone={() => setDoneExpanded(true)}
                  onToggleCollapse={() => toggleCollapse(view.key)}
                />
              ))}
            </div>
            {filtersActive && columnViews.every((view) => view.total === 0) ? (
              <p className={s.emptyBoard}>没有匹配的任务。</p>
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
              ariaLabel="批量操作菜单"
              prefix="批量"
              options={bulkOptions}
              value={EMPTY_BULK_VALUE}
              minWidth={180}
              onChange={(next) => {
                if (!next) return;
                handleBulkAction(next);
              }}
            />
            <button type="button" className={s.dangerButton} onClick={() => void runBulkDelete()}>
              <Trash2 size={14} aria-hidden="true" />
              删除
            </button>
            <button type="button" className={s.iconButton} onClick={() => setBulkSelected([])} aria-label="清空选择">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>

      <BoardSettings
        open={settingsOpen}
        values={{ autoCollapseEmpty, swimlanes, showDone }}
        showDoneAvailable={boardView === "active"}
        onChange={(patch) => {
          if (patch.autoCollapseEmpty !== undefined) setAutoCollapseEmpty(patch.autoCollapseEmpty);
          if (patch.swimlanes !== undefined) setSwimlanes(patch.swimlanes);
          if (patch.showDone !== undefined) {
            setShowDone(patch.showDone);
            setDoneExpanded(false);
          }
        }}
        onClose={() => setSettingsOpen(false)}
      />

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
        profiles={profileNames}
        boardTasks={boardTasks}
        orchestrationBusy={orchestrationBusy}
        orchestrationError={orchestrationError}
        decompose={decomposeOutcome}
        saving={updateMutation.isPending}
        onClose={() => setSelectedId(null)}
        onSave={(patch) => void handleSaveDrawer(patch)}
        onAddComment={(body) => void handleAddComment(body)}
        onAddLink={(role, otherId) => void handleAddLink(role, otherId)}
        onRemoveLink={(role, otherId) => void handleRemoveLink(role, otherId)}
        onBlock={(reason) => void handleBlock(reason)}
        onUnblock={() => void handleUnblock()}
        onDecompose={() => void handleDecompose()}
        onReassign={(profile, reclaimFirst) => void handleReassign(profile, reclaimFirst)}
        onUploadAttachment={(file) => void handleUploadAttachment(file)}
        onDeleteAttachment={(attachmentId) => void handleDeleteAttachment(attachmentId)}
        onDiagnosticAction={(kind, payload) => void handleDiagnosticAction(kind, payload)}
      />

      <BoardDialog
        open={boardDialogOpen}
        submitting={createBoardMutation.isPending}
        error={boardDialogError}
        onClose={() => {
          setBoardDialogOpen(false);
          setBoardDialogError(null);
        }}
        onSubmit={(input) => void handleCreateBoard(input)}
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
