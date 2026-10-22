// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { TaskCard } from "./task-card";
import type { KanbanTask } from "@/lib/kanban";

afterEach(() => cleanup());

function baseTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "t_1",
    title: "补齐卡片字段",
    status: "todo",
    assignee: "LiQiushui",
    priority: 2,
    comment_count: 3,
    link_counts: { children: 4, parents: 0 },
    age: { created_age_seconds: 7200 },
    ...overrides,
  };
}

function renderCard(task: KanbanTask, props: Partial<Parameters<typeof TaskCard>[0]> = {}) {
  const onOpen = vi.fn();
  const onToggleSelect = vi.fn();
  render(
    <DndContext>
      <TaskCard
        task={task}
        selected={false}
        draggable
        onOpen={onOpen}
        onToggleSelect={onToggleSelect}
        {...props}
      />
    </DndContext>,
  );
  return { onOpen, onToggleSelect };
}

describe("TaskCard 字段补全", () => {
  it("渲染 summary、进度、评论数、子任务数", () => {
    renderCard(
      baseTask({ latest_summary: "已经接上事件流，正在补抽屉", progress: { done: 2, total: 5 } }),
    );
    expect(screen.getByText("已经接上事件流，正在补抽屉")).toBeTruthy();
    expect(screen.getByText("2/5")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("P2")).toBeTruthy();
  });

  it("运行中显示 RunClock，其它状态不显示", () => {
    const now = Math.floor(Date.now() / 1000);
    const running = render(
      <DndContext>
        <TaskCard
          task={baseTask({ status: "running", current_run_started_at: now - 12 })}
          selected={false}
          draggable
          onOpen={() => {}}
        />
      </DndContext>,
    );
    expect(running.container.querySelector("[data-run-clock='true']")).toBeTruthy();
    running.unmount();

    const idle = render(
      <DndContext>
        <TaskCard
          task={baseTask({ status: "ready", current_run_started_at: now - 12 })}
          selected={false}
          draggable
          onOpen={() => {}}
        />
      </DndContext>,
    );
    expect(idle.container.querySelector("[data-run-clock='true']")).toBeNull();
  });

  it("blocked 卡显示原因角标，未指派显示提示", () => {
    renderCard(baseTask({ status: "blocked", block_reason: "等父任务完成", assignee: null }));
    expect(screen.getByText("等父任务完成")).toBeTruthy();
    const chip = screen.getByText("未指派");
    expect(chip.getAttribute("data-unassigned")).toBe("true");
  });

  it("普通点击打开抽屉，Ctrl/Cmd 点击切换多选", () => {
    const { onOpen, onToggleSelect } = renderCard(baseTask());
    const card = screen.getByLabelText(/补齐卡片字段/);
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledWith("t_1");
    expect(onToggleSelect).not.toHaveBeenCalled();

    fireEvent.click(card, { ctrlKey: true });
    expect(onToggleSelect).toHaveBeenCalledWith("t_1");
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.click(card, { metaKey: true });
    expect(onToggleSelect).toHaveBeenCalledTimes(2);
  });
});
