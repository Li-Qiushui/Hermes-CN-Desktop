// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TaskDrawer } from "./task-drawer";
import type { KanbanTask, KanbanTaskDetailResponse } from "@/lib/kanban";

afterEach(() => cleanup());

vi.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownText: ({ text }: { text: string }) => <div data-markdown="true">{text}</div>,
}));

const baseTask: KanbanTask = {
  id: "t_f40272a6",
  title: "抽屉四块验证",
  status: "blocked",
  assignee: null,
  priority: 2,
  created_at: 1792500000,
  latest_summary: "最新进展文本",
  block_kind: "dependency",
  age: { created_age_seconds: 600 },
};

function detailOf(overrides: Partial<KanbanTaskDetailResponse> = {}): KanbanTaskDetailResponse {
  return {
    task: baseTask,
    comments: [
      { id: 114, task_id: "t_f40272a6", author: "default", body: "BLOCKED: 补入 desktop 渠道需求，重派", created_at: 1792504163 },
    ],
    events: Array.from({ length: 25 }, (_, index) => ({
      id: 3200 + index,
      task_id: "t_f40272a6",
      kind: index === 0 ? "created" : "status",
      payload: { status: "ready" },
      created_at: 1792500000 + index,
    })),
    runs: [
      {
        id: 261,
        task_id: "t_f40272a6",
        status: "blocked",
        outcome: "blocked",
        started_at: 1792504078,
        summary: "补入 desktop 渠道需求",
      },
    ],
    attachments: [],
    ...overrides,
  };
}

const logText = Array.from({ length: 250 }, (_, index) => `log-line-${index}`).join("\n");

function renderDrawer(props: Partial<Parameters<typeof TaskDrawer>[0]> = {}) {
  const onAddComment = vi.fn();
  const onClose = vi.fn();
  render(
    <TaskDrawer
      open
      task={baseTask}
      detail={detailOf()}
      diagnostics={[
        { kind: "stale_run", severity: "warning", message: "任务 30 分钟没有动静", suggestion: "手动重派" },
      ]}
      log={{ task_id: "t_f40272a6", exists: true, size_bytes: 46696, content: logText, truncated: true }}
      loading={false}
      error={null}
      columns={[
        { key: "todo", label: "待办" },
        { key: "blocked", label: "阻塞" },
      ]}
      assignees={[]}
      saving={false}
      onClose={onClose}
      onSave={() => {}}
      onAddComment={onAddComment}
      {...props}
    />,
  );
  return { onAddComment, onClose };
}

describe("TaskDrawer 四块", () => {
  it("顶部诊断 callout 给文案与建议，不自动执行", () => {
    renderDrawer();
    const callout = screen.getByLabelText("诊断");
    expect(callout.textContent).toContain("诊断 · 1 条");
    expect(callout.textContent).toContain("任务 30 分钟没有动静");
    expect(callout.textContent).toContain("建议：手动重派（需手动处理）");
  });

  it("评论读取 + 空态 + 发表", () => {
    renderDrawer();
    expect(screen.getByText("评论 · 1 条")).toBeTruthy();
    expect(screen.getByText("BLOCKED: 补入 desktop 渠道需求，重派")).toBeTruthy();
    expect(screen.getByText("default")).toBeTruthy();
  });

  it("没有评论时显示空态", () => {
    renderDrawer({ detail: detailOf({ comments: [] }) });
    expect(screen.getByText("还没有评论")).toBeTruthy();
  });

  it("输入评论点发表会回调 onAddComment", () => {
    const { onAddComment } = renderDrawer();
    const input = screen.getByLabelText("评论内容");
    fireEvent.change(input, { target: { value: "手动补一条" } });
    fireEvent.click(screen.getByText("发表评论"));
    expect(onAddComment).toHaveBeenCalledWith("手动补一条");
  });

  it("评论发表成功后清空草稿", async () => {
    renderDrawer({ onAddComment: async () => true });
    const input = screen.getByLabelText("评论内容") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "补一条进展" } });
    await act(async () => {
      fireEvent.click(screen.getByText("发表评论"));
      await Promise.resolve();
    });
    expect(input.value).toBe("");
  });

  it("评论发表失败时保留草稿", async () => {
    renderDrawer({ onAddComment: async () => false });
    const input = screen.getByLabelText("评论内容") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "补一条进展" } });
    await act(async () => {
      fireEvent.click(screen.getByText("发表评论"));
      await Promise.resolve();
    });
    expect(input.value).toBe("补一条进展");
  });

  it("活动与运行按时间倒序，先显示 20 条可展开", () => {
    renderDrawer();
    expect(screen.getByText("活动与运行 · 26 条")).toBeTruthy();
    expect(screen.getByText("运行 #261 · blocked")).toBeTruthy();
    const list = screen.getByLabelText("活动与运行").querySelectorAll("li");
    expect(list).toHaveLength(20);

    fireEvent.click(screen.getByText("展开全部 26 条"));
    expect(screen.getByLabelText("活动与运行").querySelectorAll("li")).toHaveLength(26);
    expect(screen.getByText("只看最近 20 条")).toBeTruthy();
  });

  it("日志尾默认折叠，展开后只显示末尾 200 行", () => {
    renderDrawer();
    expect(screen.queryByText(/log-line-249/)).toBeNull();
    fireEvent.click(screen.getByText("日志尾"));
    const pre = screen.getByLabelText("日志尾").querySelector("pre");
    expect(pre?.textContent?.startsWith("log-line-50")).toBe(true);
    expect(pre?.textContent?.endsWith("log-line-249")).toBe(true);
    expect(screen.getByText("仅显示末尾 200 行（隐藏 50 行）")).toBeTruthy();
    expect(screen.getByText(/46696 字节/)).toBeTruthy();
  });

  it("没有 run 时不渲染日志尾", () => {
    renderDrawer({ detail: detailOf({ runs: [] }), log: null });
    expect(screen.queryByText("日志尾")).toBeNull();
  });
  it("没有编排回调时不渲染编排区（端点缺失时优雅隐藏）", () => {
    renderDrawer();
    expect(screen.queryByLabelText("编排")).toBeNull();
  });

  it("带编排回调时渲染依赖/阻塞/重派/附件，且诊断动作可点", () => {
    const onDiagnosticAction = vi.fn();
    renderDrawer({
      profiles: ["writer"],
      detail: detailOf({
        links: { parents: ["t_parent"], children: [] },
        link_tasks: [{ id: "t_parent", title: "前置卡", status: "done" }],
        attachments: [{ id: 3, task_id: "t_f40272a6", filename: "a.txt", size: 10 }],
      }),
      diagnostics: [
        {
          kind: "completion_blocked_hallucination",
          severity: "error",
          title: "完成被拒",
          detail: "引用了不存在的卡",
          data: { phantom_ids: ["t_dead"] },
          actions: [{ kind: "reclaim", label: "回收任务", payload: {} }],
        },
      ],
      onBlock: vi.fn(),
      onUnblock: vi.fn(),
      onAddLink: vi.fn(),
      onRemoveLink: vi.fn(),
      onReassign: vi.fn(),
      onDecompose: vi.fn(),
      onUploadAttachment: vi.fn(),
      onDeleteAttachment: vi.fn(),
      onDiagnosticAction,
    });
    const orchestration = screen.getByLabelText("编排");
    expect(orchestration.textContent).toContain("前置卡");
    expect(orchestration.textContent).toContain("重派");
    expect(orchestration.textContent).toContain("a.txt");

    const callout = screen.getByLabelText("诊断");
    expect(callout.textContent).toContain("完成被拒");
    expect(callout.textContent).toContain("t_dead");
    fireEvent.click(screen.getByText("回收任务"));
    expect(onDiagnosticAction).toHaveBeenCalledWith("reclaim", {});
  });
});
