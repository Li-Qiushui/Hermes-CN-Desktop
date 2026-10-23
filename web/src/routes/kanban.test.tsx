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
      { key: "blocked", label: "Blocked", drag_target: true },
      { key: "done", label: "Done", drag_target: true },
    ],
    boards: [
      { slug: "default", name: "默认看板", total: 3, is_current: true },
      { slug: "other", name: "另一个看板", total: 1 },
    ],
    profiles: [{ name: "writer" }, { name: "reviewer" }],
    deleteMock: vi.fn(),
    cancelDispatchMock: vi.fn(),
    confirmMock: vi.fn(),
    updateMock: vi.fn(),
    addLinkMock: vi.fn(),
    removeLinkMock: vi.fn(),
    reassignMock: vi.fn(),
    reclaimMock: vi.fn(),
    decomposeMock: vi.fn(),
    uploadMock: vi.fn(),
    deleteAttachmentMock: vi.fn(),
    createBoardMock: vi.fn(),
    archiveBoardMock: vi.fn(),
  };
});

vi.mock("@/hooks/use-kanban", () => ({
  useKanbanBoards: () => ({ data: { boards: h.boards, current: "default" } }),
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
  useKanbanProfiles: () => ({ data: { profiles: h.profiles } }),
  useKanbanTask: () => ({ data: null, isPending: false, isError: false, error: null }),
  useKanbanDiagnostics: () => ({ data: null }),
  useKanbanTaskLog: () => ({ data: null, isFetching: false }),
  useUpdateKanbanTask: () => ({
    mutateAsync: h.updateMock,
    isPending: false,
    isError: false,
    error: null,
  }),
  useCreateKanbanTask: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null }),
  useAddKanbanComment: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null }),
  useBulkKanbanTasks: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null }),
  useAddKanbanLink: () => ({ mutateAsync: h.addLinkMock, isPending: false, isError: false, error: null }),
  useRemoveKanbanLink: () => ({
    mutateAsync: h.removeLinkMock,
    isPending: false,
    isError: false,
    error: null,
  }),
  useReassignKanbanTask: () => ({ mutateAsync: h.reassignMock, isPending: false, isError: false, error: null }),
  useReclaimKanbanTask: () => ({ mutateAsync: h.reclaimMock, isPending: false, isError: false, error: null }),
  useDecomposeKanbanTask: () => ({ mutateAsync: h.decomposeMock, isPending: false, isError: false, error: null }),
  useUploadKanbanAttachment: () => ({ mutateAsync: h.uploadMock, isPending: false, isError: false, error: null }),
  useDeleteKanbanAttachment: () => ({
    mutateAsync: h.deleteAttachmentMock,
    isPending: false,
    isError: false,
    error: null,
  }),
  useCreateKanbanBoard: () => ({ mutateAsync: h.createBoardMock, isPending: false, isError: false, error: null }),
  useArchiveKanbanBoard: () => ({ mutateAsync: h.archiveBoardMock, isPending: false, isError: false, error: null }),
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

vi.mock("@/hooks/use-toolsets", () => ({
  useToolsets: () => ({
    data: undefined,
    isError: false,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useToggleToolset: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
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

describe("KanbanRoute 编排与看板管理", () => {
  const { updateMock, addLinkMock, reassignMock, decomposeMock, createBoardMock, archiveBoardMock, confirmMock } = h;

  beforeEach(() => {
    updateMock.mockReset();
    updateMock.mockResolvedValue(undefined);
    addLinkMock.mockReset();
    addLinkMock.mockResolvedValue({ ok: true });
    reassignMock.mockReset();
    reassignMock.mockResolvedValue({ ok: true, task_id: "t_body" });
    decomposeMock.mockReset();
    createBoardMock.mockReset();
    createBoardMock.mockResolvedValue({ board: { slug: "hermes-cn" }, current: "hermes-cn" });
    archiveBoardMock.mockReset();
    archiveBoardMock.mockResolvedValue({ ok: true });
  });

  function openDrawer(title = "重构登录") {
    fireEvent.click(screen.getByLabelText(`${title}，状态 todo`));
  }

  it("抽屉里标记阻塞走真实 PATCH 体", async () => {
    renderRoute();
    openDrawer();
    fireEvent.change(screen.getByLabelText("阻塞原因"), { target: { value: "等 CI" } });
    fireEvent.click(screen.getByText("标记阻塞"));
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith({ id: "t_body", body: { status: "blocked", block_reason: "等 CI" } }),
    );
  });

  it("加子任务把当前卡当父任务", async () => {
    renderRoute();
    openDrawer();
    fireEvent.change(screen.getByLabelText("选择要关联的任务"), { target: { value: "t_summary" } });
    fireEvent.click(screen.getByText("加为子任务"));
    await waitFor(() =>
      expect(addLinkMock).toHaveBeenCalledWith({ parentId: "t_body", childId: "t_summary", taskId: "t_body" }),
    );
  });

  it("加父任务角色反转", async () => {
    renderRoute();
    openDrawer();
    fireEvent.change(screen.getByLabelText("选择要关联的任务"), { target: { value: "t_summary" } });
    fireEvent.click(screen.getByText("加为父任务"));
    await waitFor(() =>
      expect(addLinkMock).toHaveBeenCalledWith({ parentId: "t_summary", childId: "t_body", taskId: "t_body" }),
    );
  });

  it("重派带上 profile 与回收开关", async () => {
    renderRoute();
    openDrawer();
    fireEvent.change(screen.getByLabelText("选择目标 profile"), { target: { value: "reviewer" } });
    fireEvent.click(screen.getByRole("button", { name: "重派" }));
    await waitFor(() =>
      expect(reassignMock).toHaveBeenCalledWith({ taskId: "t_body", profile: "reviewer", reclaimFirst: false }),
    );
  });

  it("拆解失败时把后端原文显示在抽屉里", async () => {
    decomposeMock.mockResolvedValue({ ok: false, task_id: "t_body", reason: "auxiliary model not configured" });
    renderRoute();
    openDrawer();
    fireEvent.click(screen.getByText("拆成子任务"));
    const result = await screen.findByLabelText("拆解");
    await waitFor(() => expect(result.textContent).toContain("auxiliary model not configured"));
    expect(decomposeMock).toHaveBeenCalledWith({ taskId: "t_body" });
  });

  it("拆解成功给出子任务提示", async () => {
    decomposeMock.mockResolvedValue({ ok: true, task_id: "t_body", child_ids: ["t_1", "t_2"], fanout: true });
    renderRoute();
    openDrawer();
    fireEvent.click(screen.getByText("拆成子任务"));
    await waitFor(() => expect(screen.getByText("子任务：t_1、t_2")).toBeTruthy());
  });

  it("新建看板校验 slug 后提交并切换", async () => {
    renderRoute();
    fireEvent.click(screen.getByText("新建看板"));
    const dialog = screen.getByLabelText("新建看板");
    expect(dialog.textContent).toContain("slug");
    fireEvent.change(screen.getByLabelText("看板 slug"), { target: { value: "Hermes CN" } });
    fireEvent.change(screen.getByLabelText("看板名称"), { target: { value: "桌面壳" } });
    fireEvent.click(screen.getByText("创建看板"));
    await waitFor(() =>
      expect(createBoardMock).toHaveBeenCalledWith({
        body: { slug: "hermes-cn", name: "桌面壳", switch: true },
      }),
    );
    await waitFor(() => expect(screen.queryByLabelText("新建看板")).toBeNull());
  });

  it("空 slug 时创建按钮禁用", () => {
    renderRoute();
    fireEvent.click(screen.getByText("新建看板"));
    const submit = screen.getByText("创建看板") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("归档看板先二次确认，确认后才发请求", async () => {
    renderRoute();
    fireEvent.click(screen.getByText("归档看板"));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(confirmMock.mock.calls[0][0]).toMatchObject({ title: "归档当前看板", danger: true });
    await waitFor(() => expect(archiveBoardMock).toHaveBeenCalledWith({ slug: "default" }));
  });

  it("取消归档时不发请求", async () => {
    confirmMock.mockResolvedValue(false);
    renderRoute();
    fireEvent.click(screen.getByText("归档看板"));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(archiveBoardMock).not.toHaveBeenCalled();
  });

  it("泳道开关把卡片按负责人分组", () => {
    renderRoute();
    fireEvent.click(screen.getByLabelText("按负责人分泳道"));
    const column = screen.getByLabelText(/待办 列/);
    expect(column.textContent).toContain("writer");
  });
});
