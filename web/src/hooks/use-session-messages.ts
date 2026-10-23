import { useCallback, useEffect, useRef, useState } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type UseQueryResult,
} from "@tanstack/react-query";
import { fetchJSON } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { MessagesResponse } from "@hermes/protocol";

export const SESSION_MESSAGES_PAGE_SIZE = 100;
export const SESSION_MESSAGES_MAX_PAGE_SIZE = 500;
export const SESSION_MESSAGES_STALE_TIME_MS = 30_000;

const SESSION_MESSAGES_QUERY_ROOT = "session-messages";

export type SessionMessagesOrder = "oldest" | "latest";

export interface SessionMessagesPagination {
  limit: number;
  offset: number;
  order: string;
  returned: number;
}

export interface SessionMessagesPageState {
  pages: number;
  reachedStart: boolean;
}

export type SessionMessagesData = MessagesResponse & {
  pagination?: SessionMessagesPagination;
  page_state?: SessionMessagesPageState;
};

export interface SessionMessagesPageResult {
  data: SessionMessagesData;
  returned: number;
  reachedStart: boolean;
  fromSessionLog: boolean;
}

export interface FetchSessionMessagesPageOptions {
  limit?: number;
  offset?: number;
  order?: SessionMessagesOrder;
  signal?: AbortSignal;
}

export function sessionMessagesQueryKey(profile: string, id: string | undefined): QueryKey {
  return [SESSION_MESSAGES_QUERY_ROOT, profile, id];
}

export function sessionMessagesPath(
  id: string,
  limit: number,
  offset: number,
  order: SessionMessagesOrder,
): string {
  return `/api/sessions/${encodeURIComponent(id)}/messages?limit=${limit}&offset=${offset}&order=${order}`;
}

function clampPageSize(limit: number): number {
  if (!Number.isFinite(limit)) return SESSION_MESSAGES_PAGE_SIZE;
  return Math.min(SESSION_MESSAGES_MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

function normalizeOffset(offset: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.floor(offset));
}

function readPagination(value: unknown): SessionMessagesPagination | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = (value as { pagination?: unknown }).pagination;
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const limit = typeof record.limit === "number" ? record.limit : undefined;
  const offset = typeof record.offset === "number" ? record.offset : undefined;
  const returned = typeof record.returned === "number" ? record.returned : undefined;
  if (limit === undefined || offset === undefined || returned === undefined) return undefined;
  return {
    limit,
    offset,
    order: typeof record.order === "string" ? record.order : "latest",
    returned,
  };
}

const sessionMessagesParser = {
  parse(value: unknown): SessionMessagesData {
    const base = MessagesResponse.parse(value);
    const pagination = readPagination(value);
    return pagination ? { ...base, pagination } : { ...base };
  },
};

function hasAnyMessages(result: MessagesResponse): boolean {
  return result.ui_messages ? result.ui_messages.length > 0 : result.messages.length > 0;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function fetchSessionLogMessages(
  id: string,
  signal?: AbortSignal,
): Promise<MessagesResponse | null> {
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

function pagesCovering(count: number): number {
  return Math.max(1, Math.ceil(count / SESSION_MESSAGES_PAGE_SIZE));
}

export async function fetchSessionMessagesPage(
  id: string,
  options: FetchSessionMessagesPageOptions = {},
): Promise<SessionMessagesPageResult> {
  const limit = clampPageSize(options.limit ?? SESSION_MESSAGES_PAGE_SIZE);
  const offset = normalizeOffset(options.offset ?? 0);
  const order = options.order ?? "latest";
  const signal = options.signal;

  let page: SessionMessagesData;
  try {
    page = await fetchJSON(sessionMessagesPath(id, limit, offset, order), { signal }, sessionMessagesParser);
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (offset > 0) throw error;
    const fallback = await fetchSessionLogMessages(id, signal);
    if (!fallback) throw error;
    return {
      data: {
        ...fallback,
        page_state: { pages: 1, reachedStart: true },
      },
      returned: fallback.messages.length,
      reachedStart: true,
      fromSessionLog: true,
    };
  }

  const returned = page.pagination?.returned ?? page.messages.length;
  if (returned === 0 && offset === 0) {
    const fallback = await fetchSessionLogMessages(id, signal);
    if (fallback) {
      return {
        data: {
          ...fallback,
          page_state: { pages: 1, reachedStart: true },
        },
        returned: fallback.messages.length,
        reachedStart: true,
        fromSessionLog: true,
      };
    }
  }

  const reachedStart = returned < limit;
  return {
    data: {
      ...page,
      page_state: { pages: pagesCovering(offset + returned), reachedStart },
    },
    returned,
    reachedStart,
    fromSessionLog: false,
  };
}

type Identified = { id?: string | number };

function mergeIdentified<T extends Identified>(current: readonly T[], incoming: readonly T[]): T[] {
  if (incoming.length === 0) return current as T[];
  const seen = new Set<string>();
  for (const item of current) seen.add(String(item.id));
  const added: T[] = [];
  for (const item of incoming) {
    const key = String(item.id);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(item);
  }
  if (added.length === 0) return current as T[];
  return [...added, ...current];
}

export function mergeEarlierMessages(
  previous: SessionMessagesData | undefined,
  page: SessionMessagesPageResult,
): SessionMessagesData {
  if (!previous) return page.data;
  const messages = mergeIdentified(previous.messages, page.data.messages);
  const uiMessages =
    previous.ui_messages === undefined && page.data.ui_messages === undefined
      ? undefined
      : mergeIdentified(previous.ui_messages ?? [], page.data.ui_messages ?? []);
  const reachedStart = page.reachedStart;
  const unchanged =
    messages.length === previous.messages.length &&
    (previous.page_state?.reachedStart ?? false) === reachedStart &&
    (previous.ui_messages?.length ?? -1) === (uiMessages?.length ?? -1);
  if (unchanged) return previous;
  return {
    ...previous,
    messages,
    ...(uiMessages === undefined ? {} : { ui_messages: uiMessages }),
    ...(page.data.pagination ? { pagination: page.data.pagination } : {}),
    page_state: {
      pages: Math.max(previous.page_state?.pages ?? 1, pagesCovering(messages.length)),
      reachedStart,
    },
  };
}

export type UseSessionMessagesResult = UseQueryResult<SessionMessagesData, Error> & {
  hasMore: boolean;
  isLoadingEarlier: boolean;
  loadEarlier: () => Promise<void>;
  loadEarlierError: Error | null;
};

export function useSessionMessages(id: string | undefined): UseSessionMessagesResult {
  const profile = useActiveProfileName();
  const qc = useQueryClient();
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  const [loadEarlierError, setLoadEarlierError] = useState<Error | null>(null);
  const inFlightRef = useRef(false);

  const query = useQuery<SessionMessagesData, Error>({
    queryKey: sessionMessagesQueryKey(profile, id),
    queryFn: ({ signal, client, queryKey }) => {
      const cached = client.getQueryData<SessionMessagesData>(queryKey);
      const wanted = pagesCovering(cached?.messages.length ?? 0) * SESSION_MESSAGES_PAGE_SIZE;
      const limit = clampPageSize(Math.max(SESSION_MESSAGES_PAGE_SIZE, wanted));
      return fetchSessionMessagesPage(id!, { limit, offset: 0, order: "latest", signal }).then(
        (page) => page.data,
      );
    },
    enabled: !!id,
    staleTime: SESSION_MESSAGES_STALE_TIME_MS,
  });

  useEffect(() => {
    inFlightRef.current = false;
    setIsLoadingEarlier(false);
    setLoadEarlierError(null);
  }, [id, profile]);

  const loadEarlier = useCallback(async () => {
    if (!id) return;
    if (inFlightRef.current) return;
    const key = sessionMessagesQueryKey(profile, id);
    const current = qc.getQueryData<SessionMessagesData>(key);
    if (!current || current.messages.length === 0) return;
    if (current.page_state?.reachedStart) return;

    inFlightRef.current = true;
    setIsLoadingEarlier(true);
    setLoadEarlierError(null);
    try {
      const page = await fetchSessionMessagesPage(id, {
        limit: SESSION_MESSAGES_PAGE_SIZE,
        offset: current.messages.length,
        order: "latest",
      });
      qc.setQueryData<SessionMessagesData>(key, (previous) =>
        previous ? mergeEarlierMessages(previous, page) : previous,
      );
    } catch (error) {
      if (!isAbortError(error)) {
        setLoadEarlierError(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      inFlightRef.current = false;
      setIsLoadingEarlier(false);
    }
  }, [id, profile, qc]);

  const data = query.data;
  const reachedStart = data
    ? data.page_state?.reachedStart ?? data.messages.length < SESSION_MESSAGES_PAGE_SIZE
    : true;
  const hasMore = !!id && !!data && data.messages.length > 0 && !reachedStart;

  return {
    ...query,
    hasMore,
    isLoadingEarlier,
    loadEarlier,
    loadEarlierError,
  };
}

export function prefetchSessionMessages(
  qc: QueryClient,
  profile: string,
  id: string | undefined,
): void {
  if (!id) return;
  void qc.prefetchQuery({
    queryKey: sessionMessagesQueryKey(profile, id),
    queryFn: ({ signal }) =>
      fetchSessionMessagesPage(id, { limit: SESSION_MESSAGES_PAGE_SIZE, signal }).then((page) => page.data),
    staleTime: SESSION_MESSAGES_STALE_TIME_MS,
  });
}
