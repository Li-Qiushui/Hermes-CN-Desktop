// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { GatewayRpcError } from "@/lib/gateway-result";
import { subagentsBySessionAtom, type SubagentProgress } from "@/stores/subagents";
import {
  DelegateRunCard,
  DelegateRunCardView,
  type DelegateRunCardViewProps,
} from "./delegate-run-card";
import type { ChatToolItem } from "./chat-types";
import {
  buildDelegateRows,
  canInterruptRow,
  dedupeRowActivity,
  delegateGoals,
  sanitizeActivityLine,
  sharedActivitySummary,
  tickerLines,
  type DelegateCallInput,
  type DelegateRunRow,
} from "./delegate-run-model";

afterEach(() => cleanup());

const NOW = 100_000;
const TOOL_ID = "call_delegate_1";

function call(overrides: Partial<DelegateCallInput> = {}): DelegateCallInput {
  return {
    args: { tasks: [{ goal: "审计 host-hub 接口" }] },
    streaming: true,
    startedAt: 10_000,
    status: "running",
    now: NOW,
    toolCallId: TOOL_ID,
    ...overrides,
  };
}

function live(overrides: Partial<SubagentProgress> = {}): SubagentProgress {
  return {
    id: "sub-1",
    parentId: "parent-session",
    subagentId: "sub-1",
    goal: "审计 host-hub 接口",
    model: "deepseek-v4.1-flash",
    status: "running",
    taskCount: 1,
    taskIndex: 0,
    startedAt: 10_500,
    updatedAt: NOW - 1_000,
    filesRead: [],
    filesWritten: [],
    stream: [],
    ...overrides,
  };
}

function rowsFor(opts: { live?: SubagentProgress[]; call?: Partial<DelegateCallInput> } = {}): DelegateRunRow[] {
  return buildDelegateRows(call(opts.call), opts.live ?? []);
}

function renderView(props: Partial<DelegateRunCardViewProps> & { rows: DelegateRunRow[] }) {
  return render(<DelegateRunCardView now={NOW} {...props} />);
}

const byRowId = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll("[data-delegate-row]")).map(
    (node) => node.getAttribute("data-delegate-row") ?? "",
  );

const hasSpinner = (container: HTMLElement): boolean =>
  container.querySelector('[data-tone="run"]') !== null;

describe("delegate 运行卡：四态渲染", () => {
  it("运行中：标题、模型、状态、耗时与 ticker 尾部", () => {
    const rows = rowsFor({
      live: [
        live({
          stream: Array.from({ length: 7 }, (_, index) => ({
            at: index,
            kind: "tool" as const,
            text: `Grep("第 ${index + 1} 次检索")`,
          })),
        }),
      ],
    });

    const { container } = renderView({ rows, onInterrupt: vi.fn() });

    expect(screen.getByText("审计 host-hub 接口")).toBeTruthy();
    expect(screen.getByText("deepseek-v4.1-flash")).toBeTruthy();
    expect(container.querySelector('[data-delegate-row="sub-1"]')?.getAttribute("data-status")).toBe("running");
    expect(screen.getByText(/运行中/)).toBeTruthy();
    expect(hasSpinner(container)).toBe(true);
    // ticker 只吃尾部 5 行：最早的两行不该出现在折叠态里。
    expect(screen.queryByText(/第 1 次检索/)).toBeNull();
    expect(screen.queryByText(/第 2 次检索/)).toBeNull();
    expect(screen.getByText(/第 7 次检索/)).toBeTruthy();
  });

  it("完成：绿勾、无 spinner、耗时取内核回报值", () => {
    const rows = rowsFor({
      call: { streaming: false, status: "done", completedAt: 20_000 },
      live: [live({ status: "completed", durationSeconds: 42, stream: [{ at: 1, kind: "summary", text: "两个接口都跑通了" }] })],
    });

    const { container } = renderView({ rows });

    expect(container.querySelector('[data-delegate-row="sub-1"]')?.getAttribute("data-status")).toBe("completed");
    expect(screen.getByText(/已完成 42s/)).toBeTruthy();
    expect(hasSpinner(container)).toBe(false);
    expect(container.querySelector('[data-tone="ok"]')).not.toBeNull();
    expect(screen.getByText(/两个接口都跑通了/)).toBeTruthy();
  });

  it("失败：红标、卡片描边转错误色", () => {
    const rows = rowsFor({
      call: { streaming: false, status: "error", error: "子代理超时", completedAt: 30_000 },
      live: [live({ status: "failed", summary: "超时" })],
    });

    const { container } = renderView({ rows });

    expect(container.querySelector("[data-delegate-card]")?.getAttribute("data-status")).toBe("failed");
    expect(screen.getByText(/失败/)).toBeTruthy();
    expect(container.querySelector('[data-tone="err"]')).not.toBeNull();
  });

  it("中断：内核报 interrupted，或回合收尾而子代理没终态，都不假装完成", () => {
    const liveInterrupted = rowsFor({
      call: { streaming: false, status: "running" },
      live: [live({ status: "interrupted" })],
    });
    const { container } = renderView({ rows: liveInterrupted });

    expect(container.querySelector('[data-delegate-row="sub-1"]')?.getAttribute("data-status")).toBe("interrupted");
    expect(screen.getByText(/^已中断/)).toBeTruthy();
    expect(hasSpinner(container)).toBe(false);

    cleanup();
    // 没有 store 行、工具也没收尾，但主回合已经结束：事件流断了。
    const orphan = rowsFor({ call: { streaming: false, status: "running", args: { tasks: [{ goal: "断线的子任务" }] } } });
    const second = renderView({ rows: orphan });
    expect(second.container.querySelector("[data-delegate-row]")?.getAttribute("data-status")).toBe("interrupted");
  });

  it("后台存活（dispatched）：静止点、说明文案，绝不转 spinner", () => {
    const rows = rowsFor({
      call: { streaming: false, status: "done", completedAt: 20_000 },
      live: [live({ status: "running", updatedAt: NOW - 60_000 })],
    });

    const { container } = renderView({ rows });

    expect(container.querySelector('[data-delegate-row="sub-1"]')?.getAttribute("data-status")).toBe("dispatched");
    expect(screen.getByText(/^后台运行/)).toBeTruthy();
    expect(screen.getByText(/回合已结束，子代理仍在后台运行/)).toBeTruthy();
    expect(hasSpinner(container)).toBe(false);
  });
});

describe("delegate 运行卡：并行排序", () => {
  it("两个并行子代理按派发时间排序，晚派的在下面", () => {
    const rows = buildDelegateRows(
      call({
        args: { tasks: [{ goal: "先派的任务" }, { goal: "后派的任务" }] },
      }),
      [
        live({ id: "sub-late", subagentId: "sub-late", goal: "后派的任务", taskIndex: 1, startedAt: 30_000 }),
        live({ id: "sub-early", subagentId: "sub-early", goal: "先派的任务", taskIndex: 0, startedAt: 12_000 }),
      ],
    );

    const { container } = renderView({ rows });

    expect(byRowId(container)).toEqual(["sub-early", "sub-late"]);
    expect(screen.getByText(/2 个并行子任务/)).toBeTruthy();
  });

  it("内核回退行按 delegate-tool:<toolId>: 精确认领，不串到别的派发", () => {
    const rows = buildDelegateRows(call(), [
      live({ id: "delegate-tool:call_delegate_1:0", subagentId: undefined, goal: "审计 host-hub 接口" }),
      live({ id: "delegate-tool:call_other:0", subagentId: undefined, goal: "别的派发" }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("delegate-tool:call_delegate_1:0");
  });

  it("没有 args（live tool.start 只带 context）时退回 store 行，且仅在唯一卡片时按时间窗认领", () => {
    const liveRows = [
      live({ id: "sub-a", subagentId: "sub-a", goal: "甲", taskIndex: 0, startedAt: 12_000 }),
      live({ id: "sub-b", subagentId: "sub-b", goal: "乙", taskIndex: 1, startedAt: 13_000 }),
    ];

    const claimed = buildDelegateRows(call({ args: undefined, claimUnlinked: true }), liveRows);
    expect(claimed.map((row) => row.id)).toEqual(["sub-a", "sub-b"]);

    const refused = buildDelegateRows(call({ args: undefined, claimUnlinked: false }), liveRows);
    expect(refused).toHaveLength(0);
  });

  it("没有子任务目标也没有 store 行时不出卡", () => {
    expect(buildDelegateRows(call({ args: undefined }), [])).toEqual([]);
  });
});

describe("delegate 运行卡：展开完整日志", () => {
  it("折叠态只有 ticker，点开展开全部日志行", () => {
    const lines = Array.from({ length: 8 }, (_, index) => `步骤 ${index + 1}`);
    const rows = rowsFor({
      live: [live({ stream: lines.map((text, index) => ({ at: index, kind: "tool" as const, text })) })],
    });

    const { container } = renderView({ rows });

    expect(container.querySelector("[data-delegate-log]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开完整日志" }));

    const log = container.querySelector("[data-delegate-log]");
    expect(log).not.toBeNull();
    for (const line of lines) expect(log!.textContent).toContain(line);
    expect(screen.getByRole("button", { name: "收起日志" })).toBeTruthy();
  });

  it("没有日志行时展开给出缺数据说明，而不是空白", () => {
    const rows = rowsFor({ live: [live({ stream: [] })] });
    const { container } = renderView({ rows, defaultLogOpen: true });

    expect(container.querySelector("[data-delegate-log]")?.textContent).toContain("暂无日志行");
  });
});

describe("delegate 运行卡：中断按钮只在真能停时出现", () => {
  it("原生 subagent_id + 运行中 → 有按钮，点击回调一次", () => {
    const onInterrupt = vi.fn();
    const rows = rowsFor({ live: [live({ status: "running" })] });
    expect(canInterruptRow(rows[0]!)).toBe(true);

    render(<DelegateRunCardView rows={rows} now={NOW} onInterrupt={onInterrupt} />);
    fireEvent.click(screen.getByRole("button", { name: "中断" }));

    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onInterrupt.mock.calls[0]![0].subagentId).toBe("sub-1");
  });

  it("delegate_task 兜底行没有 subagent_id → 没有按钮", () => {
    const rows = buildDelegateRows(call(), [
      live({ id: `delegate-tool:${TOOL_ID}:0`, subagentId: undefined, status: "running" }),
    ]);

    render(<DelegateRunCardView rows={rows} now={NOW} onInterrupt={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "中断" })).toBeNull();
  });

  it("已结束的行 → 没有按钮", () => {
    const rows = rowsFor({ live: [live({ status: "completed", durationSeconds: 12 })] });

    render(<DelegateRunCardView rows={rows} now={NOW} onInterrupt={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "中断" })).toBeNull();
  });

  it("中断进行中：按钮禁用并显示中断中…", () => {
    const onInterrupt = vi.fn();
    const rows = rowsFor({ live: [live({ status: "running" })] });

    render(<DelegateRunCardView rows={rows} now={NOW} interruptingId="sub-1" onInterrupt={onInterrupt} />);
    const button = screen.getByRole("button", { name: "中断中…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it("「查看运行情况」开弹窗，不直接跳页；跳页是弹窗里的次要按钮", () => {
    const onOpenInPage = vi.fn();
    const rows = rowsFor({ live: [live({ childSessionId: "child-sess-9" })] });
    render(<DelegateRunCardView rows={rows} now={NOW} onOpenInPage={onOpenInPage} />);

    fireEvent.click(screen.getByRole("button", { name: "查看运行情况" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onOpenInPage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "在页面中打开" }));
    expect(onOpenInPage).toHaveBeenCalledWith("child-sess-9");
  });

  it("没有子会话 id 时「在页面中打开」禁用，运行情况照常可看", () => {
    const onOpenInPage = vi.fn();
    const rows = rowsFor({ live: [live()] });
    render(<DelegateRunCardView rows={rows} now={NOW} onOpenInPage={onOpenInPage} />);

    fireEvent.click(screen.getByRole("button", { name: "查看运行情况" }));
    const jump = screen.getByRole("button", { name: "在页面中打开" }) as HTMLButtonElement;
    expect(jump.disabled).toBe(true);
    fireEvent.click(jump);
    expect(onOpenInPage).not.toHaveBeenCalled();
  });
});

const delegateTool = {
  tool_id: TOOL_ID,
  name: "delegate_task",
  status: "running",
  startedAt: 10_000,
  arguments: { tasks: [{ goal: "审计 host-hub 接口" }] },
} as unknown as ChatToolItem;

function renderCard(onSteer: (row: DelegateRunRow, text: string) => Promise<unknown>) {
  const store = createStore();
  store.set(subagentsBySessionAtom, { "sess-1": [live()] });
  return render(
    <Provider store={store}>
      <MemoryRouter>
        <DelegateRunCard
          tool={delegateTool}
          sessionIds={["sess-1"]}
          streaming
          now={NOW}
          onInterrupt={vi.fn()}
          onSteer={onSteer}
        />
      </MemoryRouter>
    </Provider>,
  );
}

async function typeAndSendSteer(text: string) {
  fireEvent.click(screen.getByRole("button", { name: "插话" }));
  const input = screen.getByPlaceholderText("给子代理补一句，不会打断它") as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  return input;
}

describe("delegate 运行卡：插话", () => {
  it("没有注入 onSteer 时不出插话按钮，中断照旧", () => {
    const rows = rowsFor({ live: [live({ status: "running" })] });

    renderView({ rows, onInterrupt: vi.fn() });

    expect(screen.queryByRole("button", { name: "插话" })).toBeNull();
    expect(screen.getByRole("button", { name: "中断" })).toBeTruthy();
  });

  it("已结束的行不出插话按钮", () => {
    const rows = rowsFor({ live: [live({ status: "completed", durationSeconds: 12 })] });

    renderView({ rows, onInterrupt: vi.fn(), onSteer: vi.fn() });

    expect(screen.queryByRole("button", { name: "插话" })).toBeNull();
  });

  it("queued：提交后清空并收起，提示下个批次会看到", async () => {
    const onSteer = vi.fn().mockResolvedValue({ status: "queued" });
    renderCard(onSteer);

    await typeAndSendSteer("先只跑 read 的工具");

    await waitFor(() => expect(onSteer).toHaveBeenCalledTimes(1));
    expect(onSteer.mock.calls[0]![1]).toBe("先只跑 read 的工具");
    expect((onSteer.mock.calls[0]![0] as DelegateRunRow).subagentId).toBe("sub-1");
    expect(screen.getByText("已排队，子代理下个批次会看到")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("给子代理补一句，不会打断它")).toBeNull(),
    );
  });

  it("rejected：提示已不接受插话，输入保留", async () => {
    const onSteer = vi.fn().mockResolvedValue({ status: "rejected" });
    renderCard(onSteer);

    const input = await typeAndSendSteer("再补一句");

    await waitFor(() => expect(screen.getByText("子代理已不接受插话")).toBeTruthy());
    expect(input.value).toBe("再补一句");
  });

  it("unsupported-method：走 classifyGatewayError 给能力提示", async () => {
    const onSteer = vi
      .fn()
      .mockRejectedValue(
        new GatewayRpcError("unknown method: subagent.steer", { method: "subagent.steer", code: -32601 }),
      );
    renderCard(onSteer);

    await typeAndSendSteer("老内核");

    await waitFor(() => expect(screen.getByText("当前内核不支持子代理插话")).toBeTruthy());
  });

  it("空内容不发请求", async () => {
    const onSteer = vi.fn().mockResolvedValue({ status: "queued" });
    renderCard(onSteer);

    fireEvent.click(screen.getByRole("button", { name: "插话" }));
    const input = screen.getByPlaceholderText("给子代理补一句，不会打断它") as HTMLInputElement;
    const submit = screen.getByRole("button", { name: "发送" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "   " } });
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSteer).not.toHaveBeenCalled();
  });
});

describe("delegate 运行卡模型", () => {
  it("目标解析兼容单任务与 tasks 数组", () => {
    expect(delegateGoals({ goal: "单任务" })).toEqual(["单任务"]);
    expect(delegateGoals({ tasks: [{ goal: "甲" }, {}] })).toEqual(["甲", "子任务 2"]);
    expect(delegateGoals(undefined)).toEqual([]);
  });

  it("ticker 只取尾部 N 行", () => {
    const rows = rowsFor({
      live: [live({ stream: Array.from({ length: 9 }, (_, i) => ({ at: i, kind: "tool" as const, text: `行${i}` })) })],
    });
    expect(tickerLines(rows[0]!, 3)).toEqual(["行6", "行7", "行8"]);
    expect(tickerLines(rows[0]!)).toHaveLength(5);
  });
});

describe("delegate 运行卡：派发结果不再铺原始 JSON", () => {
  const RAW_DISPATCH = JSON.stringify({
    status: "dispatched",
    mode: "background",
    count: 2,
    delegation_id: "deleg_cdf50a36",
    goals: ["把 host-hub 的三端接口全量审计一遍，逐条列出鉴权缺口与补丁方案".repeat(6)],
  });

  const rowsWithSummary = (summary: string, goals: string[]): DelegateRunRow[] =>
    buildDelegateRows(
      call({ args: { tasks: goals.map((goal) => ({ goal })) }, status: "done", streaming: false, completedAt: 20_000, summary }),
      [],
    );

  it("JSON 行压成一句中文摘要，goals 原文不外泄", () => {
    const rows = rowsWithSummary(RAW_DISPATCH, ["审计接口"]);
    const { container } = renderView({ rows });

    expect(container.textContent).toContain("已派发 2 个子任务 · deleg_cdf50a36");
    expect(container.textContent).not.toContain("\"goals\"");
    expect(container.textContent).not.toContain("逐条列出鉴权缺口");
  });

  it("被上游截断的 JSON 仍按 key 兜底出摘要", () => {
    const truncated = RAW_DISPATCH.slice(0, 400);
    const rows = rowsWithSummary(truncated, ["审计接口"]);
    const { container } = renderView({ rows });

    expect(container.textContent).toContain("已派发 2 个子任务 · deleg_cdf50a36");
    expect(container.textContent).not.toContain("逐条列出鉴权缺口");
  });

  it("非 JSON 长行截断到 120 字符，尾部省略号", () => {
    const long = "很长的进度".repeat(60);
    const line = sanitizeActivityLine(long);
    expect(line.length).toBe(120);
    expect(line.endsWith("…")).toBe(true);
    expect(sanitizeActivityLine("  Grep(\"ok\")  ")).toBe("Grep(\"ok\")");
  });

  it("同一个派发摘要在多行出现时只保留一次，并提到组头", () => {
    const rows = rowsWithSummary(RAW_DISPATCH, ["审计接口", "清日志"]);
    expect(rows).toHaveLength(2);

    const lines = dedupeRowActivity(rows);
    expect(lines.flat().filter((line) => line.includes("已派发"))).toHaveLength(1);
    expect(sharedActivitySummary(rows)).toBe("已派发 2 个子任务 · deleg_cdf50a36");

    const { container } = renderView({ rows });
    const occurrences = Array.from(container.querySelectorAll("[data-delegate-summary]")).map(
      (node) => node.textContent,
    );
    expect(occurrences).toEqual(["已派发 2 个子任务 · deleg_cdf50a36"]);
    expect(container.textContent!.match(/已派发 2 个子任务/g)).toHaveLength(1);
  });

  it("展开完整日志也是清洗后的行，不含 goals 字段名", () => {
    const rows = rowsWithSummary(RAW_DISPATCH, ["审计接口"]);
    const { container } = renderView({ rows, defaultLogOpen: true });

    const log = container.querySelector("[data-delegate-log]");
    expect(log).not.toBeNull();
    expect(log!.textContent).toContain("已派发 2 个子任务");
    expect(log!.textContent).not.toContain("goals");
  });
});
