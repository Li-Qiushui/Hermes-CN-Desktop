// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagesResponse, SearchResult, SessionsResponse, SessionSummary } from "@hermes/protocol";
import { deleteJSON, fetchJSON, patchJSON } from "@/lib/transport";
import {
  SESSION_SEARCH_LIMIT,
  deleteSessionsInBatches,
  fetchSessionsList,
  fetchSessionMessages,
  patchSessionFlags,
  sessionSearchPath,
  searchResultsToSummaries,
  stripSearchHighlight,
  useSessionSearch,
  withoutSearchResults,
  withoutSessions,
} from "./use-sessions";

vi.mock("@/lib/transport", () => ({
  fetchJSON: vi.fn(),
  deleteJSON: vi.fn(),
  postJSON: vi.fn(),
  patchJSON: vi.fn(),
}));

vi.mock("@/hooks/use-profiles", () => ({
  useActiveProfileName: () => "default",
}));

const mockFetchJSON = fetchJSON as unknown as ReturnType<typeof vi.fn>;
const mockDeleteJSON = deleteJSON as unknown as ReturnType<typeof vi.fn>;
const mockPatchJSON = patchJSON as unknown as ReturnType<typeof vi.fn>;

function session(id: string): SessionSummary {
  return {
    id,
    model: "model",
    title: id,
    started_at: 1,
    ended_at: 2,
    message_count: 1,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: null,
  };
}

function sessionsResponse(ids: string[]): SessionsResponse {
  return {
    sessions: ids.map(session),
    total: ids.length,
    limit: 50,
    offset: 0,
  };
}

function sessionsPage(ids: string[], total: number, limit: number, offset: number): SessionsResponse {
  return {
    sessions: ids.map(session),
    total,
    limit,
    offset,
  };
}

function searchResult(id: string): SearchResult {
  return {
    session_id: id,
    snippet: id,
  };
}

describe("session cache delete helpers", () => {
  it("removes several sessions and updates total", () => {
    const result = withoutSessions(sessionsResponse(["s1", "s2", "s3"]), ["s1", "s3"]);

    expect(result?.sessions.map((item) => item.id)).toEqual(["s2"]);
    expect(result?.total).toBe(1);
  });

  it("removes matching search results", () => {
    const result = withoutSearchResults(
      { results: ["s1", "s2", "s3"].map(searchResult) },
      ["s2", "missing"],
    );

    expect(result?.results.map((item) => item.session_id)).toEqual(["s1", "s3"]);
  });
});

describe("deleteSessionsInBatches", () => {
  it("deduplicates ids and reports successful deletes", async () => {
    const deleteOne = vi.fn().mockResolvedValue(undefined);

    const result = await deleteSessionsInBatches(["s1", "s2", "s1", " "], deleteOne, 2);

    expect(deleteOne).toHaveBeenCalledTimes(2);
    expect(result.requestedIds).toEqual(["s1", "s2"]);
    expect(result.succeededIds).toEqual(["s1", "s2"]);
    expect(result.failed).toEqual([]);
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);
  });

  it("keeps partial failures visible to callers", async () => {
    const deleteOne = vi.fn(async (id: string) => {
      if (id === "s2") throw new Error("boom");
    });

    const result = await deleteSessionsInBatches(["s1", "s2", "s3"], deleteOne, 3);

    expect(result.succeededIds).toEqual(["s1", "s3"]);
    expect(result.failed).toEqual([{ id: "s2", error: "boom" }]);
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(1);
  });
});

describe("fetchSessionsList", () => {
  beforeEach(() => {
    mockFetchJSON.mockReset();
  });

  it("keeps requests within the Core page-size cap", async () => {
    mockFetchJSON.mockImplementation(async (path: string) => {
      if (path === "/api/sessions?limit=100&offset=0&include_archived=true&exclude_sources=acp,cron,kanban,oneshot,subagent,tool") {
        return sessionsPage(Array.from({ length: 100 }, (_, i) => `s${i}`), 150, 100, 0);
      }
      if (path === "/api/sessions?limit=50&offset=100&include_archived=true&exclude_sources=acp,cron,kanban,oneshot,subagent,tool") {
        return sessionsPage(Array.from({ length: 50 }, (_, i) => `s${i + 100}`), 150, 50, 100);
      }
      throw new Error(`unexpected ${path}`);
    });

    const result = await fetchSessionsList(200, 0, { includeArchived: true });

    expect(result.sessions).toHaveLength(150);
    expect(result.sessions[0]?.id).toBe("s0");
    expect(result.sessions[149]?.id).toBe("s149");
    expect(result.total).toBe(150);
    expect(result.limit).toBe(200);
    expect(result.offset).toBe(0);
    expect(mockFetchJSON.mock.calls.map((call) => call[0])).toEqual([
      "/api/sessions?limit=100&offset=0&include_archived=true&exclude_sources=acp,cron,kanban,oneshot,subagent,tool",
      "/api/sessions?limit=50&offset=100&include_archived=true&exclude_sources=acp,cron,kanban,oneshot,subagent,tool",
    ]);
  });

  it("preserves requested offset when aggregating multiple pages", async () => {
    mockFetchJSON.mockImplementation(async (path: string) => {
      if (path === "/api/sessions?limit=100&offset=20&exclude_sources=acp,cron,kanban,oneshot,subagent,tool") {
        return sessionsPage(Array.from({ length: 100 }, (_, i) => `s${i + 20}`), 300, 100, 20);
      }
      if (path === "/api/sessions?limit=50&offset=120&exclude_sources=acp,cron,kanban,oneshot,subagent,tool") {
        return sessionsPage(Array.from({ length: 50 }, (_, i) => `s${i + 120}`), 300, 50, 120);
      }
      throw new Error(`unexpected ${path}`);
    });

    const result = await fetchSessionsList(150, 20);

    expect(result.sessions).toHaveLength(150);
    expect(result.sessions[0]?.id).toBe("s20");
    expect(result.sessions[149]?.id).toBe("s169");
    expect(result.total).toBe(300);
    expect(result.limit).toBe(150);
    expect(result.offset).toBe(20);
  });

  it("uses a single request when the requested limit fits the backend cap", async () => {
    mockFetchJSON.mockResolvedValue(sessionsPage(["s1", "s2"], 2, 50, 0));

    const result = await fetchSessionsList(50, 0);

    expect(result.sessions.map((item) => item.id)).toEqual(["s1", "s2"]);
    expect(mockFetchJSON.mock.calls.map((call) => call[0])).toEqual([
      "/api/sessions?limit=50&offset=0&exclude_sources=acp,cron,kanban,oneshot,subagent,tool",
    ]);
  });

  it("forwards cwd_prefix for the workspace view", async () => {
    mockFetchJSON.mockResolvedValue(sessionsPage(["s1"], 1, 20, 0));

    await fetchSessionsList(20, 0, { cwdPrefix: "D:/Project/枢纽" });

    expect(mockFetchJSON.mock.calls.map((call) => call[0])).toEqual([
      `/api/sessions?limit=20&offset=0&cwd_prefix=${encodeURIComponent("D:/Project/枢纽")}&exclude_sources=acp,cron,kanban,oneshot,subagent,tool`,
    ]);
  });

  it("keeps cwd_prefix on every aggregated page", async () => {
    mockFetchJSON.mockImplementation(async (path: string) => {
      if (path.includes("offset=0")) {
        return sessionsPage(Array.from({ length: 100 }, (_, i) => `s${i}`), 130, 100, 0);
      }
      return sessionsPage(Array.from({ length: 30 }, (_, i) => `s${i + 100}`), 130, 30, 100);
    });

    const result = await fetchSessionsList(130, 0, { cwdPrefix: "D:/Project/a" });

    expect(result.sessions).toHaveLength(130);
    expect(mockFetchJSON.mock.calls.map((call) => call[0])).toEqual([
      `/api/sessions?limit=100&offset=0&cwd_prefix=${encodeURIComponent("D:/Project/a")}&exclude_sources=acp,cron,kanban,oneshot,subagent,tool`,
      `/api/sessions?limit=30&offset=100&cwd_prefix=${encodeURIComponent("D:/Project/a")}&exclude_sources=acp,cron,kanban,oneshot,subagent,tool`,
    ]);
  });

  it("omits cwd_prefix when the prefix is blank", async () => {
    mockFetchJSON.mockResolvedValue(sessionsPage(["s1"], 1, 20, 0));

    await fetchSessionsList(20, 0, { cwdPrefix: "   " });

    expect(mockFetchJSON.mock.calls.map((call) => call[0])).toEqual([
      "/api/sessions?limit=20&offset=0&exclude_sources=acp,cron,kanban,oneshot,subagent,tool",
    ]);
  });

  it("forwards order=recent so buckets follow latest activity", async () => {
    mockFetchJSON.mockResolvedValue(sessionsPage(["s1"], 1, 20, 0));

    await fetchSessionsList(20, 0, { order: "recent" });

    expect(mockFetchJSON.mock.calls.map((call) => call[0])).toEqual([
      "/api/sessions?limit=20&offset=0&order=recent&exclude_sources=acp,cron,kanban,oneshot,subagent,tool",
    ]);
  });

  it("keeps order=recent on every aggregated page", async () => {
    mockFetchJSON.mockImplementation(async (path: string) => {
      if (path.includes("offset=0")) {
        return sessionsPage(Array.from({ length: 100 }, (_, i) => `s${i}`), 130, 100, 0);
      }
      return sessionsPage(Array.from({ length: 30 }, (_, i) => `s${i + 100}`), 130, 30, 100);
    });

    await fetchSessionsList(130, 0, { order: "recent" });

    expect(mockFetchJSON.mock.calls.map((call) => call[0])).toEqual([
      "/api/sessions?limit=100&offset=0&order=recent&exclude_sources=acp,cron,kanban,oneshot,subagent,tool",
      "/api/sessions?limit=30&offset=100&order=recent&exclude_sources=acp,cron,kanban,oneshot,subagent,tool",
    ]);
  });

  it("keeps the kernel default ordering when order is not requested", async () => {
    mockFetchJSON.mockResolvedValue(sessionsPage(["s1"], 1, 20, 0));

    await fetchSessionsList(20, 0);

    expect(mockFetchJSON.mock.calls[0]?.[0]).not.toContain("order=");
  });
});

describe("fetchSessionMessages 历史回退", () => {
  const primary = (id: string) => `/api/sessions/${id}/messages`;
  const sessionLog = (id: string) => `/__hermes_session_log/${encodeURIComponent(id)}`;

  function withMessages(id: string, count: number): MessagesResponse {
    return {
      session_id: id,
      messages: Array.from({ length: count }, () => ({})),
    } as unknown as MessagesResponse;
  }

  beforeEach(() => {
    mockFetchJSON.mockReset();
  });

  it("主端点 404 时回退到会话日志读取，历史不丢", async () => {
    mockFetchJSON.mockImplementation(async (path: string) => {
      if (path === primary("s1")) throw new Error("HTTP 404: not found");
      if (path === sessionLog("s1")) return withMessages("s1", 2);
      throw new Error(`unexpected ${path}`);
    });

    const result = await fetchSessionMessages("s1");

    expect(result.messages).toHaveLength(2);
  });

  it("主端点 404 且会话日志也为空时抛出原始错误", async () => {
    mockFetchJSON.mockImplementation(async (path: string) => {
      if (path === primary("s2")) throw new Error("HTTP 404: not found");
      if (path === sessionLog("s2")) return withMessages("s2", 0);
      throw new Error(`unexpected ${path}`);
    });

    await expect(fetchSessionMessages("s2")).rejects.toThrow("HTTP 404");
  });

  it("abort 错误直接抛出，不触发回退", async () => {
    const abort = new DOMException("aborted", "AbortError");
    mockFetchJSON.mockImplementation(async (path: string) => {
      if (path === primary("s3")) throw abort;
      throw new Error(`unexpected fallback ${path}`);
    });

    await expect(fetchSessionMessages("s3")).rejects.toBe(abort);
    expect(mockFetchJSON).toHaveBeenCalledTimes(1);
  });

  it("主端点成功但为空时仍回退（保持既有行为）", async () => {
    mockFetchJSON.mockImplementation(async (path: string) => {
      if (path === primary("s4")) return withMessages("s4", 0);
      if (path === sessionLog("s4")) return withMessages("s4", 3);
      throw new Error(`unexpected ${path}`);
    });

    const result = await fetchSessionMessages("s4");

    expect(result.messages).toHaveLength(3);
  });
});

describe("deleteSessionRequest 写锁参数", () => {
  it("删除前读取 revision/generation 并拼进查询串（内核 owner 缺任一项就 409/400）", async () => {
    mockFetchJSON.mockResolvedValue({ id: "s1", runtime_revision: 33, runtime_generation: 1 });
    mockDeleteJSON.mockResolvedValue({ ok: true });

    const result = await deleteSessionsInBatches(["s1"]);

    expect(result.succeededIds).toEqual(["s1"]);
    expect(mockFetchJSON).toHaveBeenCalledWith("/api/sessions/s1", undefined, expect.anything());
    const [url, body] = mockDeleteJSON.mock.calls[0];
    expect(body).toBeUndefined();
    const query = new URLSearchParams(url.split("?")[1]);
    expect(query.get("request_id")).toBeTruthy();
    expect(query.get("expected_revision")).toBe("33");
    expect(query.get("expected_generation")).toBe("1");
  });

  it("会话已不存在（404）按幂等成功处理，不再发 DELETE", async () => {
    mockFetchJSON.mockRejectedValue(new Error("HTTP 404: not_found"));
    mockDeleteJSON.mockClear();

    const result = await deleteSessionsInBatches(["gone"]);

    expect(result.succeededIds).toEqual(["gone"]);
    expect(mockDeleteJSON).not.toHaveBeenCalled();
  });

  it("缺 generation 时只带 request_id + expected_revision", async () => {
    mockFetchJSON.mockResolvedValue({ id: "s2", runtime_revision: 7, runtime_generation: null });
    mockDeleteJSON.mockClear();
    mockDeleteJSON.mockResolvedValue({ ok: true });

    await deleteSessionsInBatches(["s2"]);

    const [url] = mockDeleteJSON.mock.calls[0];
    const query = new URLSearchParams(url.split("?")[1]);
    expect(query.get("expected_revision")).toBe("7");
    expect(query.has("expected_generation")).toBe(false);
  });
});

describe("会话全文搜索", () => {
  it("剥掉内核 snippet 的 >>> / <<< 高亮标记", () => {
    expect(stripSearchHighlight("前文 >>>命中的词<<< 后文")).toBe("前文 命中的词 后文");
    expect(stripSearchHighlight("  ...a>>>b<<<c...  ")).toBe("...abc...");
    expect(stripSearchHighlight(null)).toBe("");
    expect(stripSearchHighlight(undefined)).toBe("");
  });

  it("按内核真实路径拼 q 与 limit", () => {
    expect(sessionSearchPath("部署 网关", 10)).toBe(
      `/api/sessions/search?q=${encodeURIComponent("部署 网关")}&limit=10`,
    );
    expect(sessionSearchPath("abc")).toBe("/api/sessions/search?q=abc&limit=20");
  });

  it("把命中转成侧栏行，preview 用去标记后的 snippet", () => {
    const rows = searchResultsToSummaries([
      {
        session_id: "s1",
        snippet: ">>>老<<<会话里的片段",
        title: "旧标题",
        source: "cli",
        session_started: 100,
        last_active: 200,
        message_count: 4,
        is_active: false,
      },
    ]);

    expect(rows[0]).toMatchObject({
      id: "s1",
      title: "旧标题",
      preview: "老会话里的片段",
      source: "cli",
      started_at: 100,
      last_active: 200,
      message_count: 4,
    });
  });
});

describe("useSessionSearch 防抖与后端调用", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchJSON.mockReset();
    mockFetchJSON.mockResolvedValue({ results: [{ session_id: "old-1", snippet: ">>>命中<<<" }] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("输入后等 250ms 才打后端，且只用最后一次输入", async () => {
    const { rerender } = renderHook(({ q }: { q: string }) => useSessionSearch(q), {
      wrapper,
      initialProps: { q: "h" },
    });

    rerender({ q: "he" });
    rerender({ q: "her" });
    expect(mockFetchJSON).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(mockFetchJSON).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(mockFetchJSON).toHaveBeenCalledTimes(1);
    expect(mockFetchJSON.mock.calls[0][0]).toBe(
      `/api/sessions/search?q=her&limit=${SESSION_SEARCH_LIMIT}`,
    );
  });

  it("少于两个字符不请求", async () => {
    renderHook(() => useSessionSearch("a"), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mockFetchJSON).not.toHaveBeenCalled();
  });

  it("渲染后端结果并去掉高亮标记", async () => {
    const { result } = renderHook(() => useSessionSearch("命中"), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(result.current.results).toHaveLength(1);
    expect(stripSearchHighlight(result.current.results[0].snippet)).toBe("命中");
  });
});

describe("会话标记位写回", () => {
  beforeEach(() => {
    mockFetchJSON.mockReset();
    mockPatchJSON.mockReset();
    mockFetchJSON.mockResolvedValue({ id: "s1", runtime_revision: 3, runtime_generation: 1 });
    mockPatchJSON.mockResolvedValue({ ok: true });
  });

  it("PATCH 带 request_id / expected_revision / expected_generation 和 unread", async () => {
    const result = await patchSessionFlags(["s1"], { unread: false });

    expect(result.succeededIds).toEqual(["s1"]);
    const [url, body] = mockPatchJSON.mock.calls[0];
    expect(url).toBe("/api/sessions/s1");
    expect(body).toMatchObject({
      expected_revision: 3,
      expected_generation: 1,
      unread: false,
    });
    expect(typeof body.request_id).toBe("string");
  });

  it("revision 冲突时重读水位重试一次", async () => {
    mockPatchJSON
      .mockRejectedValueOnce(new Error("HTTP 409: revision_conflict"))
      .mockResolvedValueOnce({ ok: true });

    const result = await patchSessionFlags(["s1"], { unread: true });

    expect(result.succeededIds).toEqual(["s1"]);
    expect(mockPatchJSON).toHaveBeenCalledTimes(2);
    expect(mockFetchJSON).toHaveBeenCalledTimes(2);
  });

  it("client_upgrade_required 不重试并记进失败列表", async () => {
    mockPatchJSON.mockRejectedValue(new Error("HTTP 409: client_upgrade_required"));

    const result = await patchSessionFlags(["s1"], { pinned: true });

    expect(result.succeededIds).toEqual([]);
    expect(result.failed).toEqual([{ id: "s1", error: "HTTP 409: client_upgrade_required" }]);
    expect(mockPatchJSON).toHaveBeenCalledTimes(1);
  });
});
