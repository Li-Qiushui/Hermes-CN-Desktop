export interface KanbanTaskAge {
  created_age_seconds?: number | null;
  started_age_seconds?: number | null;
  time_to_complete_seconds?: number | null;
}

export interface KanbanLinkCounts {
  parents?: number | null;
  children?: number | null;
}

export interface KanbanTaskProgress {
  done?: number | null;
  total?: number | null;
}

export interface KanbanTaskWarnings {
  count?: number | null;
  kinds?: Record<string, number> | null;
  latest_at?: number | null;
  highest_severity?: string | null;
}

export interface KanbanDiagnostic {
  kind: string;
  severity?: string | null;
  message?: string | null;
  detail?: string | null;
  action?: string | null;
  suggestion?: string | null;
  count?: number | null;
  last_seen_at?: number | null;
}

export interface KanbanTask {
  id: string;
  title: string;
  body?: string | null;
  body_chars?: number | null;
  assignee?: string | null;
  status: string;
  priority?: number | null;
  created_by?: string | null;
  created_at?: number | null;
  started_at?: number | null;
  completed_at?: number | null;
  workspace_kind?: string | null;
  workspace_path?: string | null;
  consecutive_failures?: number | null;
  last_failure_error?: string | null;
  age?: KanbanTaskAge | null;
  latest_summary?: string | null;
  result?: string | null;
  link_counts?: KanbanLinkCounts | null;
  comment_count?: number | null;
  block_reason?: string | null;
  block_kind?: string | null;
  block_recurrences?: number | null;
  model_override?: string | null;
  provider_override?: string | null;
  session_id?: string | null;
  tenant?: string | null;
  branch_name?: string | null;
  project_id?: string | null;
  progress?: KanbanTaskProgress | null;
  current_run_started_at?: number | null;
  warnings?: KanbanTaskWarnings | null;
  diagnostics?: KanbanDiagnostic[] | null;
}

export interface KanbanBoardColumn {
  name: string;
  tasks: KanbanTask[];
}

export interface KanbanBoardResponse {
  columns: KanbanBoardColumn[];
  tenants?: unknown;
  assignees?: string[];
  latest_event_id?: number | null;
  now?: number | null;
}

export interface KanbanWorkflowColumn {
  key: string;
  label: string;
  icon?: string;
  drag_target?: boolean;
}

export interface KanbanWorkflowResponse {
  columns: KanbanWorkflowColumn[];
  manual?: Record<string, string[]> | null;
}

export interface KanbanBoardSummary {
  slug: string;
  name: string;
  description?: string;
  counts?: { done?: number; archived?: number } | null;
  total?: number;
  is_current?: boolean;
}

export interface KanbanBoardsResponse {
  boards: KanbanBoardSummary[];
  current?: string;
}

export interface KanbanAssignee {
  name: string;
  on_disk?: boolean;
  counts?: Record<string, number> | null;
}

export interface KanbanAssigneesResponse {
  assignees: KanbanAssignee[];
}

export interface KanbanTaskResponse {
  task: KanbanTask;
}

export interface KanbanTaskComment {
  id: number;
  task_id: string;
  author?: string | null;
  body: string;
  created_at?: number | null;
}

export interface KanbanTaskEvent {
  id: number;
  task_id: string;
  run_id?: number | null;
  kind: string;
  payload?: unknown;
  created_at?: number | null;
}

export interface KanbanTaskRun {
  id: number;
  task_id: string;
  profile?: string | null;
  status?: string | null;
  outcome?: string | null;
  started_at?: number | null;
  ended_at?: number | null;
  summary?: string | null;
  worker_pid?: number | null;
}

export interface KanbanTaskAttachment {
  id: number;
  task_id: string;
  filename: string;
  content_type?: string | null;
  size?: number | null;
  uploaded_by?: string | null;
  created_at?: number | null;
}

export interface KanbanChildResult {
  id: string;
  title: string;
  status: string;
  latest_summary?: string | null;
  result?: string | null;
}

export interface KanbanTaskDetailResponse extends KanbanTaskResponse {
  comments?: KanbanTaskComment[] | null;
  events?: KanbanTaskEvent[] | null;
  runs?: KanbanTaskRun[] | null;
  attachments?: KanbanTaskAttachment[] | null;
  child_results?: KanbanChildResult[] | null;
  links?: { parents?: string[] | null; children?: string[] | null } | null;
}

export interface KanbanTaskLogResponse {
  task_id: string;
  path?: string | null;
  exists?: boolean;
  size_bytes?: number | null;
  content?: string | null;
  truncated?: boolean;
}

export interface KanbanDiagnosticsEntry {
  task_id: string;
  task_title?: string | null;
  task_status?: string | null;
  task_assignee?: string | null;
  diagnostics?: KanbanDiagnostic[] | null;
}

export interface KanbanDiagnosticsResponse {
  diagnostics: KanbanDiagnosticsEntry[];
  count?: number;
}

export interface KanbanBulkOutcome {
  id: string;
  ok: boolean;
  error?: string | null;
}

export interface KanbanBulkResponse {
  results: KanbanBulkOutcome[];
}

export type KanbanBoardView = "active" | "archived";

export const ARCHIVED_COLUMN_KEY = "archived";

export const DONE_COLUMN_KEY = "done";
export const DONE_PREVIEW_LIMIT = 10;
export const ALL_ASSIGNEES = "all";
export const ALL_PRIORITIES = "all";
export const ALL_WORKSPACES = "all";
export const COLLAPSED_COLUMN_WIDTH = 44;

const KANBAN_COLUMN_LABELS: Record<string, string> = {
  triage: "待分类",
  todo: "待办",
  scheduled: "已排期",
  ready: "待执行",
  running: "运行中",
  blocked: "已阻塞",
  review: "待审阅",
  done: "已完成",
};

export function kanbanColumnLabel(name: string | null | undefined): string {
  if (typeof name !== "string") return "";
  return KANBAN_COLUMN_LABELS[name.trim().toLowerCase()] ?? name;
}

const KANBAN_EVENT_KIND_LABELS: Record<string, string> = {
  archived: "归档",
  attachment_removed: "移除附件",
  attached: "添加附件",
  blocked: "已阻塞",
  cancelled: "已取消",
  claim_rejected: "认领被拒",
  commented: "评论",
  completed: "完成",
  edited: "编辑",
  failed: "失败",
  gave_up: "放弃重试",
  heartbeat: "心跳",
  linked: "关联",
  owner_admitted: "已接管",
  pr_acceptance: "PR 验收",
  promoted_manual: "转人工",
  reclaimed: "已回收",
  reconciled: "对账修复",
  reprioritized: "调整优先级",
  respawn_guarded: "重启保护",
  review_requested: "请求审阅",
  scheduled: "已排期",
  spawned: "已派出",
  stale: "停滞",
  timed_out: "已超时",
  unlinked: "解除关联",
  worker_registered: "工作进程注册",
  worker_result: "工作结果",
};

export function kanbanEventKindLabel(kind: string | null | undefined): string {
  if (typeof kind !== "string") return "";
  return KANBAN_EVENT_KIND_LABELS[kind.trim().toLowerCase()] ?? kind;
}

export interface TaskUpdatePatchInput {
  status?: string | null;
  assignee?: string | null;
  title?: string | null;
  body?: string | null;
  priority?: number | null;
}

export function humanizeAge(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.floor(seconds);
  if (total < 60) return "刚刚";
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return `${days} 天`;
}

export function formatEpochSeconds(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  return new Date(value * 1000).toLocaleString("zh-CN", { hour12: false });
}

function normalize(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function taskMatchesQuery(task: KanbanTask, query: string | null | undefined): boolean {
  const needle = normalize(query);
  if (!needle) return true;
  if (normalize(task.title).includes(needle)) return true;
  if (normalize(task.latest_summary).includes(needle)) return true;
  return normalize(task.body).includes(needle);
}

export function taskMatchesAssignee(task: KanbanTask, assignee: string | null | undefined): boolean {
  const wanted = normalize(assignee);
  if (!wanted || wanted === ALL_ASSIGNEES) return true;
  return normalize(task.assignee) === wanted;
}

export function normalizePriorityFilter(priority: string | number | null | undefined): string {
  if (priority == null) return ALL_PRIORITIES;
  const raw = typeof priority === "number" ? String(Math.trunc(priority)) : priority.trim();
  if (!raw || raw === ALL_PRIORITIES) return ALL_PRIORITIES;
  return raw;
}

export function taskMatchesPriority(
  task: KanbanTask,
  priority: string | number | null | undefined,
): boolean {
  const wanted = normalizePriorityFilter(priority);
  if (wanted === ALL_PRIORITIES) return true;
  return String(task.priority ?? 0) === wanted;
}

export function normalizeWorkspacePath(path: string | null | undefined): string {
  if (typeof path !== "string") return "";
  return path.trim().replace(/[\\/]+$/, "");
}

export function workspaceBasename(path: string | null | undefined): string {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized) return "";
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || normalized;
}

export function taskMatchesWorkspace(
  task: KanbanTask,
  workspace: string | null | undefined,
): boolean {
  const wanted = normalizeWorkspacePath(workspace);
  if (!wanted || wanted === ALL_WORKSPACES) return true;
  return normalizeWorkspacePath(task.workspace_path) === wanted;
}

export interface KanbanFilterCriteria {
  query?: string | null;
  assignee?: string | null;
  priority?: string | number | null;
  workspace?: string | null;
}

export function filterTasks(tasks: KanbanTask[], criteria: KanbanFilterCriteria = {}): KanbanTask[] {
  return tasks.filter(
    (task) =>
      taskMatchesQuery(task, criteria.query) &&
      taskMatchesAssignee(task, criteria.assignee) &&
      taskMatchesPriority(task, criteria.priority) &&
      taskMatchesWorkspace(task, criteria.workspace),
  );
}

export function hasActiveFilters(criteria: KanbanFilterCriteria = {}): boolean {
  const assignee = normalize(criteria.assignee);
  const workspace = normalizeWorkspacePath(criteria.workspace);
  if (normalize(criteria.query).length > 0) return true;
  if (assignee !== "" && assignee !== ALL_ASSIGNEES) return true;
  if (normalizePriorityFilter(criteria.priority) !== ALL_PRIORITIES) return true;
  return workspace !== "" && workspace !== ALL_WORKSPACES;
}

export function emptyFilterCriteria(): KanbanFilterCriteria {
  return { query: "", assignee: ALL_ASSIGNEES, priority: ALL_PRIORITIES, workspace: ALL_WORKSPACES };
}

export interface WorkspaceOption {
  value: string;
  label: string;
  path: string;
}

export function collectWorkspaceOptions(
  columns: KanbanBoardColumn[] | undefined,
): WorkspaceOption[] {
  const seen = new Map<string, WorkspaceOption>();
  for (const column of columns ?? []) {
    for (const task of column.tasks ?? []) {
      const path = normalizeWorkspacePath(task.workspace_path);
      if (!path || seen.has(path)) continue;
      seen.set(path, { value: path, label: workspaceBasename(path), path });
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label));
}

export function sortDoneTasks(tasks: KanbanTask[]): KanbanTask[] {
  return [...tasks].sort((a, b) => {
    const completedDiff = (b.completed_at ?? 0) - (a.completed_at ?? 0);
    if (completedDiff !== 0) return completedDiff;
    return (b.created_at ?? 0) - (a.created_at ?? 0);
  });
}

export interface ColumnViewOptions extends KanbanFilterCriteria {
  showDone?: boolean;
  doneExpanded?: boolean;
  doneLimit?: number;
}

export interface ColumnView {
  key: string;
  label: string;
  dragTarget: boolean;
  tasks: KanbanTask[];
  total: number;
  unfilteredTotal: number;
  collapsed: boolean;
  hiddenCount: number;
}

export function buildColumnViews(
  workflow: KanbanWorkflowColumn[],
  boardColumns: KanbanBoardColumn[],
  options: ColumnViewOptions = {},
): ColumnView[] {
  const showDone = options.showDone ?? false;
  const doneExpanded = options.doneExpanded ?? false;
  const doneLimit = options.doneLimit ?? DONE_PREVIEW_LIMIT;
  const criteria: KanbanFilterCriteria = {
    query: options.query,
    assignee: options.assignee,
    priority: options.priority,
    workspace: options.workspace,
  };
  const tasksByName = new Map<string, KanbanTask[]>();
  for (const column of boardColumns) {
    tasksByName.set(column.name, column.tasks ?? []);
  }

  return workflow.map((column) => {
    const source = tasksByName.get(column.key) ?? [];
    const matched = filterTasks(source, criteria);
    const isDone = column.key === DONE_COLUMN_KEY;
    const ordered = isDone ? sortDoneTasks(matched) : matched;
    const base = {
      key: column.key,
      label: column.label,
      dragTarget: Boolean(column.drag_target),
      unfilteredTotal: source.length,
    };

    if (isDone && !showDone) {
      return { ...base, tasks: [], total: ordered.length, collapsed: true, hiddenCount: ordered.length };
    }
    if (isDone && !doneExpanded) {
      const visible = ordered.slice(0, doneLimit);
      return {
        ...base,
        tasks: visible,
        total: ordered.length,
        collapsed: false,
        hiddenCount: ordered.length - visible.length,
      };
    }
    return { ...base, tasks: ordered, total: ordered.length, collapsed: false, hiddenCount: 0 };
  });
}

export type ColumnCollapseMark = "collapsed" | "expanded";
export type ColumnCollapseMarks = Record<string, ColumnCollapseMark>;
export type ColumnCollapseReason = "manual" | "auto" | null;

export interface ColumnCollapseOptions {
  marks?: ColumnCollapseMarks;
  autoCollapseEmpty?: boolean;
  dragging?: boolean;
  hoveredKey?: string | null;
}

export interface ColumnCollapseState {
  collapsed: boolean;
  reason: ColumnCollapseReason;
}

export function columnCollapseStorageKey(slug: string): string {
  return `kanban:collapsed:${slug || "default"}`;
}

export function parseCollapseMarks(raw: string | null | undefined): ColumnCollapseMarks {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (Array.isArray(parsed)) {
    const marks: ColumnCollapseMarks = {};
    for (const key of parsed) {
      if (typeof key === "string" && key) marks[key] = "collapsed";
    }
    return marks;
  }
  if (!parsed || typeof parsed !== "object") return {};
  const marks: ColumnCollapseMarks = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key) continue;
    if (value === "collapsed" || value === "expanded") marks[key] = value;
  }
  return marks;
}

export function serializeCollapseMarks(marks: ColumnCollapseMarks): string {
  const keys = Object.keys(marks).sort();
  const ordered: ColumnCollapseMarks = {};
  for (const key of keys) ordered[key] = marks[key];
  return JSON.stringify(ordered);
}

export function setCollapseMark(
  marks: ColumnCollapseMarks,
  key: string,
  mark: ColumnCollapseMark | null,
): ColumnCollapseMarks {
  const next = { ...marks };
  if (mark) next[key] = mark;
  else delete next[key];
  return next;
}

export function resolveColumnCollapse(
  views: Array<Pick<ColumnView, "key" | "total"> & { unfilteredTotal?: number }>,
  options: ColumnCollapseOptions = {},
): Record<string, ColumnCollapseState> {
  const marks = options.marks ?? {};
  const autoCollapseEmpty = options.autoCollapseEmpty ?? true;
  const states: Record<string, ColumnCollapseState> = {};
  for (const view of views) {
    const mark = marks[view.key];
    const isEmpty = (view.unfilteredTotal ?? view.total) === 0;
    let state: ColumnCollapseState;
    if (mark === "collapsed") state = { collapsed: true, reason: "manual" };
    else if (mark === "expanded") state = { collapsed: false, reason: null };
    else if (autoCollapseEmpty && isEmpty) state = { collapsed: true, reason: "auto" };
    else state = { collapsed: false, reason: null };

    if (state.collapsed && options.dragging && options.hoveredKey === view.key) {
      states[view.key] = { collapsed: false, reason: state.reason };
      continue;
    }
    states[view.key] = state;
  }
  return states;
}

export function dragTargetKeys(workflow: KanbanWorkflowColumn[]): Set<string> {
  return new Set(workflow.filter((column) => column.drag_target).map((column) => column.key));
}

export function manualTransitions(
  workflow: KanbanWorkflowResponse | undefined,
  status: string,
): string[] | null {
  const manual = workflow?.manual;
  if (!manual || typeof manual !== "object") return null;
  const list = manual[status];
  return Array.isArray(list) ? list : null;
}

export function allowedDropTargets(
  workflow: KanbanWorkflowResponse | undefined,
  status: string,
): Set<string> {
  const targets = dragTargetKeys(workflow?.columns ?? []);
  const manual = manualTransitions(workflow, status);
  if (!manual) return targets;
  return new Set(manual.filter((key) => targets.has(key)));
}

export function allowedStatusOptions(
  workflow: KanbanWorkflowResponse | undefined,
  status: string,
  fallback: KanbanWorkflowColumn[],
): KanbanWorkflowColumn[] {
  const manual = manualTransitions(workflow, status);
  if (!manual) return fallback;
  const keep = new Set([status, ...manual]);
  return fallback.filter((column) => keep.has(column.key));
}

export function canDropTask(
  task: Pick<KanbanTask, "status"> | null | undefined,
  targetKey: string | null | undefined,
  targets: Set<string> | string[],
): boolean {
  if (!task || !targetKey) return false;
  const allowed = Array.isArray(targets) ? new Set(targets) : targets;
  if (!allowed.has(targetKey)) return false;
  return task.status !== targetKey;
}

export function buildStatusPatch(status: string): { status: string } {
  return { status };
}

export function buildTaskUpdatePatch(input: TaskUpdatePatchInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const status = normalize(input.status);
  if (status) patch.status = status;
  const assignee = typeof input.assignee === "string" ? input.assignee.trim() : "";
  if (assignee) patch.assignee = assignee;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title) patch.title = title;
  if (typeof input.body === "string") patch.body = input.body;
  if (typeof input.priority === "number" && Number.isFinite(input.priority)) patch.priority = input.priority;
  return patch;
}

export function applyOverrides(
  board: KanbanBoardResponse,
  overrides: Record<string, string>,
): KanbanBoardResponse {
  let next = board;
  for (const [taskId, status] of Object.entries(overrides)) {
    next = applyTaskStatus(next, taskId, status);
  }
  return next;
}

export function applyTaskStatus(
  board: KanbanBoardResponse,
  taskId: string,
  status: string,
): KanbanBoardResponse {
  let moved: KanbanTask | null = null;
  const stripped = board.columns.map((column) => {
    const tasks: KanbanTask[] = [];
    for (const task of column.tasks) {
      if (task.id === taskId) {
        moved = { ...task, status };
      } else {
        tasks.push(task);
      }
    }
    return { ...column, tasks };
  });
  if (!moved) return board;
  const next = stripped.map((column) =>
    column.name === status
      ? { ...column, tasks: [{ ...(moved as KanbanTask) }, ...column.tasks] }
      : column,
  );
  return { ...board, columns: next };
}

export function findTask(
  board: KanbanBoardResponse | undefined,
  taskId: string | null,
): KanbanTask | null {
  if (!board || !taskId) return null;
  for (const column of board.columns) {
    for (const task of column.tasks) {
      if (task.id === taskId) return task;
    }
  }
  return null;
}

export function collectAssigneeNames(
  assignees: KanbanAssignee[] | undefined,
  board: KanbanBoardResponse | undefined,
): string[] {
  const names = new Set<string>();
  for (const item of assignees ?? []) {
    if (item.name) names.add(item.name);
  }
  for (const item of board?.assignees ?? []) {
    if (item) names.add(item);
  }
  for (const column of board?.columns ?? []) {
    for (const task of column.tasks) {
      if (task.assignee) names.add(task.assignee);
    }
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

export function priorityLabel(priority: number | null | undefined): string | null {
  if (typeof priority !== "number" || !Number.isFinite(priority) || priority <= 0) return null;
  return `P${priority}`;
}

export function runClockStartSeconds(task: KanbanTask | null | undefined): number | null {
  if (!task) return null;
  const started = task.current_run_started_at;
  if (typeof started !== "number" || !Number.isFinite(started) || started <= 0) return null;
  return started;
}

export function formatRunClock(startSeconds: number | null | undefined, nowMs: number): string {
  if (typeof startSeconds !== "number" || !Number.isFinite(startSeconds) || startSeconds <= 0) {
    return "—";
  }
  const elapsed = Math.max(0, Math.floor(nowMs / 1000 - startSeconds));
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

export function cardSummaryLine(task: KanbanTask, limit = 96): string {
  const raw = task.latest_summary ?? "";
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit)}…`;
}

export function progressLabel(progress: KanbanTaskProgress | null | undefined): string | null {
  const total = progress?.total;
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return null;
  const done = typeof progress?.done === "number" && Number.isFinite(progress.done) ? progress.done : 0;
  return `${done}/${total}`;
}

export function blockedBadgeLabel(task: KanbanTask): string | null {
  if (task.status !== "blocked") return null;
  const reason = (task.block_reason ?? "").replace(/\s+/g, " ").trim();
  if (reason) return reason.length > 40 ? `${reason.slice(0, 40)}…` : reason;
  const kind = (task.block_kind ?? "").trim();
  if (kind) return kind;
  return "阻塞中";
}

export interface KanbanEventsUrlInput {
  board: string;
  since?: number | null;
  token?: string | null;
  /** 完整事件端点（可能带 /hermes 这类路径前缀），只换协议不动路径。 */
  endpoint?: string | null;
  origin?: string | null;
}

export function kanbanEventsUrl(input: KanbanEventsUrlInput): string {
  const endpoint = (input.endpoint ?? "").trim();
  const rawOrigin = (input.origin ?? "").trim();
  const fallbackOrigin =
    typeof window !== "undefined" && window.location?.origin ? window.location.origin : "http://localhost";
  const base = rawOrigin || fallbackOrigin;
  const url = endpoint
    ? new URL(endpoint, base)
    : new URL("/api/plugins/kanban/events", base);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.searchParams.set("board", input.board || "default");
  if (typeof input.since === "number" && Number.isFinite(input.since) && input.since >= 0) {
    url.searchParams.set("since", String(Math.trunc(input.since)));
  }
  const token = (input.token ?? "").trim();
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

export interface KanbanEventFrame {
  cursor: number;
  taskIds: string[];
  eventCount: number;
}

export function parseKanbanEventFrame(raw: unknown): KanbanEventFrame | null {
  let payload: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return null;
    try {
      payload = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object") return null;
  const frame = payload as { events?: unknown; cursor?: unknown };
  if (!Array.isArray(frame.events)) return null;
  const taskIds: string[] = [];
  for (const event of frame.events) {
    if (!event || typeof event !== "object") continue;
    const taskId = (event as { task_id?: unknown }).task_id;
    if (typeof taskId === "string" && taskId && !taskIds.includes(taskId)) taskIds.push(taskId);
  }
  const cursor =
    typeof frame.cursor === "number" && Number.isFinite(frame.cursor)
      ? frame.cursor
      : null;
  return {
    cursor: cursor ?? 0,
    taskIds,
    eventCount: frame.events.length,
  };
}

export const KANBAN_RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;
export const KANBAN_EVENTS_HEARTBEAT_MS = 60_000;
export const KANBAN_EVENTS_STALE_MS = 180_000;

export function nextReconnectDelayMs(attempt: number): number {
  const index = Math.min(Math.max(0, Math.trunc(attempt)), KANBAN_RECONNECT_DELAYS_MS.length - 1);
  return KANBAN_RECONNECT_DELAYS_MS[index];
}

export function toggleTaskSelection(selected: readonly string[], taskId: string): string[] {
  if (!taskId) return [...selected];
  return selected.includes(taskId)
    ? selected.filter((id) => id !== taskId)
    : [...selected, taskId];
}

export function isTaskSelected(selected: readonly string[], taskId: string): boolean {
  return selected.includes(taskId);
}

export function retainSelectableTasks(selected: readonly string[], board: KanbanBoardResponse | undefined): string[] {
  if (!board) return [];
  const available = new Set<string>();
  for (const column of board.columns) {
    for (const task of column.tasks) available.add(task.id);
  }
  return selected.filter((id) => available.has(id));
}

export interface BulkPatchInput {
  status?: string | null;
  priority?: number | null;
  archive?: boolean | null;
}

export function buildBulkPatch(input: BulkPatchInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const status = normalize(input.status);
  if (status) patch.status = status;
  if (typeof input.priority === "number" && Number.isFinite(input.priority)) patch.priority = input.priority;
  if (input.archive === true) patch.archive = true;
  return patch;
}

export async function deleteTasksSequentially(
  ids: readonly string[],
  remove: (id: string) => Promise<unknown>,
): Promise<string[]> {
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await remove(id);
    } catch {
      failed.push(id);
    }
  }
  return failed;
}

export function projectBoardTask(task: KanbanTask): KanbanTask {
  if (typeof task.body !== "string" || task.body.length === 0) return task;
  const { body, ...rest } = task;
  return { ...rest, body: null, body_chars: body.length } as KanbanTask;
}

export function projectBoardCards(board: KanbanBoardResponse): KanbanBoardResponse {
  let changed = false;
  const columns = board.columns.map((column) => {
    let columnChanged = false;
    const tasks = column.tasks.map((task) => {
      const projected = projectBoardTask(task);
      if (projected === task) return task;
      changed = true;
      columnChanged = true;
      return projected;
    });
    return columnChanged ? { ...column, tasks } : column;
  });
  return changed ? { ...board, columns } : board;
}

export function projectColumnViews(views: ColumnView[]): ColumnView[] {
  return views.map((view) => {
    let changed = false;
    const tasks = view.tasks.map((task) => {
      const projected = projectBoardTask(task);
      if (projected !== task) changed = true;
      return projected;
    });
    return changed ? { ...view, tasks } : view;
  });
}

export type KanbanActivityKind = "event" | "run";

export interface KanbanActivityItem {
  key: string;
  kind: KanbanActivityKind;
  at: number | null;
  label: string;
  detail?: string | null;
}

export function buildActivityFeed(
  events: KanbanTaskEvent[] | null | undefined,
  runs: KanbanTaskRun[] | null | undefined,
): KanbanActivityItem[] {
  const items: KanbanActivityItem[] = [];
  for (const event of events ?? []) {
    items.push({
      key: `event-${event.id}`,
      kind: "event",
      at: event.created_at ?? null,
      label: event.kind || "event",
      detail: eventDetail(event),
    });
  }
  for (const run of runs ?? []) {
    const outcome = run.outcome || run.status || "";
    items.push({
      key: `run-${run.id}`,
      kind: "run",
      at: run.started_at ?? null,
      label: `运行 #${run.id}${outcome ? ` · ${outcome}` : ""}`,
      detail: run.summary ?? null,
    });
  }
  return items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

function eventDetail(event: KanbanTaskEvent): string | null {
  const payload = event.payload;
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const preferred = ["status", "assignee", "summary", "reason", "message", "detail"];
  for (const key of preferred) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.length > 160 ? `${value.slice(0, 160)}…` : value;
    }
  }
  try {
    const text = JSON.stringify(record);
    if (text && text !== "{}") return text.length > 160 ? `${text.slice(0, 160)}…` : text;
  } catch {
    return null;
  }
  return null;
}

export const LOG_TAIL_MAX_LINES = 200;

export function tailLogLines(content: string | null | undefined, maxLines = LOG_TAIL_MAX_LINES): {
  text: string;
  hiddenLines: number;
} {
  if (!content) return { text: "", hiddenLines: 0 };
  const lines = content.split(/\r?\n/);
  if (lines.length <= maxLines) return { text: lines.join("\n"), hiddenLines: 0 };
  return { text: lines.slice(-maxLines).join("\n"), hiddenLines: lines.length - maxLines };
}

