// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionSummary } from "@hermes/protocol";
import { WorkbenchSidebar } from "./workbench-sidebar";
import { usePagedSessions, useSessions } from "@/hooks/use-sessions";
import { writePinnedSessionIds } from "@/lib/session-ui-state";

vi.mock("@/hooks/use-sessions", () => ({
  usePagedSessions: vi.fn(),
  useSessions: vi.fn(),
  useArchiveSession: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSessions: () => ({ mutateAsync: vi.fn(), isPending: false }),
  prefetchSessionMessages: vi.fn(),
}));

vi.mock("@/hooks/use-profiles", () => ({
  useActiveProfileName: () => "default",
}));

vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => ({ setSessionTitle: vi.fn(), resumeSession: vi.fn() }),
}));

vi.mock("@/hooks/use-session-branch", () => ({
  useSessionBranch: () => ({
    branchSession: vi.fn(),
    branchingSessionId: null,
    error: "",
    clearError: vi.fn(),
  }),
}));

function summary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  const base = Math.floor(Date.now() / 1000);
  return {
    model: "model",
    title: overrides.id,
    started_at: base - 600,
    ended_at: base - 300,
    message_count: 3,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: null,
    ...overrides,
  };
}

function pagedResult(overrides: Record<string, unknown> = {}) {
  return {
    data: { pages: [], pageParams: [0] },
    isLoading: false,
    isError: false,
    isFetchingNextPage: false,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof usePagedSessions>;
}

function pagedWith(sessions: SessionSummary[]) {
  return pagedResult({
    data: { pages: [{ sessions, total: sessions.length }], pageParams: [0] },
  });
}

function renderSidebar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <WorkbenchSidebar />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function rowIds(selector: string): Array<string | null> {
  return Array.from(document.querySelectorAll(`${selector} [data-session-row]`)).map((element) =>
    element.getAttribute("data-session-row"),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(useSessions).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useSessions>);
  vi.mocked(usePagedSessions).mockReturnValue(pagedResult());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkbenchSidebar 首屏状态", () => {
  it("首屏请求未回来时显示读取提示而不是空文案", () => {
    vi.mocked(usePagedSessions).mockReturnValue(pagedResult({ data: undefined, isLoading: true }));

    renderSidebar();

    expect(screen.getByRole("status").textContent).toContain("正在读取会话");
    expect(screen.queryByText("还没有历史对话")).toBeNull();
  });

  it("请求失败时显示失败原因与重试按钮", () => {
    const refetch = vi.fn();
    vi.mocked(usePagedSessions).mockReturnValue(pagedResult({ isError: true, refetch }));

    renderSidebar();

    expect(screen.getByRole("alert").textContent).toContain("会话列表加载失败");
    expect(screen.queryByText("还没有历史对话")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("只有请求成功且确实没有数据时才显示空状态", () => {
    renderSidebar();

    expect(screen.getByText("还没有历史对话")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("WorkbenchSidebar 会话分组", () => {
  it("置顶的进行中会话只出现在置顶里，不重复进进行中分组", () => {
    const base = Math.floor(Date.now() / 1000);
    const pinnedRunning = summary({
      id: "pinned-running",
      title: "置顶且正在跑",
      started_at: base - 30,
      ended_at: null,
      is_active: true,
      message_count: 4,
    });
    const running = summary({
      id: "running-1",
      title: "普通进行中",
      started_at: base - 20,
      ended_at: null,
      is_active: true,
      message_count: 4,
    });
    const done = summary({ id: "done-1", title: "已结束的对话", started_at: base - 4000, ended_at: base - 3000 });
    writePinnedSessionIds(["pinned-running"]);
    vi.mocked(usePagedSessions).mockReturnValue(pagedWith([pinnedRunning, running, done]));

    renderSidebar();

    expect(rowIds('[data-section="active"]')).toEqual(["running-1"]);
    expect(document.querySelectorAll('[data-session-row="pinned-running"]')).toHaveLength(0);
  });

  it("无标题会话用 preview 也能被搜到", async () => {
    const untitled = summary({ id: "untitled-1", title: null, preview: "把侧栏加载态补上" });
    const titled = summary({ id: "titled-1", title: "另一个对话", preview: "无关内容" });
    vi.mocked(usePagedSessions).mockReturnValue(pagedWith([untitled, titled]));

    renderSidebar();
    fireEvent.change(screen.getByLabelText("搜索对话"), { target: { value: "加载态" } });

    await waitFor(() =>
      expect(document.querySelector('[data-session-row="untitled-1"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-session-row="titled-1"]')).toBeNull();
  });
});

describe("WorkbenchSidebar 请求参数", () => {
  it("最近列表按活跃时间排序，工作区外不请求 focused 列表", () => {
    renderSidebar();

    expect(vi.mocked(usePagedSessions).mock.calls.at(-1)).toEqual([20, { order: "recent" }]);
    const focusedOptions = vi.mocked(useSessions).mock.calls.at(-1)?.[2];
    expect(focusedOptions).toMatchObject({ enabled: false, order: "recent" });
  });
});
