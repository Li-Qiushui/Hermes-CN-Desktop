// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";
import type { SessionSummary } from "@hermes/protocol";
import { WorkbenchSidebar } from "./workbench-sidebar";
import { usePagedSessions, useSessionSearch, useSessions, useSetSessionFlags } from "@/hooks/use-sessions";
import {
  readSidebarGrouping,
  readSidebarSort,
  readSidebarStatusFilter,
  writePinnedSessionIds,
  writeSidebarSort,
  writeSidebarStatusFilter,
} from "@/lib/session-ui-state";
import { __resetUiStoreForTests } from "@/lib/ui-store";
import { chatRuntimeBySessionAtom, createEmptyChatRuntime } from "@/stores/chat";
import { rememberWorkspaceProject, writeWorkspacePath } from "@/lib/workspaces";

const { setFlagsMock } = vi.hoisted(() => ({ setFlagsMock: vi.fn() }));

vi.mock("@/hooks/use-sessions", () => ({
  usePagedSessions: vi.fn(),
  useSessions: vi.fn(),
  useSessionSearch: vi.fn(),
  useSetSessionFlags: vi.fn(() => ({ mutate: setFlagsMock, isPending: false })),
  useArchiveSession: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSessions: () => ({ mutateAsync: vi.fn(), isPending: false }),
  prefetchSessionMessages: vi.fn(),
  searchResultsToSummaries: (results: Array<Record<string, unknown>>) =>
    results.map((result) => ({
      id: result.session_id,
      model: "",
      title: result.title ?? null,
      preview: result.snippet,
      started_at: 1,
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

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location-probe">{`${location.pathname}${location.search}`}</span>;
}

function renderSidebarWithProbe() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <WorkbenchSidebar />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openListTools() {
  fireEvent.click(screen.getByRole("button", { name: "排序、分组与筛选" }));
  return await screen.findByRole("dialog", { name: "排序、分组与筛选" });
}

function rowIds(selector: string): Array<string | null> {
  return Array.from(document.querySelectorAll(`${selector} [data-session-row]`)).map((element) =>
    element.getAttribute("data-session-row"),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  __resetUiStoreForTests();
  setFlagsMock.mockReset();
  getDefaultStore().set(chatRuntimeBySessionAtom, {});
  vi.mocked(useSessions).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useSessions>);
  vi.mocked(usePagedSessions).mockReturnValue(pagedResult());
  vi.mocked(useSessionSearch).mockReturnValue(
    {
      results: [],
      searchPending: false,
      debouncedQuery: "",
    } as unknown as ReturnType<typeof useSessionSearch>,
  );
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

describe("WorkbenchSidebar 状态点七态", () => {
  it("后端 watermark 未读的会话画未读点，点击「全部已读」清掉并写回后端", async () => {
    const unread = summary({ id: "u1", title: "有未读", unread: true });
    vi.mocked(usePagedSessions).mockReturnValue(pagedWith([unread]));

    renderSidebar();

    expect(document.querySelector('[data-session-row="u1"]')?.getAttribute("data-dot-state")).toBe("unread");
    expect(document.querySelector('[data-session-row="u1"]')?.getAttribute("data-unread")).toBe("true");

    await openListTools();
    fireEvent.click(screen.getByRole("button", { name: /全部已读/ }));

    await waitFor(() =>
      expect(document.querySelector('[data-session-row="u1"]')?.getAttribute("data-unread")).toBeNull(),
    );
    expect(setFlagsMock).toHaveBeenCalledWith({ ids: ["u1"], unread: false });
  });

  it("有未答审批时画 needs-input（压过 running / unread）", () => {
    const runtime = createEmptyChatRuntime(1);
    runtime.streamStatus = "streaming";
    runtime.pendingPrompts = [
      {
        kind: "approval",
        promptId: "p1",
        generation: 1,
        sessionId: "busy",
        command: "rm -rf /tmp/x",
        choices: ["once", "deny"],
        multiSelect: false,
        receivedAt: 1,
      },
    ];
    getDefaultStore().set(chatRuntimeBySessionAtom, { busy: runtime });
    vi.mocked(usePagedSessions).mockReturnValue(
      pagedWith([summary({ id: "busy", ended_at: null, unread: true })]),
    );

    renderSidebar();

    expect(document.querySelector('[data-session-row="busy"]')?.getAttribute("data-dot-state")).toBe(
      "needs-input",
    );
  });

  it("运行中的会话画 working，静置的会话画 idle", () => {
    const runtime = createEmptyChatRuntime(1);
    runtime.streamStatus = "streaming";
    runtime.lastActivityAt = Date.now();
    getDefaultStore().set(chatRuntimeBySessionAtom, { run: runtime });
    vi.mocked(usePagedSessions).mockReturnValue(
      pagedWith([
        summary({ id: "run", ended_at: null }),
        summary({ id: "quiet" }),
      ]),
    );

    renderSidebar();

    expect(document.querySelector('[data-session-row="run"]')?.getAttribute("data-dot-state")).toBe("working");
    expect(document.querySelector('[data-session-row="quiet"]')?.getAttribute("data-dot-state")).toBe("idle");
  });
});

describe("WorkbenchSidebar 后端搜索", () => {
  it("未加载的老会话命中时单列一段，snippet 当行内容", async () => {
    vi.mocked(usePagedSessions).mockReturnValue(pagedWith([summary({ id: "recent-1" })]));
    vi.mocked(useSessionSearch).mockReturnValue({
      results: [{ session_id: "old-1", snippet: "老会话里的部署记录", title: "旧部署" }],
      searchPending: false,
      debouncedQuery: "部署",
    } as unknown as ReturnType<typeof useSessionSearch>);

    renderSidebar();
    fireEvent.change(screen.getByLabelText("搜索对话"), { target: { value: "部署" } });

    await waitFor(() =>
      expect(document.querySelector('[data-section="server-search"]')).not.toBeNull(),
    );
    const hit = document.querySelector('[data-session-row="old-1"]');
    expect(hit?.getAttribute("data-search-hit")).toBe("true");
    expect(hit?.textContent).toContain("老会话里的部署记录");
  });

  it("搜索框按输入联动 useSessionSearch（后端全文）", async () => {
    renderSidebar();
    fireEvent.change(screen.getByLabelText("搜索对话"), { target: { value: "网关" } });

    await waitFor(() =>
      expect(vi.mocked(useSessionSearch).mock.calls.at(-1)?.[0]).toBe("网关"),
    );
  });

  it("没有命中时不再提示「搜索全部会话请用 ⌘K」", () => {
    vi.mocked(usePagedSessions).mockReturnValue(pagedWith([summary({ id: "a-1" })]));

    renderSidebar();
    fireEvent.change(screen.getByLabelText("搜索对话"), { target: { value: "zzz" } });

    expect(document.body.textContent).not.toContain("⌘K");
    expect(document.body.textContent).not.toContain("搜索全部会话");
  });
});

describe("WorkbenchSidebar 排序 / 筛选 / 分组", () => {
  const base = Math.floor(Date.now() / 1000);
  const rows = [
    summary({ id: "small", title: "小用量", input_tokens: 1, output_tokens: 1, started_at: base - 10, ended_at: base - 5 }),
    summary({ id: "big", title: "大用量", input_tokens: 900, output_tokens: 100, started_at: base - 20, ended_at: base - 15 }),
  ];

  it("在浮层里选排序会写入 ui-store 并重排列表", async () => {
    vi.mocked(usePagedSessions).mockReturnValue(pagedWith(rows));

    renderSidebar();
    expect(rowIds("[data-day-group]")).toEqual(["small", "big"]);

    await openListTools();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Token 用量" }));

    await waitFor(() => expect(readSidebarSort()).toBe("tokens"));
    expect(rowIds("[data-day-group]")).toEqual(["big", "small"]);
    expect(
      document.querySelector('[data-sort-key="tokens"]')?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("状态筛选行：状态点是 6px 小点，只有标签格吃剩余宽度", async () => {
    renderSidebar();
    const panel = await openListTools();
    const option = panel.querySelector('[data-status-bucket="needs-input"]') as HTMLElement;
    expect(option).toBeTruthy();
    const [dot, label] = Array.from(option.children) as HTMLElement[];
    expect(dot.className).toContain("filterDot");
    expect(label.className).toContain("toolsOptionLabel");
    expect(dot.className).not.toContain("toolsOptionLabel");
  });

  it("状态筛选在浮层里生效并只留下命中的桶", async () => {
    vi.mocked(usePagedSessions).mockReturnValue(
      pagedWith([
        summary({ id: "unread-1", unread: true }),
        summary({ id: "plain-1" }),
      ]),
    );

    renderSidebar();
    expect(rowIds("[data-day-group]")).toEqual(["unread-1", "plain-1"]);

    const panel = await openListTools();
    expect(panel.getAttribute("aria-label")).toBe("排序、分组与筛选");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /未读/ }));

    await waitFor(() => expect(readSidebarStatusFilter()).toEqual(["unread"]));
    expect(rowIds("[data-day-group]")).toEqual(["unread-1"]);
  });

  it("默认按天分组，在浮层里切到按状态后分组键换成状态桶", async () => {
    vi.mocked(usePagedSessions).mockReturnValue(pagedWith([summary({ id: "u2", unread: true })]));

    renderSidebar();
    expect(document.querySelector('[data-grouping="day"]')).not.toBeNull();

    await openListTools();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "按状态" }));

    await waitFor(() =>
      expect(document.querySelector('[data-grouping="status"]')).not.toBeNull(),
    );
    expect(readSidebarGrouping()).toBe("status");
    expect(document.querySelector('[data-group-key="unread"]')).not.toBeNull();
  });
});

describe("WorkbenchSidebar 复制会话 ID", () => {
  it("右键菜单里有「复制会话 ID」，点了写剪贴板", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    vi.mocked(usePagedSessions).mockReturnValue(pagedWith([summary({ id: "copy-me" })]));

    renderSidebar();
    fireEvent.contextMenu(document.querySelector('[data-session-row="copy-me"]')!);

    const item = await screen.findByRole("menuitem", { name: /复制会话 ID/ });
    fireEvent.click(item);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("copy-me"));
  });
});


describe("WorkbenchSidebar 列表浮层", () => {
  it("点图标按钮开、再点关", async () => {
    renderSidebar();

    expect(screen.queryByRole("dialog", { name: "排序、分组与筛选" })).toBeNull();
    await openListTools();
    expect(screen.getByRole("dialog", { name: "排序、分组与筛选" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "排序、分组与筛选" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "排序、分组与筛选" })).toBeNull(),
    );
  });

  it("按 Esc 关闭浮层", async () => {
    renderSidebar();
    await openListTools();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "排序、分组与筛选" })).toBeNull(),
    );
  });

  it("浮层里三节齐全：排序 / 分组 / 筛选", async () => {
    renderSidebar();
    const panel = await openListTools();

    expect(panel.querySelector('[data-section="sort"]')?.textContent).toContain("排序");
    expect(panel.querySelector('[data-section="grouping"]')?.textContent).toContain("分组");
    expect(panel.querySelector('[data-section="status"]')?.textContent).toContain("筛选");
  });
});

describe("WorkbenchSidebar 记住工作区", () => {
  it("项目行 hover 的加号在该工作区开新会话", async () => {
    rememberWorkspaceProject("D:\\Project\\demo", "demo");
    vi.mocked(usePagedSessions).mockReturnValue(
      pagedWith([summary({ id: "w1", cwd: "D:\\Project\\demo" })]),
    );

    renderSidebarWithProbe();
    fireEvent.click(screen.getByRole("radio", { name: "工作区" }));

    const plus = await screen.findByRole("button", { name: "在 demo 新建对话" });
    fireEvent.click(plus);

    await waitFor(() =>
      expect(screen.getByTestId("location-probe").textContent).toBe(
        "/?workspace=D%3A%5CProject%5Cdemo",
      ),
    );
  });

  it("新建对话默认带上上次用过的工作区", async () => {
    writeWorkspacePath("D:\\Project\\demo");

    renderSidebarWithProbe();
    fireEvent.click(screen.getByRole("button", { name: "新建对话" }));

    await waitFor(() =>
      expect(screen.getByTestId("location-probe").textContent).toBe(
        "/?workspace=D%3A%5CProject%5Cdemo",
      ),
    );
  });
});


describe("WorkbenchSidebar 置顶拖拽", () => {
  const pinnedRows = [
    summary({ id: "p1", title: "置顶一" }),
    summary({ id: "p2", title: "置顶二" }),
  ];

  it("置顶视图按存下来的顺序渲染，并给每行挂拖拽手柄", async () => {
    writePinnedSessionIds(["p2", "p1"]);
    vi.mocked(usePagedSessions).mockReturnValue(pagedWith(pinnedRows));

    renderSidebar();
    fireEvent.click(screen.getByRole("radio", { name: "置顶" }));

    await waitFor(() => expect(document.querySelectorAll("[data-sortable-row]")).toHaveLength(2));
    expect(rowIds('[data-section="pinned"]')).toEqual(["p2", "p1"]);

    const handles = document.querySelectorAll('[data-section="pinned"] button[data-enabled]');
    expect(handles).toHaveLength(2);
    expect(Array.from(handles).every((handle) => !(handle as HTMLButtonElement).disabled)).toBe(true);
    expect((handles[0] as HTMLButtonElement).title).toBe("拖动调整置顶顺序");
    expect(
      document.querySelector('[data-section="pinned"]')?.getAttribute("data-reorder"),
    ).toBe("on");
  });

  it("按非「最近更新」排序时拖拽关闭", async () => {
    writePinnedSessionIds(["p1", "p2"]);
    writeSidebarSort("tokens");
    vi.mocked(usePagedSessions).mockReturnValue(pagedWith(pinnedRows));

    renderSidebar();
    fireEvent.click(screen.getByRole("radio", { name: "置顶" }));

    await waitFor(() => expect(document.querySelectorAll("[data-sortable-row]")).toHaveLength(2));
    expect(
      document.querySelector('[data-section="pinned"]')?.getAttribute("data-reorder"),
    ).toBe("off");
    const handles = document.querySelectorAll('[data-section="pinned"] button[data-enabled]');
    expect(Array.from(handles).every((handle) => (handle as HTMLButtonElement).disabled)).toBe(true);
  });
});
