import { describe, expect, it } from "vitest";
import type { ChatToolItem } from "./chat-types";
import {
  AUTOMATIC_OPEN_MAX_ITEMS,
  resolveActivityAutoOpen,
  summarizeToolActivity,
  toolDisplayName,
} from "./tool-activity";

function tool(overrides: Partial<ChatToolItem> = {}): ChatToolItem {
  return {
    tool_id: overrides.tool_id ?? "tool-1",
    name: overrides.name ?? "terminal",
    status: overrides.status ?? "done",
    startedAt: overrides.startedAt ?? 1_000,
    completedAt: overrides.completedAt ?? 1_300,
    ...overrides,
  };
}

describe("summarizeToolActivity", () => {
  it("collapses repeated terminal commands into one summary", () => {
    const summary = summarizeToolActivity(
      Array.from({ length: 10 }, (_, index) =>
        tool({
          tool_id: `terminal-${index}`,
          startedAt: 1_000 + index * 100,
          completedAt: 1_050 + index * 100,
        }),
      ),
      5_000,
    );

    expect(summary.status).toBe("done");
    expect(summary.label).toBe("运行了 10 条终端命令");
    expect(summary.meta).toBeUndefined();
    expect(summary.elapsedMs).toBe(950);
  });

  it("summarizes mixed tool batches by count", () => {
    const summary = summarizeToolActivity([
      tool({ tool_id: "terminal-1", name: "terminal" }),
      tool({ tool_id: "terminal-2", name: "terminal" }),
      tool({ tool_id: "read-1", name: "file_read" }),
      tool({ tool_id: "edit-1", name: "edit" }),
    ]);

    expect(summary.status).toBe("done");
    expect(summary.label).toBe("使用了 4 个工具");
    expect(summary.meta).toContain("terminal x2");
    expect(summary.meta).toContain("edit x1");
    expect(summary.meta).toContain("file_read x1");
  });

  it("keeps running batches visible with elapsed time", () => {
    const summary = summarizeToolActivity(
      [tool({ status: "running", startedAt: 1_000, completedAt: undefined })],
      2_500,
    );

    expect(summary.status).toBe("running");
    expect(summary.label).toBe("正在运行终端命令");
    expect(summary.elapsedMs).toBe(1_500);
  });

  it("surfaces errors in the collapsed summary", () => {
    const summary = summarizeToolActivity([
      tool({ tool_id: "terminal-1", name: "terminal" }),
      tool({
        tool_id: "read-1",
        name: "file_read",
        status: "error",
        error: "permission denied",
        completedAt: 1_400,
      }),
    ]);

    expect(summary.status).toBe("error");
    expect(summary.label).toBe("使用了 2 个工具，1 个失败");
    expect(summary.error).toBe("permission denied");
  });
});

describe("缺名工具的展示", () => {
  it("名字缺失或只剩内核占位名 tool 时用中性文案，不把内部名打给用户", () => {
    expect(summarizeToolActivity([tool({ name: "" })]).label).toBe("使用了工具");
    expect(summarizeToolActivity([tool({ name: "tool" })]).label).toBe("使用了工具");
    expect(summarizeToolActivity([tool({ name: "   " })]).label).toBe("使用了工具");
    expect(summarizeToolActivity([tool({ name: "", status: "running", completedAt: undefined })], 2_000).label)
      .toBe("正在使用工具");
    expect(toolDisplayName("tool")).toBe("工具");
  });

  it("缺名工具不参与名字统计，也不冒充终端命令", () => {
    const summary = summarizeToolActivity([
      tool({ tool_id: "unknown-1", name: "", context: undefined }),
      tool({ tool_id: "terminal-1", name: "terminal", context: undefined }),
    ]);

    expect(summary.label).toBe("使用了 2 个工具");
    expect(summary.meta).toBe("terminal x1");

    const unknownOnly = summarizeToolActivity([tool({ name: "", context: undefined })]);
    expect(unknownOnly.meta).toBeUndefined();
    expect(unknownOnly.label).toBe("使用了工具");
  });

  it("收敛成中断的缺名工具仍显示已中断，而不是「工具执行失败」", () => {
    const summary = summarizeToolActivity([
      tool({
        name: "",
        status: "error",
        error: "已中断，未拿到执行结果",
        completedAt: 1_400,
      }),
    ]);

    expect(summary.status).toBe("error");
    expect(summary.label).toBe("已中断");
    expect(summary.interrupted).toBe(true);
  });
});

describe("resolveActivityAutoOpen", () => {
  it("keeps a live activity group open no matter how many items it has", () => {
    expect(resolveActivityAutoOpen({ live: true, itemCount: 12 })).toBe(true);
  });

  it("keeps a finished group open up to 4 items and folds beyond that", () => {
    expect(AUTOMATIC_OPEN_MAX_ITEMS).toBe(4);
    expect(resolveActivityAutoOpen({ live: false, itemCount: 1 })).toBe(true);
    expect(resolveActivityAutoOpen({ live: false, itemCount: 4 })).toBe(true);
    expect(resolveActivityAutoOpen({ live: false, itemCount: 5 })).toBe(false);
  });

  it("always opens a group that carries a subagent topology card", () => {
    expect(resolveActivityAutoOpen({ live: false, itemCount: 9, hasSubagentTopology: true })).toBe(true);
  });
});
