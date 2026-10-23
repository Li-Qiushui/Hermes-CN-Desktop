import type {
  KanbanDiagnostic,
  KanbanDiagnosticAction,
  KanbanLinkRef,
  KanbanProfile,
  KanbanTask,
} from "@/lib/kanban";

export const KANBAN_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const BOARD_SLUG_PATTERN = /^[a-z0-9][a-z0-9\-_]{0,63}$/;

export function buildLinkBody(
  parentId: string | null | undefined,
  childId: string | null | undefined,
): { parent_id: string; child_id: string } | null {
  const parent = (parentId ?? "").trim();
  const child = (childId ?? "").trim();
  if (!parent || !child || parent === child) return null;
  return { parent_id: parent, child_id: child };
}

export function buildBlockPatch(reason?: string | null): Record<string, unknown> {
  const patch: Record<string, unknown> = { status: "blocked" };
  const text = (reason ?? "").trim();
  if (text) patch.block_reason = text;
  return patch;
}

export function buildUnblockPatch(): { status: string } {
  return { status: "ready" };
}

export function isBlocked(task: Pick<KanbanTask, "status"> | null | undefined): boolean {
  return task?.status === "blocked";
}

export interface ReassignInput {
  profile?: string | null;
  reclaimFirst?: boolean;
  reason?: string | null;
}

export interface ReassignBody {
  profile: string | null;
  reclaim_first: boolean;
  reason?: string;
}

export function buildReassignBody(input: ReassignInput): ReassignBody | null {
  const profile = (input.profile ?? "").trim();
  if (!profile) return null;
  const body: ReassignBody = { profile, reclaim_first: Boolean(input.reclaimFirst) };
  const reason = (input.reason ?? "").trim();
  if (reason) body.reason = reason;
  return body;
}

export const DECOMPOSE_STATUSES = ["triage", "todo"] as const;

export function canDecompose(task: Pick<KanbanTask, "status"> | null | undefined): boolean {
  const status = (task?.status ?? "").trim().toLowerCase();
  return (DECOMPOSE_STATUSES as readonly string[]).includes(status);
}

export interface DecomposeOutcome {
  ok: boolean;
  message: string;
  childIds: string[];
  newTitle: string | null;
}

export function parseDecomposeOutcome(raw: unknown): DecomposeOutcome {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ok = record.ok === true;
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  const childIds = Array.isArray(record.child_ids)
    ? record.child_ids.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const newTitle = typeof record.new_title === "string" && record.new_title.trim() ? record.new_title.trim() : null;
  let message: string;
  if (!ok) {
    message = reason || "后端没有返回拆解原因（原文为空）";
  } else if (childIds.length > 0) {
    message = `已拆出 ${childIds.length} 个子任务`;
  } else if (typeof record.fanout === "boolean" && !record.fanout) {
    message = reason || "后端判定这张卡不需要拆解";
  } else {
    message = "拆解完成，但没有返回子任务";
  }
  return { ok, message, childIds, newTitle };
}

export function decomposeChildNames(outcome: DecomposeOutcome, limit = 6): string {
  const names = outcome.childIds.slice(0, limit);
  return names.length === 0 ? "" : names.join("、");
}

export function phantomIdsOf(diag: KanbanDiagnostic): string[] {
  const data = diag.data;
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["phantom_ids", "phantom_refs", "phantom_cards"]) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item.trim() && !out.includes(item.trim())) out.push(item.trim());
    }
  }
  return out;
}

export function diagnosticActions(diag: KanbanDiagnostic): KanbanDiagnosticAction[] {
  if (!Array.isArray(diag.actions)) return [];
  return diag.actions.filter(
    (action): action is KanbanDiagnosticAction =>
      Boolean(action) &&
      typeof action.kind === "string" &&
      action.kind.trim().length > 0 &&
      typeof action.label === "string" &&
      action.label.trim().length > 0,
  );
}

export function diagnosticText(diag: KanbanDiagnostic): string {
  const title = (diag.title ?? "").trim();
  const detail = (diag.detail ?? diag.message ?? "").trim();
  if (title && detail) return `${title} · ${detail}`;
  return title || detail || diag.kind;
}

export function diagnosticCommand(action: KanbanDiagnosticAction): string {
  const payload = action.payload;
  if (!payload || typeof payload !== "object") return "";
  const command = (payload as Record<string, unknown>).command;
  return typeof command === "string" ? command.trim() : "";
}

export function diagnosticReclaimFirst(action: KanbanDiagnosticAction): boolean {
  const payload = action.payload;
  if (!payload || typeof payload !== "object") return false;
  return (payload as Record<string, unknown>).reclaim_first === true;
}

export interface LinkGroup {
  role: "parent" | "child";
  id: string;
  title: string;
  status: string;
}

export function buildLinkGroups(
  links: { parents?: string[] | null; children?: string[] | null } | null | undefined,
  refs: KanbanLinkRef[] | null | undefined,
): LinkGroup[] {
  const byId = new Map<string, KanbanLinkRef>();
  for (const ref of refs ?? []) {
    if (ref?.id) byId.set(ref.id, ref);
  }
  const groups: LinkGroup[] = [];
  const push = (role: LinkGroup["role"], id: string) => {
    const ref = byId.get(id);
    groups.push({
      role,
      id,
      title: (ref?.title ?? "").trim() || id,
      status: (ref?.status ?? "").trim() || "unknown",
    });
  };
  for (const id of links?.parents ?? []) if (id) push("parent", id);
  for (const id of links?.children ?? []) if (id) push("child", id);
  return groups;
}

export interface LinkCandidate {
  id: string;
  title: string;
  status: string;
}

export function linkCandidates(
  tasks: Array<Pick<KanbanTask, "id" | "title" | "status">> | null | undefined,
  taskId: string | null | undefined,
  links: { parents?: string[] | null; children?: string[] | null } | null | undefined,
): LinkCandidate[] {
  const blocked = new Set<string>();
  if (taskId) blocked.add(taskId);
  for (const id of links?.parents ?? []) if (id) blocked.add(id);
  for (const id of links?.children ?? []) if (id) blocked.add(id);
  const out: LinkCandidate[] = [];
  const seen = new Set<string>();
  for (const task of tasks ?? []) {
    if (!task?.id || blocked.has(task.id) || seen.has(task.id)) continue;
    seen.add(task.id);
    out.push({ id: task.id, title: (task.title ?? "").trim() || task.id, status: task.status ?? "" });
  }
  return out;
}

export interface BoardSlugCheck {
  ok: boolean;
  slug: string;
  error: string | null;
}

export function normalizeBoardSlug(raw: string | null | undefined): string {
  return (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_]/g, "")
    .slice(0, 64);
}

export function checkBoardSlug(raw: string | null | undefined): BoardSlugCheck {
  const slug = normalizeBoardSlug(raw);
  if (!slug) return { ok: false, slug, error: "slug 不能为空" };
  if (!BOARD_SLUG_PATTERN.test(slug)) return { ok: false, slug, error: "slug 只能用 a-z、0-9、连字符和下划线，且以字母或数字开头" };
  return { ok: true, slug, error: null };
}

export interface CreateBoardInput {
  slug: string;
  name?: string | null;
  icon?: string | null;
  description?: string | null;
  switchToBoard?: boolean;
}

export interface CreateBoardResult {
  ok: boolean;
  body: Record<string, unknown>;
  error: string | null;
}

export function buildCreateBoardBody(input: CreateBoardInput): CreateBoardResult {
  const checked = checkBoardSlug(input.slug);
  if (!checked.ok) return { ok: false, body: {}, error: checked.error };
  const body: Record<string, unknown> = { slug: checked.slug };
  const name = (input.name ?? "").trim();
  if (name) body.name = name;
  const icon = (input.icon ?? "").trim();
  if (icon) body.icon = icon;
  const description = (input.description ?? "").trim();
  if (description) body.description = description;
  if (input.switchToBoard !== false) body.switch = true;
  return { ok: true, body, error: null };
}

export function buildArchiveBoardPath(slug: string | null | undefined): string {
  return `/api/plugins/kanban/boards/${encodeURIComponent((slug ?? "").trim() || "default")}`;
}

export interface Swimlane {
  key: string;
  label: string;
  tasks: KanbanTask[];
}

export const UNASSIGNED_LANE_KEY = "__unassigned__";

export function groupTasksByAssignee(tasks: KanbanTask[] | null | undefined): Swimlane[] {
  const lanes = new Map<string, Swimlane>();
  for (const task of tasks ?? []) {
    const raw = (task.assignee ?? "").trim();
    const key = raw || UNASSIGNED_LANE_KEY;
    const lane = lanes.get(key) ?? { key, label: raw || "未指派", tasks: [] };
    lane.tasks.push(task);
    lanes.set(key, lane);
  }
  return Array.from(lanes.values()).sort((a, b) => {
    if (a.key === UNASSIGNED_LANE_KEY) return 1;
    if (b.key === UNASSIGNED_LANE_KEY) return -1;
    return a.label.localeCompare(b.label);
  });
}

export function profileOptions(profiles: KanbanProfile[] | null | undefined): Array<{ value: string; label: string; hint?: string }> {
  return (profiles ?? [])
    .filter((profile) => Boolean(profile?.name))
    .map((profile) => ({
      value: profile.name,
      label: profile.name,
      hint: (profile.description ?? "").trim() || profile.model || undefined,
    }));
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.trunc(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function attachmentTooLarge(size: number | null | undefined): boolean {
  return typeof size === "number" && Number.isFinite(size) && size > KANBAN_ATTACHMENT_MAX_BYTES;
}

export function attachmentLimitLabel(): string {
  return `${KANBAN_ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB`;
}

export function attachmentDeletePath(attachmentId: number): string {
  return `/api/plugins/kanban/attachments/${Math.trunc(attachmentId)}`;
}

export function attachmentUploadPath(taskId: string, slug: string): string {
  return `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}/attachments?board=${encodeURIComponent(slug || "default")}`;
}
