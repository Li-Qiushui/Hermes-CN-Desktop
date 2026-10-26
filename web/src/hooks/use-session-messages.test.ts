// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJSON } from "@/lib/transport";
import {
  SESSION_MESSAGES_PAGE_SIZE,
  fetchSessionMessagesPage,
  mergeEarlierMessages,
  sessionMessagesPath,
  sessionMessagesQueryKey,
  useSessionMessages,
} from "./use-session-messages";

vi.mock("@/lib/transport", () => ({
  fetchJSON: vi.fn(),
}));

vi.mock("@/hooks/use-profiles", () => ({
  useActiveProfileName: () => "default",
}));

const mockFetchJSON = fetchJSON as unknown as ReturnType<typeof vi.fn>;

function message(id: number, sessionId = "s1") {
  return {
    id,
    session_id: sessionId,
    role: "user",
    content: `m${id}`,
    timestamp: id * 1_000,
  };
}

function ids(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => from + index);
}

function rawPage(sessionId: string, range: number[], limit: number, offset: number) {
  return {
    session_id: sessionId,
    profile: "default",
    messages: range.map((id) => message(id, sessionId)),
    pagination: { limit, offset, order: "latest", returned: range.length },
  };
}

type Parser = { parse(value: unknown): unknown } | undefined;

function respond(handler: (path: string) => unknown) {
  mockFetchJSON.mockImplementation(async (path: string, _init: unknown, parser: Parser) => {
    const body = handler(path);
    return parser ? parser.parse(body) : body;
  });
}

function pageData(range: number[], limit: number, offset: number, sessionId = "s1") {
  return {
    session_id: sessionId,
    messages: range.map((id) => message(id, sessionId)),
    page_state: {
      pages: Math.max(1, Math.ceil((offset + range.length) / SESSION_MESSAGES_PAGE_SIZE)),
      reachedStart: range.length < limit,
    },
  };
}

function pageResult(range: number[], limit: number, offset: number, sessionId = "s1") {
  return {
    data: pageData(range, limit, offset, sessionId),
    returned: range.length,
    reachedStart: range.length < limit,
    fromSessionLog: false,
  };
}

beforeEach(() => {
  mockFetchJSON.mockReset();
});

describe("sessionMessagesPath", () => {
  it("拼出 limit/offset/order 三个分页参数并对 id 做 encode", () => {
    expect(sessionMessagesPath("s/1", SESSION_MESSAGES_PAGE_SIZE, 200, "latest")).toBe(
      "/api/sessions/s%2F1/messages?limit=100&offset=200&order=latest",
    );
  });

  it("分页状态进 queryKey，切会话换缓存条目", () => {
    expect(sessionMessagesQueryKey("default", "s1")).toEqual(["session-messages", "default", "s1"]);
    expect(sessionMessagesQueryKey("default", "s1")).not.toEqual(sessionMessagesQueryKey("default", "s2"));
    expect(sessionMessagesQueryKey("p2", "s1")).not.toEqual(sessionMessagesQueryKey("default", "s1"));
  });
});

describe("fetchSessionMessagesPage", () => {
  it("保留内核 pagination 并返回正序消息", async () => {
    respond(() => rawPage("s1", ids(101, 100), 100, 0));

    const page = await fetchSessionMessagesPage("s1");

    expect(mockFetchJSON.mock.calls[0]?.[0]).toBe(
      "/api/sessions/s1/messages?limit=100&offset=0&order=latest",
    );
    expect(page.returned).toBe(100);
    expect(page.reachedStart).toBe(false);
    expect(page.data.pagination).toEqual({ limit: 100, offset: 0, order: "latest", returned: 100 });
    expect(page.data.page_state).toEqual({ pages: 1, reachedStart: false });
    expect(page.data.messages.map((item) => item.id).slice(0, 3)).toEqual([101, 102, 103]);
    expect(page.data.messages.at(-1)?.id).toBe(200);
  });

  it("returned 少于 limit 时判定到底", async () => {
    respond(() => rawPage("s1", ids(1, 40), 100, 160));

    const page = await fetchSessionMessagesPage("s1", { offset: 160 });

    expect(page.returned).toBe(40);
    expect(page.reachedStart).toBe(true);
    expect(page.data.page_state).toEqual({ pages: 2, reachedStart: true });
  });

  it("不再向更早翻页失败时回退，直接抛错", async () => {
    mockFetchJSON.mockRejectedValue(new Error("HTTP 500: boom"));

    await expect(fetchSessionMessagesPage("s1", { offset: 100 })).rejects.toThrow("HTTP 500");
    expect(mockFetchJSON).toHaveBeenCalledTimes(1);
  });

  it("首页为空时回退会话日志并标记到底", async () => {
    respond((path) => {
      if (path.startsWith("/api/sessions/")) return rawPage("s1", [], 100, 0);
      return { session_id: "s1", messages: [message(1), message(2)] };
    });

    const page = await fetchSessionMessagesPage("s1");

    expect(page.fromSessionLog).toBe(true);
    expect(page.data.messages).toHaveLength(2);
    expect(page.reachedStart).toBe(true);
  });
});

describe("mergeEarlierMessages", () => {
  it("把更早一页前置并保持已有序项的引用", () => {
    const newest = pageResult(ids(101, 100), 100, 0);
    const earlier = pageResult(ids(1, 100), 100, 100);

    const merged = mergeEarlierMessages(newest.data, earlier);

    expect(merged.messages.map((item) => item.id)).toEqual(ids(1, 200));
    expect(merged.messages[100]).toBe(newest.data.messages[0]);
    expect(merged.messages[0]).toBe(earlier.data.messages[0]);
    expect(merged.page_state).toEqual({ pages: 2, reachedStart: false });
  });

  it("按 id 去重，重叠页不产生重复行", () => {
    const current = pageResult(ids(51, 100), 100, 0);
    const overlap = pageResult(ids(1, 100), 100, 100);

    const merged = mergeEarlierMessages(current.data, overlap);

    expect(merged.messages.map((item) => item.id)).toEqual(ids(1, 150));
    expect(new Set(merged.messages.map((item) => item.id)).size).toBe(150);
  });

  it("整页都是重复项时返回原对象，避免下游 memo 失效", () => {
    const current = pageResult(ids(101, 100), 100, 0);

    const merged = mergeEarlierMessages(current.data, pageResult(ids(101, 100), 100, 100));

    expect(merged).toBe(current.data);
  });
});

describe("useSessionMessages 分页", () => {
  function setup() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    return { client, wrapper };
  }

  it("首屏只取最新一页，loadEarlier 用 offset 向前翻并暴露 hasMore", async () => {
    respond((path) => {
      if (path.includes("offset=0")) return rawPage("s1", ids(121, 100), 100, 0);
      if (path.includes("offset=100")) return rawPage("s1", ids(21, 100), 100, 100);
      if (path.includes("offset=200")) return rawPage("s1", ids(1, 20), 100, 200);
      throw new Error(`unexpected ${path}`);
    });
    const { wrapper } = setup();

    const { result } = renderHook(() => useSessionMessages("s1"), { wrapper });
    await waitFor(() => expect(result.current.data?.messages).toHaveLength(100));

    expect(mockFetchJSON.mock.calls[0]?.[0]).toBe(
      "/api/sessions/s1/messages?limit=100&offset=0&order=latest",
    );
    expect(result.current.hasMore).toBe(true);
    expect(result.current.isLoadingEarlier).toBe(false);

    await act(async () => {
      await result.current.loadEarlier();
    });

    expect(mockFetchJSON.mock.calls[1]?.[0]).toBe(
      "/api/sessions/s1/messages?limit=100&offset=100&order=latest",
    );
    expect(result.current.data?.messages.map((item) => item.id)).toEqual(ids(21, 200));
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadEarlier();
    });

    expect(mockFetchJSON.mock.calls[2]?.[0]).toBe(
      "/api/sessions/s1/messages?limit=100&offset=200&order=latest",
    );
    expect(result.current.data?.messages.map((item) => item.id)).toEqual(ids(1, 220));
    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      await result.current.loadEarlier();
    });
    expect(mockFetchJSON).toHaveBeenCalledTimes(3);
  });

  it("重复页也能推进 offset，不会原地打转", async () => {
    respond((path) => {
      if (path.includes("offset=0")) return rawPage("s1", ids(101, 100), 100, 0);
      if (path.includes("offset=100")) return rawPage("s1", ids(101, 100), 100, 100);
      if (path.includes("offset=200")) return rawPage("s1", ids(1, 20), 100, 200);
      throw new Error(`unexpected ${path}`);
    });
    const { wrapper } = setup();

    const { result } = renderHook(() => useSessionMessages("s1"), { wrapper });
    await waitFor(() => expect(result.current.data?.messages).toHaveLength(100));

    await act(async () => {
      await result.current.loadEarlier();
    });

    expect(mockFetchJSON.mock.calls[1]?.[0]).toBe(
      "/api/sessions/s1/messages?limit=100&offset=100&order=latest",
    );
    expect(result.current.data?.messages).toHaveLength(100);
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadEarlier();
    });

    expect(mockFetchJSON.mock.calls[2]?.[0]).toBe(
      "/api/sessions/s1/messages?limit=100&offset=200&order=latest",
    );
  });

  it("短会话首屏即到底，hasMore 为 false", async () => {
    respond(() => rawPage("s1", ids(1, 42), 100, 0));
    const { wrapper } = setup();

    const { result } = renderHook(() => useSessionMessages("s1"), { wrapper });
    await waitFor(() => expect(result.current.data?.messages).toHaveLength(42));

    expect(result.current.hasMore).toBe(false);
  });

  it("切会话重置游标并重新从最新一页取", async () => {
    respond((path) => {
      if (path.includes("/s1/")) return path.includes("offset=100")
        ? rawPage("s1", ids(1, 100), 100, 100)
        : rawPage("s1", ids(101, 100), 100, 0);
      return rawPage("s2", ids(11, 30), 100, 0);
    });
    const { client, wrapper } = setup();

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useSessionMessages(id),
      { wrapper, initialProps: { id: "s1" } },
    );
    await waitFor(() => expect(result.current.data?.messages).toHaveLength(100));
    await act(async () => {
      await result.current.loadEarlier();
    });
    expect(result.current.data?.messages).toHaveLength(200);

    rerender({ id: "s2" });
    await waitFor(() => expect(result.current.data?.session_id).toBe("s2"));

    const s2Call = mockFetchJSON.mock.calls.map((call) => call[0]).filter((path: string) => path.includes("/s2/"));
    expect(s2Call).toEqual(["/api/sessions/s2/messages?limit=100&offset=0&order=latest"]);
    expect(result.current.data?.messages).toHaveLength(30);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.isLoadingEarlier).toBe(false);
    expect(
      (client.getQueryData(["session-messages", "default", "s1"]) as { messages: unknown[] }).messages,
    ).toHaveLength(200);
  });
});
