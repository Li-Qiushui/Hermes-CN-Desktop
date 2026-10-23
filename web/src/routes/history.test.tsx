// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";
import type { SessionSummary } from "@hermes/protocol";
import { HistoryRoute } from "./history";
import { usePagedSessions, useSessionSearch } from "@/hooks/use-sessions";
import { __resetUiStoreForTests } from "@/lib/ui-store";
import { chatRuntimeBySessionAtom } from "@/stores/chat";

vi.mock("@/hooks/use-sessions", () => ({
  usePagedSessions: vi.fn(),
  useSessionSearch: vi.fn(),
  useArchiveSession: () => ({ mutate: vi.fn(), isPending: false }),
  useUnarchiveSession: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSessions: () => ({ mutateAsync: vi.fn(), isPending: false }),
  prefetchSessionMessages: vi.fn(),
  searchResultsToSummaries: (results: Array<Record<string, unknown>>) =>
    results.map((result) => ({
      id: result.session_id,
      model: "",
      title: result.title ?? null,
      preview: result.snippet,
      started_at: result.session_started ?? 1,
      ended_at: null,
      message_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      estimated_cost_usd: null,
    })),
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

function paged(pages: Array<{ sessions: SessionSummary[]; total: number }>, overrides: Record<string, unknown> = {}) {
  return {
    data: { pages, pageParams: pages.map((_page, index) => index * 100) },
    isLoading: false,
    isError: false,
    isFetchingNextPage: false,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof usePagedSessions>;
}

function renderHistory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/history"]}>
        <HistoryRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  __resetUiStoreForTests();
  getDefaultStore().set(chatRuntimeBySessionAtom, {});
  vi.mocked(usePagedSessions).mockReturnValue(paged([{ sessions: [summary({ id: "h1" })], total: 1 }]));
  vi.mocked(useSessionSearch).mockReturnValue({
    results: [],
    searchPending: false,
    debouncedQuery: "",
  } as unknown as ReturnType<typeof useSessionSearch>);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HistoryRoute 分页", () => {
  it("首屏按页渲染，还有下一页时给「加载更多」", () => {
    vi.mocked(usePagedSessions).mockReturnValue(
      paged([{ sessions: [summary({ id: "h1" })], total: 3 }]),
    );

    renderHistory();

    expect(document.body.textContent).toContain("h1");
    fireEvent.click(screen.getByRole("button", { name: /加载更多/ }));

    expect(vi.mocked(usePagedSessions).mock.results.at(-1)?.value.fetchNextPage).toHaveBeenCalled();
  });

  it("全部加载完后不再显示加载更多", () => {
    vi.mocked(usePagedSessions).mockReturnValue(
      paged([{ sessions: [summary({ id: "h1" })], total: 1 }]),
    );

    renderHistory();

    expect(screen.queryByRole("button", { name: /加载更多/ })).toBeNull();
    expect(document.body.textContent).toContain("已加载全部");
  });

  it("第二页的行合并进列表", () => {
    vi.mocked(usePagedSessions).mockReturnValue(
      paged([
        { sessions: [summary({ id: "h1" })], total: 2 },
        { sessions: [summary({ id: "h2" })], total: 2 },
      ]),
    );

    renderHistory();

    expect(document.body.textContent).toContain("h1");
    expect(document.body.textContent).toContain("h2");
    expect(document.body.textContent).toContain("已加载全部 2 条");
  });
});

describe("HistoryRoute 后端全文搜索", () => {
  it("未加载的老会话命中会并进列表", async () => {
    vi.mocked(useSessionSearch).mockReturnValue({
      results: [{ session_id: "old-9", snippet: "很久以前的部署记录", title: "旧部署" }],
      searchPending: false,
      debouncedQuery: "部署",
    } as unknown as ReturnType<typeof useSessionSearch>);

    renderHistory();
    const input = screen.getByPlaceholderText(/搜索/);
    fireEvent.change(input, { target: { value: "部署" } });

    await waitFor(() => expect(document.body.textContent).toContain("旧部署"));
  });
});


describe("HistoryRoute 工作区筛选", () => {
  it("按工作区筛掉别的项目的会话，选「全部工作区」后回来", async () => {
    vi.mocked(usePagedSessions).mockReturnValue(
      paged([
        {
          sessions: [
            summary({ id: "wa-1", cwd: "/repo/alpha" }),
            summary({ id: "wa-2", cwd: "/repo/alpha/sub" }),
            summary({ id: "wb-1", cwd: "/repo/beta" }),
          ],
          total: 3,
        },
      ]),
    );

    renderHistory();
    expect(document.body.textContent).toContain("wa-1");
    expect(document.body.textContent).toContain("wb-1");

    fireEvent.click(screen.getByRole("button", { name: "按工作区分组筛选" }));
    await waitFor(() =>
      expect(document.querySelector('[data-workspace-option="/repo/alpha"]')).not.toBeNull(),
    );
    fireEvent.click(document.querySelector('[data-workspace-option="/repo/alpha"]')!);

    await waitFor(() => expect(document.body.textContent).not.toContain("wb-1"));
    expect(document.body.textContent).toContain("wa-1");
    expect(document.body.textContent).toContain("wa-2");
    expect(screen.getByRole("button", { name: "按工作区分组筛选" }).textContent).toContain(
      "工作区：alpha",
    );

    fireEvent.click(screen.getByRole("button", { name: "按工作区分组筛选" }));
    await waitFor(() =>
      expect(document.querySelector('[data-workspace-option="all"]')).not.toBeNull(),
    );
    fireEvent.click(document.querySelector('[data-workspace-option="all"]')!);

    await waitFor(() => expect(document.body.textContent).toContain("wb-1"));
    expect(document.body.textContent).toContain("wa-1");
  });
});
