// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TaskOrchestration } from "./task-orchestration";
import type { KanbanTask, KanbanTaskDetailResponse } from "@/lib/kanban";

afterEach(() => cleanup());

function task(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "t_main",
    title: "主任务",
    status: "todo",
    assignee: "writer",
    priority: 0,
    ...overrides,
  };
}

function detail(overrides: Partial<KanbanTaskDetailResponse> = {}): KanbanTaskDetailResponse {
  return {
    task: task(),
    links: { parents: ["t_p"], children: ["t_c"] },
    link_tasks: [
      { id: "t_p", title: "父任务卡", status: "done" },
      { id: "t_c", title: "子任务卡", status: "running" },
    ],
    attachments: [
      { id: 12, task_id: "t_main", filename: "log.txt", size: 2048, content_type: "text/plain" },
    ],
    ...overrides,
  };
}

function renderView(overrides: Partial<Parameters<typeof TaskOrchestration>[0]> = {}) {
  const handlers = {
    onAddLink: vi.fn(),
    onRemoveLink: vi.fn(),
    onBlock: vi.fn(),
    onUnblock: vi.fn(),
    onDecompose: vi.fn(),
    onReassign: vi.fn(),
    onUploadAttachment: vi.fn(),
    onDeleteAttachment: vi.fn(),
  };
  render(
    <TaskOrchestration
      task={task()}
      detail={detail()}
      profiles={["writer", "reviewer"]}
      boardTasks={[
        { id: "t_main", title: "主任务", status: "todo" },
        { id: "t_other", title: "另一张卡", status: "ready" },
      ]}
      busy={null}
      error={null}
      decompose={null}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe("TaskOrchestration 依赖", () => {
  it("列出父/子任务与状态", () => {
    renderView();
    const section = screen.getByLabelText("依赖与父子");
    expect(section.textContent).toContain("依赖与父子 · 2 条");
    expect(section.textContent).toContain("父任务卡");
    expect(section.textContent).toContain("子任务卡");
    expect(section.textContent).toContain("已完成");
  });

  it("加父任务发 parent 角色与目标 id", () => {
    const handlers = renderView();
    fireEvent.change(screen.getByLabelText("选择要关联的任务"), { target: { value: "t_other" } });
    fireEvent.click(screen.getByText("加为父任务"));
    expect(handlers.onAddLink).toHaveBeenCalledWith("parent", "t_other");
  });

  it("加子任务发 child 角色", () => {
    const handlers = renderView();
    fireEvent.change(screen.getByLabelText("选择要关联的任务"), { target: { value: "t_other" } });
    fireEvent.click(screen.getByText("加为子任务"));
    expect(handlers.onAddLink).toHaveBeenCalledWith("child", "t_other");
  });

  it("没选任务时按钮禁用", () => {
    renderView();
    const button = screen.getByText("加为父任务") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("移除父任务带角色与 id", () => {
    const handlers = renderView();
    fireEvent.click(screen.getByLabelText("移除父任务 父任务卡"));
    expect(handlers.onRemoveLink).toHaveBeenCalledWith("parent", "t_p");
  });

  it("没有候选任务时只给提示", () => {
    renderView({ boardTasks: [{ id: "t_main", title: "主任务", status: "todo" }] });
    expect(screen.getByText("看板上没有可关联的其他任务。")).toBeTruthy();
    expect(screen.queryByText("加为父任务")).toBeNull();
  });
});

describe("TaskOrchestration 阻塞", () => {
  it("未阻塞时可带原因标记", () => {
    const handlers = renderView();
    fireEvent.change(screen.getByLabelText("阻塞原因"), { target: { value: "等 CI" } });
    fireEvent.click(screen.getByText("标记阻塞"));
    expect(handlers.onBlock).toHaveBeenCalledWith("等 CI");
  });

  it("阻塞中显示原因并可解除", () => {
    const handlers = renderView({ task: task({ status: "blocked", block_reason: "依赖未完成" }) });
    expect(screen.getByText("依赖未完成")).toBeTruthy();
    fireEvent.click(screen.getByText("解除阻塞"));
    expect(handlers.onUnblock).toHaveBeenCalled();
    expect(screen.queryByText("标记阻塞")).toBeNull();
  });
});

describe("TaskOrchestration 拆解", () => {
  it("triage/todo 才出现入口", () => {
    renderView();
    expect(screen.getByText("拆成子任务")).toBeTruthy();
    cleanup();
    renderView({ task: task({ status: "running" }) });
    expect(screen.queryByText("拆成子任务")).toBeNull();
  });

  it("点击调用拆解", () => {
    const handlers = renderView();
    fireEvent.click(screen.getByText("拆成子任务"));
    expect(handlers.onDecompose).toHaveBeenCalledTimes(1);
  });

  it("拆解中按钮文案变化", () => {
    renderView({ busy: "decompose" });
    expect(screen.getByText("拆解中…")).toBeTruthy();
  });

  it("失败时回显后端原文", () => {
    renderView({
      decompose: { ok: false, message: "auxiliary model unavailable", childIds: [], newTitle: null },
    });
    expect(screen.getByText("auxiliary model unavailable")).toBeTruthy();
  });

  it("成功时列出子任务 id", () => {
    renderView({
      decompose: { ok: true, message: "已拆出 2 个子任务", childIds: ["t_1", "t_2"], newTitle: null },
    });
    expect(screen.getByText("子任务：t_1、t_2")).toBeTruthy();
  });
});

describe("TaskOrchestration 重派与附件", () => {
  it("重派带 profile 与回收开关", () => {
    const handlers = renderView();
    fireEvent.change(screen.getByLabelText("选择目标 profile"), { target: { value: "reviewer" } });
    fireEvent.click(screen.getByLabelText("先回收占用"));
    fireEvent.click(screen.getByRole("button", { name: "重派" }));
    expect(handlers.onReassign).toHaveBeenCalledWith("reviewer", true);
  });

  it("没有 profile 列表时优雅提示，不渲染选择框", () => {
    renderView({ profiles: [] });
    expect(screen.getByText("内核没有返回 profile 列表，暂时不能重派。")).toBeTruthy();
    expect(screen.queryByLabelText("选择目标 profile")).toBeNull();
  });

  it("重派失败原文展示", () => {
    renderView({ error: "HTTP 409: still running" });
    expect(screen.getByText("HTTP 409: still running")).toBeTruthy();
  });

  it("附件列表带大小，删除回调", () => {
    const handlers = renderView();
    expect(screen.getByText("附件 · 1 个")).toBeTruthy();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("删除附件 log.txt"));
    expect(handlers.onDeleteAttachment).toHaveBeenCalledWith(12);
  });

  it("上传触发回调并带文件", () => {
    const handlers = renderView();
    const input = screen.getByLabelText("上传附件") as HTMLInputElement;
    const file = new File(["hello"], "note.md", { type: "text/markdown" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(handlers.onUploadAttachment).toHaveBeenCalledWith(file);
  });

  it("没附件时给空态与上限说明", () => {
    renderView({ detail: detail({ attachments: [] }) });
    expect(screen.getByText("还没有附件。")).toBeTruthy();
    expect(screen.getByText(/单个附件上限 25 MB/)).toBeTruthy();
  });
});
