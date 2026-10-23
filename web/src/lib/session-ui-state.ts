import { readUiValue, subscribeUiStore, writeUiValue } from "@/lib/ui-store";

const SESSION_TITLE_OVERRIDES_STORAGE_KEY = "hermes-cn-ui.sessionTitleOverrides";
const PINNED_SESSION_IDS_STORAGE_KEY = "hermes-cn-ui.pinnedSessionIds";
const SESSION_UI_STATE_CHANGED_EVENT = "hermes-cn-ui.sessionUiState.changed";

function emitSessionUiStateChange(): void {
  try {
    window.dispatchEvent(new Event(SESSION_UI_STATE_CHANGED_EVENT));
  } catch {}
}

function readJSON<T>(key: string, fallback: T): T {
  return readUiValue<T>(key, fallback);
}

function writeJSON(key: string, value: unknown): void {
  writeUiValue(key, value);
  emitSessionUiStateChange();
}

export function readSessionTitleOverrides(): Record<string, string> {
  const raw = readJSON<unknown>(SESSION_TITLE_OVERRIDES_STORAGE_KEY, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).flatMap(([sessionId, title]) => {
      const cleanSessionId = sessionId.trim();
      const cleanTitle = typeof title === "string" ? title.trim() : "";
      return cleanSessionId && cleanTitle ? [[cleanSessionId, cleanTitle]] : [];
    }),
  );
}

export function rememberSessionTitleOverride(sessionId: string, title: string): void {
  const cleanSessionId = sessionId.trim();
  const cleanTitle = title.trim();
  if (!cleanSessionId || !cleanTitle) return;
  const overrides = readSessionTitleOverrides();
  overrides[cleanSessionId] = cleanTitle;
  writeJSON(SESSION_TITLE_OVERRIDES_STORAGE_KEY, overrides);
}

function normalizeSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    if (typeof item !== "string") return [];
    const id = item.trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [id];
  });
}

export function readPinnedSessionIds(): Set<string> {
  return new Set(normalizeSessionIds(readJSON<unknown>(PINNED_SESSION_IDS_STORAGE_KEY, [])));
}

export function writePinnedSessionIds(ids: Iterable<string>): Set<string> {
  const cleanIds = normalizeSessionIds(Array.from(ids));
  writeJSON(PINNED_SESSION_IDS_STORAGE_KEY, cleanIds);
  return new Set(cleanIds);
}

export function isSessionPinned(sessionId: string): boolean {
  const cleanSessionId = sessionId.trim();
  return cleanSessionId ? readPinnedSessionIds().has(cleanSessionId) : false;
}

export function togglePinnedSession(sessionId: string): Set<string> {
  const cleanSessionId = sessionId.trim();
  const ids = readPinnedSessionIds();
  if (!cleanSessionId) return ids;
  if (ids.has(cleanSessionId)) ids.delete(cleanSessionId);
  else ids.add(cleanSessionId);
  return writePinnedSessionIds(ids);
}

export function unpinSessions(sessionIds: Iterable<string>): Set<string> {
  const ids = readPinnedSessionIds();
  let changed = false;
  for (const sessionId of sessionIds) {
    const cleanSessionId = sessionId.trim();
    if (cleanSessionId && ids.delete(cleanSessionId)) changed = true;
  }
  return changed ? writePinnedSessionIds(ids) : ids;
}

export function subscribeSessionUiStateChanges(listener: () => void): () => void {
  const onEvent = () => listener();
  window.addEventListener(SESSION_UI_STATE_CHANGED_EVENT, onEvent);
  const unsubscribe = subscribeUiStore(listener);
  return () => {
    window.removeEventListener(SESSION_UI_STATE_CHANGED_EVENT, onEvent);
    unsubscribe();
  };
}

export function reorderSessionIds(
  ids: readonly string[],
  fromId: string,
  toId: string,
): string[] {
  const cleanFrom = fromId.trim();
  const cleanTo = toId.trim();
  const order = ids.flatMap((raw) => {
    const id = raw.trim();
    return id ? [id] : [];
  });
  const fromIndex = order.indexOf(cleanFrom);
  const toIndex = order.indexOf(cleanTo);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return order;
  const next = [...order];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export function reorderPinnedSessionIds(fromId: string, toId: string): Set<string> {
  const current = Array.from(readPinnedSessionIds());
  const next = reorderSessionIds(current, fromId, toId);
  if (next.join("\u0000") === current.join("\u0000")) return new Set(current);
  return writePinnedSessionIds(next);
}

export type SidebarProfileScope = "active" | "all";

const SIDEBAR_PROFILE_SCOPE_KEY = "hermes-cn-ui.sidebarProfileScope";

export function readSidebarProfileScope(): SidebarProfileScope {
  return readJSON<unknown>(SIDEBAR_PROFILE_SCOPE_KEY, "active") === "all" ? "all" : "active";
}

export function writeSidebarProfileScope(scope: SidebarProfileScope): SidebarProfileScope {
  const clean: SidebarProfileScope = scope === "all" ? "all" : "active";
  writeJSON(SIDEBAR_PROFILE_SCOPE_KEY, clean);
  return clean;
}

export function distinctSessionProfiles<T>(
  sessions: readonly T[],
  profileOf: (session: T) => string | undefined,
): string[] {
  const seen = new Set<string>();
  for (const session of sessions) {
    const profile = (profileOf(session) ?? "").trim();
    if (profile) seen.add(profile);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

export function needsInputCountsByProfile<T>(
  sessions: readonly T[],
  profileOf: (session: T) => string | undefined,
  stateOf: (session: T) => SessionDotState,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const session of sessions) {
    if (stateOf(session) !== "needs-input") continue;
    const profile = (profileOf(session) ?? "").trim();
    if (!profile) continue;
    counts[profile] = (counts[profile] ?? 0) + 1;
  }
  return counts;
}


export type SessionDotState =
  | "needs-input"
  | "stalled"
  | "working"
  | "background"
  | "unread"
  | "draft"
  | "idle";

export type SessionStatusBucket = "needs-input" | "working" | "unread" | "draft" | "idle";

export interface SessionDotSignals {
  needsInput?: boolean;
  stalled?: boolean;
  working?: boolean;
  background?: boolean;
  unread?: boolean;
  draft?: boolean;
}

export function resolveSessionDotState(signals: SessionDotSignals): SessionDotState {
  if (signals.needsInput) return "needs-input";
  if (signals.working) return signals.stalled ? "stalled" : "working";
  if (signals.background) return "background";
  if (signals.unread) return "unread";
  if (signals.draft) return "draft";
  return "idle";
}

export function sessionStatusBucket(state: SessionDotState = "idle"): SessionStatusBucket {
  return state === "stalled" || state === "background" ? "working" : state;
}

const STATUS_BUCKET_RANK: Record<SessionStatusBucket, number> = {
  "needs-input": 0,
  working: 1,
  unread: 2,
  draft: 3,
  idle: 4,
};

export const SESSION_STATUS_BUCKETS: SessionStatusBucket[] = [
  "needs-input",
  "working",
  "unread",
  "draft",
  "idle",
];

export const SESSION_STATUS_BUCKET_LABELS: Record<SessionStatusBucket, string> = {
  "needs-input": "需处理",
  working: "进行中",
  unread: "未读",
  draft: "草稿",
  idle: "闲置",
};

export function sessionStatusRank(state?: SessionDotState): number {
  return STATUS_BUCKET_RANK[sessionStatusBucket(state)];
}

export type SidebarSortKey = "updated" | "created" | "status" | "tokens" | "cost";

export const SIDEBAR_SORT_LABELS: Record<SidebarSortKey, string> = {
  updated: "最近更新",
  created: "创建时间",
  status: "状态",
  tokens: "Token 用量",
  cost: "花费",
};

export const SIDEBAR_SORT_KEYS: SidebarSortKey[] = ["updated", "created", "status", "tokens", "cost"];

export type SidebarGrouping = "day" | "project" | "status" | "profile";

export const SIDEBAR_GROUPING_LABELS: Record<SidebarGrouping, string> = {
  day: "按天",
  project: "按项目",
  status: "按状态",
  profile: "按画像",
};

export const SIDEBAR_GROUPING_VALUES: SidebarGrouping[] = ["day", "project", "status", "profile"];

const SIDEBAR_SORT_KEY = "hermes.sidebar-sort";
const SIDEBAR_GROUPING_KEY = "hermes.sidebar-grouping";
const SIDEBAR_STATUS_FILTER_KEY = "hermes.sidebar-status-filter";
const UNREAD_SESSION_IDS_STORAGE_KEY = "hermes-cn-ui.unreadSessionIds";

export function readSidebarSort(): SidebarSortKey {
  const value = readJSON<unknown>(SIDEBAR_SORT_KEY, "updated");
  return SIDEBAR_SORT_KEYS.includes(value as SidebarSortKey) ? (value as SidebarSortKey) : "updated";
}

export function writeSidebarSort(key: SidebarSortKey): SidebarSortKey {
  const clean = SIDEBAR_SORT_KEYS.includes(key) ? key : "updated";
  writeJSON(SIDEBAR_SORT_KEY, clean);
  return clean;
}

export function readSidebarGrouping(): SidebarGrouping {
  const value = readJSON<unknown>(SIDEBAR_GROUPING_KEY, "day");
  return SIDEBAR_GROUPING_VALUES.includes(value as SidebarGrouping)
    ? (value as SidebarGrouping)
    : "day";
}

export function writeSidebarGrouping(grouping: SidebarGrouping): SidebarGrouping {
  const clean = SIDEBAR_GROUPING_VALUES.includes(grouping) ? grouping : "day";
  writeJSON(SIDEBAR_GROUPING_KEY, clean);
  return clean;
}

export function readSidebarStatusFilter(): SessionStatusBucket[] {
  const raw = readJSON<unknown>(SIDEBAR_STATUS_FILTER_KEY, []);
  if (!Array.isArray(raw)) return [];
  const seen = new Set<SessionStatusBucket>();
  for (const item of raw) {
    if (!SESSION_STATUS_BUCKETS.includes(item as SessionStatusBucket)) continue;
    seen.add(item as SessionStatusBucket);
  }
  return SESSION_STATUS_BUCKETS.filter((bucket) => seen.has(bucket));
}

export function writeSidebarStatusFilter(buckets: Iterable<SessionStatusBucket>): SessionStatusBucket[] {
  const wanted = new Set(Array.from(buckets));
  const clean = SESSION_STATUS_BUCKETS.filter((bucket) => wanted.has(bucket));
  writeJSON(SIDEBAR_STATUS_FILTER_KEY, clean);
  return clean;
}

export function toggleStatusFilterBucket(
  current: readonly SessionStatusBucket[],
  bucket: SessionStatusBucket,
): SessionStatusBucket[] {
  const next = new Set(current);
  if (next.has(bucket)) next.delete(bucket);
  else next.add(bucket);
  return writeSidebarStatusFilter(next);
}

export type UnreadOverride = "read" | "unread";
export type UnreadOverrides = Record<string, UnreadOverride>;

function normalizeOverrides(value: unknown): UnreadOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([sessionId, raw]) => {
      const id = sessionId.trim();
      if (!id) return [];
      if (raw === true || raw === "unread") return [[id, "unread" as UnreadOverride]];
      if (raw === false || raw === "read") return [[id, "read" as UnreadOverride]];
      return [];
    }),
  );
}

export function readUnreadOverrides(): UnreadOverrides {
  return normalizeOverrides(readJSON<unknown>(UNREAD_SESSION_IDS_STORAGE_KEY, {}));
}

export function writeUnreadOverrides(overrides: UnreadOverrides): UnreadOverrides {
  const clean = normalizeOverrides(overrides);
  writeJSON(UNREAD_SESSION_IDS_STORAGE_KEY, clean);
  return clean;
}

export function markSessionsReadLocally(ids: Iterable<string>): UnreadOverrides {
  const overrides = readUnreadOverrides();
  let changed = false;
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || overrides[id] === "read") continue;
    overrides[id] = "read";
    changed = true;
  }
  return changed ? writeUnreadOverrides(overrides) : overrides;
}

export function markSessionsUnreadLocally(ids: Iterable<string>): UnreadOverrides {
  const overrides = readUnreadOverrides();
  let changed = false;
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || overrides[id] === "unread") continue;
    overrides[id] = "unread";
    changed = true;
  }
  return changed ? writeUnreadOverrides(overrides) : overrides;
}

export function reconcileUnreadOverrides(
  overrides: UnreadOverrides,
  sessions: ReadonlyArray<{ id: string; unread?: boolean | null }>,
): UnreadOverrides {
  const next: UnreadOverrides = {};
  for (const [id, value] of Object.entries(overrides)) {
    const session = sessions.find((item) => item.id === id);
    if (!session) {
      next[id] = value;
      continue;
    }
    const serverUnread = session.unread === true;
    if (serverUnread === (value === "unread")) continue;
    next[id] = value;
  }
  return Object.keys(next).length === Object.keys(overrides).length ? overrides : next;
}

export function isSessionUnread(
  session: { id: string; unread?: boolean | null },
  overrides: UnreadOverrides,
): boolean {
  const override = overrides[session.id];
  if (override) return override === "unread";
  return session.unread === true;
}

export interface SortableSession {
  id: string;
  started_at: number;
  ended_at?: number | null;
  last_active?: number | null;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number | null;
  actual_cost_usd?: number | null;
}

export function sessionRecencySec(session: SortableSession): number {
  if (typeof session.last_active === "number" && Number.isFinite(session.last_active)) {
    return session.last_active;
  }
  return session.ended_at ?? session.started_at;
}

export function sessionCostUsd(session: SortableSession): number {
  const actual = session.actual_cost_usd;
  if (typeof actual === "number" && Number.isFinite(actual)) return actual;
  const estimated = session.estimated_cost_usd;
  return typeof estimated === "number" && Number.isFinite(estimated) ? estimated : 0;
}

export function sessionTokenTotal(session: SortableSession): number {
  return (session.input_tokens ?? 0) + (session.output_tokens ?? 0);
}

export function sidebarSortScore<T extends SortableSession>(
  key: SidebarSortKey,
  stateOf: (session: T) => SessionDotState | undefined,
): ((session: T) => number) | null {
  switch (key) {
    case "created":
      return (session) => -session.started_at;
    case "status":
      return (session) => sessionStatusRank(stateOf(session));
    case "tokens":
      return (session) => -sessionTokenTotal(session);
    case "cost":
      return (session) => -sessionCostUsd(session);
    default:
      return null;
  }
}

export function sortSessionsForSidebar<T extends SortableSession>(
  sessions: readonly T[],
  key: SidebarSortKey,
  stateOf: (session: T) => SessionDotState | undefined,
): T[] {
  const score = sidebarSortScore(key, stateOf);
  if (!score) return [...sessions];
  return [...sessions].sort((a, b) => {
    const delta = score(a) - score(b);
    if (delta !== 0 && Number.isFinite(delta)) return delta;
    return sessionRecencySec(b) - sessionRecencySec(a);
  });
}

export interface SidebarGroup<T> {
  key: string;
  label: string;
  items: T[];
}

export interface SidebarGroupContext<T> {
  now: Date;
  stateOf: (session: T) => SessionDotState;
  projectOf?: (session: T) => string | undefined;
  profileOf?: (session: T) => string | undefined;
}

const UNASSIGNED_PROJECT_LABEL = "未关联项目";
const UNKNOWN_PROFILE_LABEL = "未知画像";

function dayLabelFor(timestampSec: number, now: Date): string {
  const dayStart = new Date(timestampSec * 1000);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(dayStart, now)) return "今天";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(dayStart, yesterday)) return "昨天";
  return `${dayStart.getMonth() + 1}/${dayStart.getDate()}`;
}

export function groupSessionsForSidebar<T extends SortableSession>(
  sessions: readonly T[],
  grouping: SidebarGrouping,
  ctx: SidebarGroupContext<T>,
): SidebarGroup<T>[] {
  if (grouping === "day") {
    const order: Array<"today" | "yesterday" | "earlier"> = ["today", "yesterday", "earlier"];
    const buckets = new Map<"today" | "yesterday" | "earlier", T[]>(
      order.map((key) => [key, [] as T[]]),
    );
    const labels: Record<"today" | "yesterday" | "earlier", string> = {
      today: "今天",
      yesterday: "昨天",
      earlier: "更早",
    };
    for (const session of sessions) {
      const ts = sessionRecencySec(session);
      const date = new Date(ts * 1000);
      const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const todayStart = new Date(ctx.now.getFullYear(), ctx.now.getMonth(), ctx.now.getDate());
      const diffDays = Math.round((todayStart.getTime() - dayStart.getTime()) / 86_400_000);
      const key = diffDays <= 0 ? "today" : diffDays === 1 ? "yesterday" : "earlier";
      buckets.get(key)!.push(session);
    }
    return order.flatMap((key) => {
      const items = buckets.get(key)!;
      return items.length > 0 ? [{ key, label: labels[key], items }] : [];
    });
  }

  if (grouping === "status") {
    const buckets = new Map<SessionStatusBucket, T[]>(
      SESSION_STATUS_BUCKETS.map((bucket) => [bucket, [] as T[]]),
    );
    for (const session of sessions) {
      buckets.get(sessionStatusBucket(ctx.stateOf(session)))!.push(session);
    }
    return SESSION_STATUS_BUCKETS.flatMap((bucket) => {
      const items = buckets.get(bucket)!;
      return items.length > 0
        ? [{ key: bucket, label: SESSION_STATUS_BUCKET_LABELS[bucket], items }]
        : [];
    });
  }

  const keyOf = grouping === "project"
    ? (session: T) => (ctx.projectOf?.(session) ?? "").trim()
    : (session: T) => (ctx.profileOf?.(session) ?? "").trim();
  const fallback = grouping === "project" ? UNASSIGNED_PROJECT_LABEL : UNKNOWN_PROFILE_LABEL;

  const groups = new Map<string, T[]>();
  for (const session of sessions) {
    const key = keyOf(session) || fallback;
    const bucket = groups.get(key);
    if (bucket) bucket.push(session);
    else groups.set(key, [session]);
  }
  return Array.from(groups.entries())
    .map(([label, items]) => ({ key: `dim-${label}`, label, items }))
    .sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label, "zh-Hans-CN"));
}

export function filterSessionsByStatusBuckets<T>(
  sessions: readonly T[],
  buckets: readonly SessionStatusBucket[],
  stateOf: (session: T) => SessionDotState,
): T[] {
  if (buckets.length === 0) return [...sessions];
  const wanted = new Set(buckets);
  return sessions.filter((session) => wanted.has(sessionStatusBucket(stateOf(session))));
}

export { dayLabelFor };

