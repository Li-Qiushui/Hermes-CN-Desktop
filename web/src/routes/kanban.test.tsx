// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const h = vi.hoisted(() => {
  const body = "把部署脚本改成并行";
  const tasks = [
    {
      id: "t_body",
      title: "重构登录",
      status: "todo",
      assignee: "writer",
      priority: 0,
      body,
      latest_summary: "等 CI 结果",
      created_at: 1_700_000_000,
      comment_count: 0,
      link_counts: { parents: 0, children: 0 },
    },
    {
      id: "t_summary",
      title: "修 CI",
      status: "todo",
      assignee: "writer",
      priority: 0,
      body: null,
      latest_summary: "等待评审通过",
      created_at: 1_700_000_001,
      comment_count: 0,
      link_counts: { parents: 0, children: 0 },
    },
    {
      id: "t_none",
      title: "无关任务",
      status: "todo",
      assignee: "writer",
      priority: 0,
      body: null,
      latest_summary: "没什么进展",
      created_at: 1_700_000_002,
      comment_count: 0,
      link_counts: { parents: 0, children: 0 },
    },
  ];
  return {
    tasks,
    board: { columns: [{ name: "todo", tasks }], latest_event_id: 9 },
    workflow: [
      { key: "todo", label: "Todo", drag_target: true },
      { key: "done", label: "Done", drag_target: true },
    ],
    deleteMock: vi.fn(),
    cancelDispatchMock: vi.fn(),
    confirmMock: vi.fn(),
  };
});

vi.mock("@/hooks/use-kanban", () => ({
  useKanbanBoards: () => ({ data: { boards: [], current: "default" } }),
  useKanbanBoard: () => ({
    data: h.board,
    isPending: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useKanbanWorkflow: () => ({ data: { columns: h.workflow }, isPending: false, isError: false, error: null }),
  useKanbanAssignees: () => ({ data: { assignees: [{ name: "writer" }] } }),
  useKanbanTask: () => ({ data: null, isPending: false, isError: false, error: null }),
  useKanbanDiagnostics: () => ({ data: null }),
  useKanbanTaskLog: () => ({ data: null, isFetching: false }),
  useUpdateKanbanTask: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null }),
  useCreateKanbanTask: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null }),
  useAddKanbanComment: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null }),
  useBulkKanbanTasks: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null }),
  useDeleteKanbanTask: () => ({
    mutateAsync: h.deleteMock,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/use-kanban-events", () => ({
  useKanbanEvents: () => ({ status: "open", cursor: 9, reconnects: 0 }),
}));

vi.mock("@/hooks/use-status", () => ({
  useStatus: () => ({ data: { gateway_health_url: "http://127.0.0.1:54120" }, isError: false }),
}));

vi.mock("@/lib/kanban-dispatch", () => ({
  cancelKanbanDispatch: h.cancelDispatchMock,
}));

vi.mock("@/lib/use-confirm", () => ({
  useConfirm: () => ({ confirm: h.confirmMock, prompt: vi.fn() }),
}));

import { KanbanRoute } from "./kanban";

const { confirmMock, deleteMock, cancelDispatchMock } = h;

function renderRoute() {
  return render(
    <MemoryRouter>
      <KanbanRoute />
    </MemoryRouter>,
  );
}

function search(value: string) {
  fireEvent.change(screen.getByLabelText("搜索任务"), { target: { value } });
}

beforeEach(() => {
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
  deleteMock.mockReset();
  cancelDispatchMock.mockReset();
});

afterEach(() => cleanup());

describe("KanbanRoute 搜索与批量删除", () => {
  it("按任务正文搜索能命中", async () => {
    renderRoute();
    expect(screen.getByText("无关任务")).toBeTruthy();
    search("部署脚本");
    await waitFor(() => expect(screen.queryByText("无关任务")).toBeNull());
    expect(screen.queryByText("重构登录")).toBeTruthy();
  });

  it("按 latest_summary 搜索能命中", async () => {
    renderRoute();
    search("等待评审");
    await waitFor(() => expect(screen.queryByText("重构登录")).toBeNull());
    expect(screen.queryByText("修 CI")).toBeTruthy();
  });

  it("批量删除先二次确认，失败项回填选择集", async () => {
    renderRoute();
    fireEvent.click(screen.getByLabelText("重构登录，状态 todo"), { ctrlKey: true });
    fireEvent.click(screen.getByLabelText("修 CI，状态 todo"), { ctrlKey: true });
    expect(screen.getByText("已选 2 个任务")).toBeTruthy();

    deleteMock.mockImplementation(async (id: string) => {
      if (id === "t_summary") throw new Error("内核拒绝");
      return undefined;
    });

    fireEvent.click(screen.getByText("删除"));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(confirmMock.mock.calls[0][0]).toMatchObject({ title: "批量删除任务", danger: true });
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("已选 1 个任务")).toBeTruthy());
  });

  it("取消确认时不发删除请求", async () => {
    confirmMock.mockResolvedValue(false);
    renderRoute();
    fireEvent.click(screen.getByLabelText("无关任务，状态 todo"), { ctrlKey: true });
    fireEvent.click(screen.getByText("删除"));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("页面卸载时取消挂起的 dispatch", async () => {
    const { unmount } = renderRoute();
    await act(async () => {
      unmount();
    });
    expect(cancelDispatchMock).toHaveBeenCalled();
  });
});
