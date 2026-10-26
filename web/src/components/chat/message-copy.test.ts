import { describe, expect, it } from "vitest";

import type { ChatMessage } from "./chat-types";
import { TOOL_OUTPUT_SUMMARY_LIMIT } from "./message-adapter";
import { messageRoundMarkdown, toolMarkdown, toolsMarkdown } from "./message-copy";

const tool = (over: Partial<Parameters<typeof toolMarkdown>[0]> = {}) => ({
  tool_id: "t1",
  name: "terminal",
  status: "done" as const,
  startedAt: 1,
  completedAt: 2,
  ...over,
});

describe("message-copy", () => {
  it("renders a tool as a heading with argument and output fences", () => {
    expect(toolMarkdown(tool({ arguments: { command: "pnpm test" }, summary: "ok\n" }))).toBe(
      [
        "### terminal",
        "参数：",
        "```json",
        "{",
        '  "command": "pnpm test"',
        "}",
        "```",
        "输出：",
        "```",
        "ok",
        "```",
      ].join("\n"),
    );
  });

  it("marks failed tools and keeps group order", () => {
    const markdown = toolsMarkdown([
      tool({ tool_id: "t1", name: "read_file" }),
      tool({ tool_id: "t2", name: "grep", status: "error", error: "no such dir" }),
    ]);

    expect(markdown.indexOf("### read_file")).toBeLessThan(markdown.indexOf("### grep"));
    expect(markdown).toContain("状态：失败");
    expect(markdown).toContain("no such dir");
  });

  it("clips oversized tool output with the summary limit marker", () => {
    const long = "x".repeat(TOOL_OUTPUT_SUMMARY_LIMIT + 10);
    const markdown = toolMarkdown(tool({ summary: long }));

    expect(markdown).toContain("…（已截断，共 ");
    expect(markdown.length).toBeLessThan(TOOL_OUTPUT_SUMMARY_LIMIT + 200);
  });

  it("keeps block order for a whole round and falls back to message.tools", () => {
    const withBlocks: ChatMessage = {
      id: "m1",
      role: "assistant",
      createdAt: 1,
      blocks: [
        { type: "text", text: "先看文件" },
        { type: "tool", tool: tool({ summary: "a" }) },
        { type: "text", text: "然后收尾" },
      ],
    };
    const fromBlocks = messageRoundMarkdown(withBlocks);
    expect(fromBlocks.startsWith("## Hermes\n\n先看文件")).toBe(true);
    expect(fromBlocks.indexOf("先看文件")).toBeLessThan(fromBlocks.indexOf("### terminal"));
    expect(fromBlocks.indexOf("### terminal")).toBeLessThan(fromBlocks.indexOf("然后收尾"));

    const withTools: ChatMessage = {
      id: "m2",
      role: "user",
      createdAt: 1,
      text: "跑一下",
      tools: [tool({ tool_id: "t9" })],
    };
    const fromTools = messageRoundMarkdown(withTools);
    expect(fromTools.startsWith("## 用户\n\n跑一下")).toBe(true);
    expect(fromTools).toContain("### terminal");
  });

  it("returns an empty string for messages without text or tools", () => {
    expect(messageRoundMarkdown({ id: "m3", role: "assistant", createdAt: 1 })).toBe("");
  });
});
