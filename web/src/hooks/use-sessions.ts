import { useEffect, useState } from "react";
import {
  useQuery,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { fetchJSON, deleteJSON, patchJSON, postJSON } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { unpinSessions } from "@/lib/session-ui-state";
import { nextSessionPageOffset } from "@/lib/sidebar-session-lists";
import {
  MessagesResponse,
  MutationOkResponse,
  SearchResponse,
  SessionDetail,
  SessionsResponse,
  type SearchResult,
  type SessionSummary,
} from "@hermes/protocol";

export const DELETE_SESSION_CONCURRENCY = 3;
export const SESSIONS_API_PAGE_LIMIT = 100;

export interface DeleteSessionsFailure {
  id: string;
  error: string;
}

export interface DeleteSessionsResult {
  requestedIds: string[];
  succeededIds: string[];
  failed: DeleteSessionsFailure[];
  successCount: number;
  failureCount: number;
}

function hasAnyMessages(result: MessagesResponse): boolean {
  return result.ui_messages ? result.ui_messages.length > 0 : result.messages.length > 0;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function fetchSessionLogMessages(id: string, signal?: AbortSignal): Promise<MessagesResponse | null> {
  try {
    const result = await fetchJSON(
      `/__hermes_session_log/${encodeURIComponent(id)}`,
      { signal },
      MessagesResponse,
    );
    return hasAnyMessages(result) ? result : null;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }
}

export async function fetchSessionMessages(id: string, signal?: AbortSignal): Promise<MessagesResponse> {
  let result: MessagesResponse;
  try {
    result = await fetchJSON(
      `/api/sessions/${id}/messages`,
      { signal },
      MessagesResponse,
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    // 主端点 404（会话 id 形态与后端不一致 / 尚未落盘等）会让 fetchJSON 直接 throw，
    // 之前不会触发下面的会话日志兜底，导致历史整段丢失。先退回 /__hermes_session_log，
    // 拿不到再把原始错误抛给 React Query。
    const fallback = await fetchSessionLogMessages(id, signal);
    if (fallback) return fallback;
    throw error;
  }
  if (hasAnyMessages(result)) return result;
  return await fetchSessionLogMessages(id, signal) ?? result;
}

export type SessionListOrder = "created" | "recent";

export interface UseSessionsOptions {
  // When true, ask the Rust proxy to keep archived sessions (annotated with
  // `archived: true`) instead of stripping them. Defaults to false so the
  // sidebar and other callers keep the active-only list. See history page.
  includeArchived?: boolean;
  // Restrict the list to sessions whose stored cwd lives under this path.
  // Forwarded as `cwd_prefix`; the sidebar's per-workspace view uses it.
  cwdPrefix?: string;
  order?: SessionListOrder;
  enabled?: boolean;
}

interface FetchSessionsOptions extends UseSessionsOptions {
  signal?: AbortSignal;
}


/**
 * Machine-run session sources hidden from the workbench recents list, mirroring
 * the official Hermes Desktop sidebar (`SIDEBAR_EXCLUDED_SOURCES`): editor-driven
 * ACP rows, cron/kanban/oneshot/subagent/tool runs are not conversations. Filter
 * server-side so a burst of newest-first runs cannot starve real chats out of the
 * page (the kernel accepts `exclude_sources`).
 *
 * Messaging platforms (weixin/api_server/…) stay in the list: this shell has no
 * separate messaging section, unlike the official desktop.
 */
const RECENTS_EXCLUDED_SOURCES = ["acp", "cron", "kanban", "oneshot", "subagent", "tool"];

function sessionsPath(
  limit: number,
  offset: number,
  includeArchived: boolean,
  cwdPrefix?: string,
  order?: SessionListOrder,
): string {
  const excluded = RECENTS_EXCLUDED_SOURCES.map(encodeURIComponent).join(",");
  const prefix = cwdPrefix?.trim()
    ? `&cwd_prefix=${encodeURIComponent(cwdPrefix.trim())}`
    : "";
  const orderParam = order ? `&order=${order}` : "";
  return `/api/sessions?limit=${limit}&offset=${offset}${includeArchived ? "&include_archived=true" : ""}${prefix}${orderParam}&exclude_sources=${excluded}`;
}

function normalizePageNumber(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

export async function fetchSessionsList(
  limit = 50,
  offset = 0,
  opts: FetchSessionsOptions = {},
): Promise<SessionsResponse> {
  const requestedLimit = normalizePageNumber(limit, 50);
  const requestedOffset = normalizePageNumber(offset, 0);
  const includeArchived = opts.includeArchived ?? false;
  const cwdPrefix = opts.cwdPrefix?.trim() || undefined;
  const order = opts.order;

  const firstLimit = Math.min(requestedLimit, SESSIONS_API_PAGE_LIMIT);
  const first = await fetchJSON(
    sessionsPath(firstLimit, requestedOffset, includeArchived, cwdPrefix, order),
    { signal: opts.signal },
    SessionsResponse,
  );

  if (requestedLimit <= SESSIONS_API_PAGE_LIMIT) return first;

  const sessions = [...first.sessions];
  let total = first.total;
  let nextOffset = requestedOffset + sessions.length;
  let remaining = Math.min(
    requestedLimit - sessions.length,
    Math.max(0, total - nextOffset),
  );

  while (remaining > 0) {
    const pageLimit = Math.min(remaining, SESSIONS_API_PAGE_LIMIT);
    const page = await fetchJSON(
      sessionsPath(pageLimit, nextOffset, includeArchived, cwdPrefix, order),
      { signal: opts.signal },
      SessionsResponse,
    );
    total = page.total;
    if (page.sessions.length === 0) break;
    sessions.push(...page.sessions);
    nextOffset += page.sessions.length;
    remaining = Math.min(
      requestedLimit - sessions.length,
      Math.max(0, total - nextOffset),
    );
  }

  return {
    ...first,
    sessions,
    total,
    limit: requestedLimit,
    offset: requestedOffset,
  };
}

export function useSessions(limit = 50, offset = 0, opts: UseSessionsOptions = {}) {
  const profile = useActiveProfileName();
  const includeArchived = opts.includeArchived ?? false;
  const cwdPrefix = opts.cwdPrefix?.trim() ?? "";
  const order = opts.order ?? "created";
  return useQuery<SessionsResponse>({
    queryKey: [
      "sessions",
      profile,
      limit,
      offset,
      includeArchived ? "all" : "active",
      cwdPrefix,
      order,
    ],
    queryFn: ({ signal }) =>
      fetchSessionsList(limit, offset, {
        includeArchived,
        cwdPrefix: cwdPrefix || undefined,
        order: opts.order,
        signal,
      }),
    enabled: opts.enabled ?? true,
  });
}

/**
 * Offset-paged variant backing the sidebar's "加载更多". Each page is a real
 * `limit=&offset=` request (page 1 → offset 0, page 2 → offset 20, …); pages
 * are deduped by id because new sessions arriving at the head of the list
 * shift the window between requests.
 */
export function usePagedSessions(pageSize = 20, opts: UseSessionsOptions = {}) {
  const profile = useActiveProfileName();
  const includeArchived = opts.includeArchived ?? false;
  const cwdPrefix = opts.cwdPrefix?.trim() ?? "";
  const order = opts.order ?? "";
  return useInfiniteQuery({
    queryKey: [
      "sessions",
      "paged",
      profile,
      pageSize,
      includeArchived ? "all" : "active",
      cwdPrefix,
      order,
    ],
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      fetchSessionsList(pageSize, normalizePageNumber(Number(pageParam), 0), {
        includeArchived,
        cwdPrefix: cwdPrefix || undefined,
        order: opts.order,
        signal,
      }),
    getNextPageParam: (_lastPage, allPages) => nextSessionPageOffset(allPages) ?? undefined,
    enabled: opts.enabled ?? true,
  });
}

export function useSession(id: string | undefined) {
  const profile = useActiveProfileName();
  return useQuery<SessionDetail>({
    queryKey: ["session", profile, id],
    queryFn: ({ signal }) => fetchJSON(`/api/sessions/${id}`, { signal }, SessionDetail),
    enabled: !!id,
  });
}

export {
  SESSION_MESSAGES_MAX_PAGE_SIZE,
  SESSION_MESSAGES_PAGE_SIZE,
  SESSION_MESSAGES_STALE_TIME_MS,
  fetchSessionMessagesPage,
  mergeEarlierMessages,
  prefetchSessionMessages,
  sessionMessagesPath,
  sessionMessagesQueryKey,
  useSessionMessages,
  type FetchSessionMessagesPageOptions,
  type SessionMessagesData,
  type SessionMessagesPageResult,
  type SessionMessagesPageState,
  type SessionMessagesPagination,
  type UseSessionMessagesResult,
} from "@/hooks/use-session-messages";

export const SESSION_SEARCH_DEBOUNCE_MS = 250;
export const SESSION_SEARCH_MIN_CHARS = 2;
export const SESSION_SEARCH_LIMIT = 20;

export function useDebouncedValue<T>(value: T, delayMs = SESSION_SEARCH_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (delayMs <= 0) {
      setDebounced(value);
      return;
    }
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

export function stripSearchHighlight(snippet: string | null | undefined): string {
  if (typeof snippet !== "string") return "";
  return snippet
    .replace(/(>>>|<<<)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sessionSearchPath(query: string, limit = SESSION_SEARCH_LIMIT): string {
  return `/api/sessions/search?q=${encodeURIComponent(query)}&limit=${limit}`;
}

export interface SessionSearchOptions {
  enabled?: boolean;
  limit?: number;
}

export function useSessionSearch(q: string, opts: SessionSearchOptions = {}) {
  const profile = useActiveProfileName();
  const limit = opts.limit ?? SESSION_SEARCH_LIMIT;
  const trimmed = q.trim();
  const debounced = useDebouncedValue(trimmed, SESSION_SEARCH_DEBOUNCE_MS);
  const enabled = (opts.enabled ?? true) && debounced.length >= SESSION_SEARCH_MIN_CHARS;
  const query = useQuery<{ results: SearchResult[] }>({
    queryKey: ["sessions-search", profile, debounced, limit],
    queryFn: ({ signal }) => fetchJSON(sessionSearchPath(debounced, limit), { signal }, SearchResponse),
    enabled,
    staleTime: 10_000,
    placeholderData: (previous) => previous,
  });
  return {
    ...query,
    debouncedQuery: debounced,
    results: enabled ? query.data?.results ?? [] : [],
    searchPending: enabled && query.isFetching,
  };
}

export function searchResultsToSummaries(results: readonly SearchResult[]): SessionSummary[] {
  return results.map((result) => ({
    id: result.session_id,
    model: result.model ?? "",
    title: result.title ?? null,
    preview: stripSearchHighlight(result.snippet),
    source: result.source ?? undefined,
    started_at: result.session_started ?? result.last_active ?? 0,
    ended_at: null,
    last_active: result.last_active ?? null,
    message_count: result.message_count ?? 0,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: null,
    is_active: result.is_active,
    archived: result.archived,
  }));
}


function normalizeSessionIds(ids: Iterable<string>): string[] {
  const seen = new Set<string>();
  return Array.from(ids).flatMap((raw) => {
    const id = raw.trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [id];
  });
}

/**
 * 内核 >= 0.22.3 的会话写操作要带乐观锁：owner 拒绝没有 request_id / revision 的
 * 写（409 client_upgrade_required），桌面上的表现就是「点删除没反应」。
 * revision 现读现用，读详情和删除之间被别的客户端改过就 409 revision 冲突，重试一次即可。
 */
function newMutationRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function deleteSessionRequest(id: string): Promise<void> {
  await deleteSessionWithFence(id, true);
}

async function deleteSessionWithFence(id: string, allowRetry: boolean): Promise<void> {
  const path = `/api/sessions/${encodeURIComponent(id)}`;
  let detail: SessionDetail | null = null;
  try {
    detail = await fetchJSON(path, undefined, SessionDetail);
  } catch (error) {
    // 会话已经不在了（比如另一个客户端先删了）：按幂等成功处理，别把幽灵行塞回侧栏。
    if (error instanceof Error && error.message.startsWith("HTTP 404")) return;
    throw error;
  }
  const params = new URLSearchParams({
    request_id: newMutationRequestId(),
    expected_revision: String(detail.runtime_revision ?? 0),
  });
  if (detail.runtime_generation !== null && detail.runtime_generation !== undefined) {
    params.set("expected_generation", String(detail.runtime_generation));
  }
  try {
    await deleteJSON(`${path}?${params.toString()}`, undefined, MutationOkResponse);
  } catch (error) {
    // 读详情到删除之间会话又被写过（另一个客户端/正在跑的回合），revision 对不上：
    // 重读一次水位再发一遍；第二次还冲突就把后端原文抛给弹窗。
    const message = error instanceof Error ? error.message : String(error);
    if (allowRetry && message.startsWith("HTTP 409") && !message.includes("client_upgrade_required")) {
      await deleteSessionWithFence(id, false);
      return;
    }
    throw error;
  }
}

export async function deleteSessionsInBatches(
  ids: Iterable<string>,
  deleteOne: (id: string) => Promise<void> = deleteSessionRequest,
  concurrency = DELETE_SESSION_CONCURRENCY,
): Promise<DeleteSessionsResult> {
  const requestedIds = normalizeSessionIds(ids);
  const succeededIds: string[] = [];
  const failed: DeleteSessionsFailure[] = [];
  const workers = Math.max(1, Math.floor(concurrency));
  let cursor = 0;

  async function runWorker(): Promise<void> {
    while (cursor < requestedIds.length) {
      const id = requestedIds[cursor];
      cursor += 1;
      try {
        await deleteOne(id);
        succeededIds.push(id);
      } catch (error) {
        failed.push({
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(workers, requestedIds.length) }, () => runWorker()),
  );
  const succeededSet = new Set(succeededIds);
  const failedById = new Map(failed.map((item) => [item.id, item]));
  const orderedSucceededIds = requestedIds.filter((id) => succeededSet.has(id));
  const orderedFailed = requestedIds.flatMap((id) => {
    const item = failedById.get(id);
    return item ? [item] : [];
  });

  return {
    requestedIds,
    succeededIds: orderedSucceededIds,
    failed: orderedFailed,
    successCount: orderedSucceededIds.length,
    failureCount: orderedFailed.length,
  };
}

export type SessionsInfiniteData = InfiniteData<SessionsResponse>;

// 侧栏列表用 useInfiniteQuery 缓存成 { pages, pageParams }，不是 SessionsResponse。
// 删除、归档都以 ["sessions"] 前缀扫全部缓存，形状没判就直接取 .sessions 会抛 TypeError。
export function isInfiniteSessionsData(value: unknown): value is SessionsInfiniteData {
  return !!value && typeof value === "object" && Array.isArray((value as { pages?: unknown }).pages);
}

export function withoutSessions(
  sessions: SessionsResponse | undefined,
  ids: Iterable<string>,
): SessionsResponse | undefined {
  if (!sessions || !Array.isArray(sessions.sessions)) return sessions;
  const idSet = new Set(normalizeSessionIds(ids));
  if (idSet.size === 0) return sessions;
  const nextSessions = sessions.sessions.filter((session) => !idSet.has(session.id));
  if (nextSessions.length === sessions.sessions.length) return sessions;
  return {
    ...sessions,
    sessions: nextSessions,
    total: Math.max(0, sessions.total - (sessions.sessions.length - nextSessions.length)),
  };
}

export function withoutSearchResults(
  results: { results: SearchResult[] } | undefined,
  ids: Iterable<string>,
): { results: SearchResult[] } | undefined {
  if (!results || !Array.isArray(results.results)) return results;
  const idSet = new Set(normalizeSessionIds(ids));
  if (idSet.size === 0) return results;
  const nextResults = results.results.filter((result) => !idSet.has(result.session_id));
  return nextResults.length === results.results.length ? results : { ...results, results: nextResults };
}

/** 分页缓存（useInfiniteQuery）里逐页删掉同样有效的行，返回新对象只有在真删掉时才换引用。 */
export function withoutSessionsInPages(
  data: SessionsInfiniteData | undefined,
  ids: Iterable<string>,
): SessionsInfiniteData | undefined {
  if (!data) return data;
  const idSet = new Set(normalizeSessionIds(ids));
  if (idSet.size === 0) return data;
  let changed = false;
  const pages = data.pages.map((page) => {
    const next = withoutSessions(page, idSet);
    if (next !== page) changed = true;
    return next ?? page;
  });
  return changed ? { ...data, pages } : data;
}

export function removeDeletedSessionsFromCache(qc: QueryClient, ids: Iterable<string>): void {
  const cleanIds = normalizeSessionIds(ids);
  if (cleanIds.length === 0) return;
  qc.setQueriesData<SessionsResponse | SessionsInfiniteData>({ queryKey: ["sessions"] }, (data) =>
    isInfiniteSessionsData(data) ? withoutSessionsInPages(data, cleanIds) : withoutSessions(data, cleanIds),
  );
  qc.setQueriesData<{ results: SearchResult[] }>({ queryKey: ["sessions-search"] }, (data) =>
    withoutSearchResults(data, cleanIds),
  );
}

function invalidateSessionLists(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: ["sessions"] });
  void qc.invalidateQueries({ queryKey: ["sessions-search"] });
}

export function useDeleteSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const cleanId = id.trim();
      if (!cleanId) throw new Error("缺少会话 ID");
      await deleteSessionRequest(cleanId);
      return cleanId;
    },
    onSuccess: (id) => {
      unpinSessions([id]);
      removeDeletedSessionsFromCache(qc, [id]);
    },
    onSettled: () => {
      invalidateSessionLists(qc);
    },
  });
}

export function useDeleteSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: Iterable<string>) => deleteSessionsInBatches(ids),
    onSuccess: (result) => {
      if (result.succeededIds.length > 0) {
        unpinSessions(result.succeededIds);
        removeDeletedSessionsFromCache(qc, result.succeededIds);
      }
    },
    onSettled: () => {
      invalidateSessionLists(qc);
    },
  });
}

export function useArchiveSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      postJSON(`/api/sessions/${encodeURIComponent(id)}/archive`, {}, MutationOkResponse),
    onMutate: async (id) => {
      await Promise.all([
        qc.cancelQueries({ queryKey: ["sessions"] }),
        qc.cancelQueries({ queryKey: ["sessions-search"] }),
      ]);
      const sessionSnapshots = qc.getQueriesData<SessionsResponse>({ queryKey: ["sessions"] });
      const searchSnapshots = qc.getQueriesData<{ results: SearchResult[] }>({
        queryKey: ["sessions-search"],
      });

      qc.setQueriesData<SessionsResponse>({ queryKey: ["sessions"] }, (data) =>
        withoutSessions(data, [id]),
      );
      qc.setQueriesData<{ results: SearchResult[] }>({ queryKey: ["sessions-search"] }, (data) =>
        withoutSearchResults(data, [id]),
      );

      return { sessionSnapshots, searchSnapshots };
    },
    onSuccess: (_result, id) => {
      unpinSessions([id]);
    },
    onError: (_error, _id, context) => {
      for (const [queryKey, data] of context?.sessionSnapshots ?? []) {
        qc.setQueryData(queryKey, data);
      }
      for (const [queryKey, data] of context?.searchSnapshots ?? []) {
        qc.setQueryData(queryKey, data);
      }
    },
    onSettled: () => {
      invalidateSessionLists(qc);
    },
  });
}

// Inverse of useArchiveSession: DELETE /api/sessions/{id}/archive un-archives a
// session (see handle_archive_request DELETE branch). The mutation optimistically
// drops the row from the archived view; onSettled re-fetches so it reappears in
// the active list. The caller is on the archived scope, so the brief removal is
// only ever observed where the row should disappear.
export function useUnarchiveSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      deleteJSON(`/api/sessions/${encodeURIComponent(id)}/archive`, undefined, MutationOkResponse),
    onMutate: async (id) => {
      await Promise.all([
        qc.cancelQueries({ queryKey: ["sessions"] }),
        qc.cancelQueries({ queryKey: ["sessions-search"] }),
      ]);
      const sessionSnapshots = qc.getQueriesData<SessionsResponse>({ queryKey: ["sessions"] });
      const searchSnapshots = qc.getQueriesData<{ results: SearchResult[] }>({
        queryKey: ["sessions-search"],
      });

      qc.setQueriesData<SessionsResponse>({ queryKey: ["sessions"] }, (data) =>
        withoutSessions(data, [id]),
      );
      qc.setQueriesData<{ results: SearchResult[] }>({ queryKey: ["sessions-search"] }, (data) =>
        withoutSearchResults(data, [id]),
      );

      return { sessionSnapshots, searchSnapshots };
    },
    onError: (_error, _id, context) => {
      for (const [queryKey, data] of context?.sessionSnapshots ?? []) {
        qc.setQueryData(queryKey, data);
      }
      for (const [queryKey, data] of context?.searchSnapshots ?? []) {
        qc.setQueryData(queryKey, data);
      }
    },
    onSettled: () => {
      invalidateSessionLists(qc);
    },
  });
}

export interface SessionFlagsPatch {
  unread?: boolean;
  pinned?: boolean;
}

export interface SessionFlagsTarget extends SessionFlagsPatch {
  ids: string[];
}

async function patchSessionFlagsOnce(
  id: string,
  flags: SessionFlagsPatch,
  allowRetry = true,
): Promise<void> {
  const path = `/api/sessions/${encodeURIComponent(id)}`;
  const detail = await fetchJSON(path, undefined, SessionDetail);
  const body: Record<string, unknown> = {
    request_id: newMutationRequestId(),
    expected_revision: detail.runtime_revision ?? 0,
    ...flags,
  };
  if (detail.runtime_generation !== null && detail.runtime_generation !== undefined) {
    body.expected_generation = detail.runtime_generation;
  }
  try {
    await patchJSON(path, body, MutationOkResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (allowRetry && message.startsWith("HTTP 409") && !message.includes("client_upgrade_required")) {
      await patchSessionFlagsOnce(id, flags, false);
      return;
    }
    throw error;
  }
}

export async function patchSessionFlags(
  ids: Iterable<string>,
  flags: SessionFlagsPatch,
  concurrency = DELETE_SESSION_CONCURRENCY,
): Promise<{ succeededIds: string[]; failed: DeleteSessionsFailure[] }> {
  const targets = normalizeSessionIds(ids);
  const succeededIds: string[] = [];
  const failed: DeleteSessionsFailure[] = [];
  const workers = Math.max(1, Math.floor(concurrency));
  let cursor = 0;

  async function runWorker(): Promise<void> {
    while (cursor < targets.length) {
      const id = targets[cursor];
      cursor += 1;
      try {
        await patchSessionFlagsOnce(id, flags);
        succeededIds.push(id);
      } catch (error) {
        failed.push({ id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(workers, targets.length) }, () => runWorker()),
  );
  const succeededSet = new Set(succeededIds);
  return {
    succeededIds: targets.filter((id) => succeededSet.has(id)),
    failed: targets.flatMap((id) => {
      const item = failed.find((entry) => entry.id === id);
      return item ? [item] : [];
    }),
  };
}

export function useSetSessionFlags() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, ...flags }: SessionFlagsTarget) => patchSessionFlags(ids, flags),
    onSuccess: (result, variables) => {
      if (variables.pinned === false && result.succeededIds.length > 0) {
        unpinSessions(result.succeededIds);
      }
      qc.setQueriesData<SessionsResponse>({ queryKey: ["sessions"] }, (data) => {
        if (!data || !Array.isArray(data.sessions)) return data;
        const targets = new Set(result.succeededIds);
        if (targets.size === 0) return data;
        const sessions = data.sessions.map((session) =>
          targets.has(session.id)
            ? {
                ...session,
                ...(variables.unread === undefined ? {} : { unread: variables.unread }),
                ...(variables.pinned === undefined ? {} : { pinned: variables.pinned }),
              }
            : session,
        );
        return { ...data, sessions };
      });
    },
    onSettled: () => {
      invalidateSessionLists(qc);
    },
  });
}
