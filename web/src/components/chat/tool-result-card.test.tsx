// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { ChatToolItem } from "./chat-types";
import { ToolResultCard } from "./tool-result-card";

afterEach(() => cleanup());

function tool(partial: Partial<ChatToolItem> & { name: string }): ChatToolItem {
  return {
    tool_id: "call_1",
    status: "done",
    startedAt: 1,
    completedAt: 2,
    ...partial,
  } as ChatToolItem;
}

describe("ToolResultCard", () => {
  it("renders a terminal transcript with command and exit code", () => {
    const summary = JSON.stringify({ output: "1 failing\n", exit_code: 1 });
    render(<ToolResultCard tool={tool({ name: "terminal", arguments: { command: "pnpm test" } })} body={summary} />);

    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.getByText("exit 1")).toBeTruthy();
    expect(screen.getByText(/1 failing/)).toBeTruthy();
  });

  it("says so when the command produced no output", () => {
    const summary = JSON.stringify({ output: "", exit_code: 0 });
    render(<ToolResultCard tool={tool({ name: "terminal", arguments: { command: "true" } })} body={summary} />);

    expect(screen.getByText("无输出")).toBeTruthy();
    expect(screen.getByText("exit 0")).toBeTruthy();
  });

  it("renders a line-level diff with add/remove stats", () => {
    const summary = JSON.stringify({
      success: true,
      diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n",
    });
    const { container } = render(
      <ToolResultCard tool={tool({ name: "patch", arguments: { path: "src/a.ts" } })} body={summary} />,
    );

    expect(screen.getByText("文件变更")).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
    expect(screen.getByText("const b = 3;")).toBeTruthy();
    expect(container.querySelectorAll('[class*="diffRow"]').length).toBeGreaterThanOrEqual(4);
  });

  it("renders a whole-file write as added lines", () => {
    render(
      <ToolResultCard
        tool={tool({ name: "write_file", arguments: { path: "src/new.ts", content: "a\nb\n" } })}
        body={JSON.stringify({ verified: true })}
      />,
    );

    expect(screen.getByText("src/new.ts")).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();
  });

  it("keeps argument JSON copyable for other tools", () => {
    render(
      <ToolResultCard tool={tool({ name: "web_search", arguments: { query: "hermes" } })} body="5 results" />,
    );

    expect(screen.getByText("参数")).toBeTruthy();
    expect(screen.getByText(/"query": "hermes"/)).toBeTruthy();
    expect(screen.getByText("输出")).toBeTruthy();
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });

  it("falls back to raw text for unknown payloads", () => {
    render(<ToolResultCard tool={tool({ name: "mystery_tool" })} body="plain output" />);

    expect(screen.getByText("plain output")).toBeTruthy();
  });

  it("does not crash on an empty tool", () => {
    const { container } = render(<ToolResultCard tool={tool({ name: "empty_tool" })} />);
    expect(container).toBeTruthy();
  });
});
