// @vitest-environment jsdom
import ReactDOMServer from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { CliDelegationEntry } from "@/stores/cli-delegations";
import type { SubagentProgress } from "@/stores/subagents";
import { CliDelegationDetails, SubagentPanel } from "./subagent-panel";

afterEach(() => cleanup());

function entry(overrides: Partial<CliDelegationEntry> = {}): CliDelegationEntry {
  return {
    id: "delegation-1",
    agent: "codex",
    origin: "events",
    execution: "foreground",
    status: "completed",
    promptExcerpt: "测试委派详情",
    startedAt: 1,
    outputTail: "",
    timeline: [],
    ...overrides,
  };
}

describe("CliDelegationDetails", () => {
  it("将会话、目录和 Token 渲染为三个独立复制行", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <CliDelegationDetails
        entry={entry({
          workdir: "/private/var/folders/a/very-long-work-directory",
          result: {
            sessionId: "019fa674-7d3e-7530-b7ba-3995815e6988",
            totalTokens: 31_040,
          },
        })}
        running={false}
      />,
    );

    expect(html.match(/data-cli-detail-row=/g)).toHaveLength(3);
    expect(html.match(/data-copyable="true"/g)).toHaveLength(3);
    expect(html).toContain("会话");
    expect(html).toContain("目录");
    expect(html).toContain("Token");
    expect(html).toContain("31.0k");
    expect(html).toContain("点击复制会话");
    expect(html).toContain("点击复制目录");
    expect(html).toContain("点击复制Token");
  });

  it("运行中缺失的数据仍占三行但不可复制", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <CliDelegationDetails entry={entry({ status: "running" })} running />,
    );

    expect(html.match(/data-cli-detail-row=/g)).toHaveLength(3);
    expect(html.match(/data-copyable="false"/g)).toHaveLength(3);
    expect(html).toContain("获取中");
    expect(html).toContain("统计中");
    expect(html).not.toContain("点击复制");
  });
});

function sub(overrides: Partial<SubagentProgress> = {}): SubagentProgress {
  return {
    id: "sub-1",
    parentId: null,
    goal: "审计 host-hub 接口",
    model: "deepseek-v4.1-flash",
    status: "running",
    taskCount: 1,
    taskIndex: 0,
    startedAt: 1_000,
    updatedAt: Date.now(),
    toolCount: 3,
    filesRead: [],
    filesWritten: [],
    stream: [{ at: 1, kind: "tool", text: 'Grep("鉴权中间件")' }],
    ...overrides,
  };
}

const rowIds = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll("[data-subagent-row]")).map(
    (node) => node.getAttribute("data-subagent-row") ?? "",
  );

describe("子任务监视面板", () => {
  it("顶部汇总条按运行中/完成/失败计数", () => {
    render(
      <SubagentPanel
        subagents={[
          sub({ id: "a" }),
          sub({ id: "b" }),
          sub({ id: "c", status: "completed" }),
          sub({ id: "d", status: "failed" }),
        ]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /运行中 2/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /完成 1/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /失败 1/ })).toBeTruthy();
  });

  it("排序：运行中在前，其次失败，再按派发时间", () => {
    const { container } = render(
      <SubagentPanel
        subagents={[
          sub({ id: "done", status: "completed", startedAt: 100 }),
          sub({ id: "live", status: "running", startedAt: 900 }),
          sub({ id: "boom", status: "failed", startedAt: 500 }),
        ]}
        onClose={vi.fn()}
      />,
    );

    expect(rowIds(container)).toEqual(["live", "boom", "done"]);
  });

  it("点汇总条筛选，再点一次回到全部", () => {
    const { container } = render(
      <SubagentPanel
        subagents={[
          sub({ id: "live", status: "running" }),
          sub({ id: "boom", status: "failed" }),
        ]}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /失败 1/ }));
    expect(rowIds(container)).toEqual(["boom"]);

    fireEvent.click(screen.getByRole("button", { name: /失败 1/ }));
    expect(rowIds(container)).toEqual(["live", "boom"]);
  });

  it("每条显示目标、模型、耗时、工具数与最后一行输出", () => {
    render(<SubagentPanel subagents={[sub()]} onClose={vi.fn()} />);

    expect(screen.getByText("审计 host-hub 接口")).toBeTruthy();
    expect(screen.getByText(/deepseek-v4\.1-flash/)).toBeTruthy();
    expect(screen.getByText(/3 次工具/)).toBeTruthy();
    expect(screen.getByText(/Grep\("鉴权中间件"\)/)).toBeTruthy();
  });

  it("点一条打开运行情况弹窗", () => {
    render(<SubagentPanel subagents={[sub()]} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /审计 host-hub 接口/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("3 次工具调用")).toBeTruthy();
  });

  it("空态说明没有子代理，并提示派发方式", () => {
    render(<SubagentPanel subagents={[]} onClose={vi.fn()} />);

    expect(screen.getByText("当前会话没有子代理")).toBeTruthy();
    expect(screen.getByText(/delegate_task/)).toBeTruthy();
  });

  it("每张任务卡按跑中/卡住/完成/失败给状态文案", () => {
    render(
      <SubagentPanel
        subagents={[
          sub({ id: "live", status: "running", updatedAt: Date.now() }),
          sub({ id: "stuck", status: "running", goal: "卡住的任务", updatedAt: Date.now() - 120_000 }),
          sub({ id: "done", status: "completed" }),
          sub({ id: "boom", status: "failed" }),
        ]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("跑中")).toBeTruthy();
    expect(screen.getByText("卡住")).toBeTruthy();
    expect(screen.getByText("完成")).toBeTruthy();
    expect(screen.getByText("失败")).toBeTruthy();
  });

  it("有子任务时显示 N/M 进度，没有则整个进度位隐藏", () => {
    const { container } = render(
      <SubagentPanel subagents={[sub({ id: "solo" })]} onClose={vi.fn()} />,
    );
    expect(container.textContent).not.toMatch(/\d+\/\d+/);

    cleanup();
    const tree = render(
      <SubagentPanel
        subagents={[
          sub({ id: "parent", goal: "父任务" }),
          sub({ id: "c1", parentId: "parent", status: "completed", goal: "子任务一" }),
          sub({ id: "c2", parentId: "parent", status: "running", goal: "子任务二" }),
        ]}
        onClose={vi.fn()}
      />,
    );
    expect(tree.getByLabelText("子任务进度 1/2")).toBeTruthy();
  });

  it("「查看详情」按钮打开运行情况弹窗", () => {
    render(<SubagentPanel subagents={[sub()]} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "查看详情" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("「在看板里打开」入口没接数据时不渲染，接了才出现", () => {
    const { unmount } = render(<SubagentPanel subagents={[sub()]} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "在看板里打开" })).toBeNull();
    unmount();

    const onOpenInBoard = vi.fn();
    render(<SubagentPanel subagents={[sub()]} onClose={vi.fn()} onOpenInBoard={onOpenInBoard} />);
    fireEvent.click(screen.getByRole("button", { name: "在看板里打开" }));
    expect(onOpenInBoard).toHaveBeenCalledTimes(1);
  });

  it("中断按钮只在有 subagent_id 且仍在跑时出现", () => {
    const onInterrupt = vi.fn();
    render(
      <SubagentPanel
        subagents={[sub({ id: "live", subagentId: "kernel-1" })]}
        onClose={vi.fn()}
        onInterrupt={onInterrupt}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "中断" }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);

    cleanup();
    render(
      <SubagentPanel
        subagents={[sub({ id: "fallback", status: "running" })]}
        onClose={vi.fn()}
        onInterrupt={onInterrupt}
      />,
    );
    expect(screen.queryByRole("button", { name: "中断" })).toBeNull();
  });
});
