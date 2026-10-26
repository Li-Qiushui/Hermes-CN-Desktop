/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIND_HIT_LIMIT,
  FIND_INPUT_DEBOUNCE_MS,
  applyFindHighlight,
  clearFindHighlights,
  collectFindMatches,
  findAlignScrollTop,
  highlightFindMatches,
  pickFindMatch,
  searchConversation,
  toolRenderBody,
  FindBar,
} from "./find-in-conversation";
import type { ChatMessage, ChatToolItem } from "./chat-types";
import { writeUiValue } from "@/lib/ui-store";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearFindHighlights();
  writeUiValue("hermes.show-reasoning", false);
});

function host(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

function box(top: number, height: number) {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("collectFindMatches", () => {
  it("finds every occurrence across nested nodes, ignoring case", () => {
    const root = host(
      "<p>日志里有 Timeout</p><div><span>再 timeout 一次</span></div>",
    );
    const matches = collectFindMatches(root, "timeout");
    expect(matches).toHaveLength(2);
    expect(matches[0].range.toString()).toBe("Timeout");
    expect(matches[1].range.toString()).toBe("timeout");
  });

  it("skips editable and opt-out regions", () => {
    const root = host(
      '<p>命中一次</p><textarea>命中不该算</textarea><p data-find-skip="true">命中也不算</p>',
    );
    expect(collectFindMatches(root, "命中")).toHaveLength(1);
  });

  it("returns nothing for an empty or whitespace query", () => {
    const root = host("<p>abc</p>");
    expect(collectFindMatches(root, "")).toEqual([]);
    expect(collectFindMatches(root, "   ")).toEqual([]);
  });

  it("does not loop forever on overlapping needles", () => {
    const root = host("<p>aaaa</p>");
    expect(collectFindMatches(root, "aa")).toHaveLength(2);
  });
});

describe("highlight registry bridge", () => {
  it("stays a no-op when the platform has no CSS.highlights", () => {
    const matches = [{ range: document.createRange(), node: document.createTextNode("x") }];
    expect(() => highlightFindMatches(matches, 0)).not.toThrow();
    expect(() => clearFindHighlights()).not.toThrow();
  });

  it("registers the whole set plus the active hit when supported", () => {
    const ranges = [document.createRange(), document.createRange()];
    const set = vi.fn();
    const remove = vi.fn();
    class FakeHighlight {
      constructor(...received: Range[]) {
        expect(received.length).toBeGreaterThan(0);
      }
    }
    const registry = { highlights: { set, delete: remove }, Highlight: FakeHighlight };
    (globalThis as unknown as { CSS: unknown }).CSS = registry;
    try {
      highlightFindMatches(
        ranges.map((range, index) => ({ range, node: document.createTextNode(String(index)) })),
        1,
      );
      expect(set).toHaveBeenCalledTimes(2);
      expect(set.mock.calls[0][0]).toBe("hermes-find");
      expect(set.mock.calls[1][0]).toBe("hermes-find-active");
    } finally {
      delete (globalThis as unknown as { CSS?: unknown }).CSS;
    }
  });
});

describe("searchConversation", () => {
  const conversation: ChatMessage[] = [
    { id: "u-1", role: "user", createdAt: 1, text: "帮我看看 deploy 脚本" },
    {
      id: "a-1",
      role: "assistant",
      createdAt: 2,
      reasoning: "先读 deploy.sh",
      tools: [
        {
          tool_id: "t-1",
          name: "terminal",
          status: "done",
          startedAt: 1,
          completedAt: 2,
          summary: "第一行\ndeploy 失败：timeout\ndeploy 重试成功",
          arguments: { command: "bash deploy.sh" },
        },
      ],
    },
  ];

  it("indexes the message text, the rendered tool body and the card arguments", () => {
    const result = searchConversation(conversation, "deploy");
    expect(result.truncated).toBe(false);
    expect(result.hits.map((hit) => hit.field)).toEqual([
      "text",
      "tool-summary",
      "tool-summary",
      "tool-arguments",
    ]);
    expect(result.hits[1]).toMatchObject({ messageId: "a-1", toolId: "t-1", ordinal: 0 });
    expect(result.hits[2]).toMatchObject({ messageId: "a-1", toolId: "t-1", ordinal: 1 });
    expect(result.hits[1].snippet).toContain("deploy 失败");
    expect(result.hits[1].messageIndex).toBe(1);
  });

  it("leaves hidden reasoning out of the index and adds it back once thinking is shown", () => {
    expect(searchConversation(conversation, "先读").hits).toEqual([]);

    writeUiValue("hermes.show-reasoning", true);
    const hits = searchConversation(conversation, "先读").hits;
    expect(hits.map((hit) => hit.field)).toEqual(["reasoning"]);
    expect(hits[0].messageId).toBe("a-1");
  });

  it("honours an explicit reasoning flag regardless of the stored setting", () => {
    expect(
      searchConversation(conversation, "先读", FIND_HIT_LIMIT, { includeReasoning: true }).hits,
    ).toHaveLength(1);
    writeUiValue("hermes.show-reasoning", true);
    expect(
      searchConversation(conversation, "先读", FIND_HIT_LIMIT, { includeReasoning: false }).hits,
    ).toEqual([]);
  });

  it("skips tool text the card never renders, so a 16KB tail cannot produce invisible hits", () => {
    const truncatedTail = `${"历史输出行\n".repeat(3000)}tail-only-needle`;
    expect(truncatedTail.length).toBeGreaterThan(16 * 1024);
    const tool: ChatToolItem = {
      tool_id: "t-9",
      name: "terminal",
      status: "done",
      startedAt: 1,
      summary: "渲染出来的输出",
      tail: truncatedTail,
    };
    const messages: ChatMessage[] = [
      { id: "a-9", role: "assistant", createdAt: 3, tools: [tool] },
    ];
    expect(searchConversation(messages, "tail-only-needle").hits).toEqual([]);
    expect(searchConversation(messages, "历史输出行").hits).toEqual([]);
    expect(searchConversation(messages, "渲染出来的输出").hits.map((hit) => hit.field)).toEqual([
      "tool-summary",
    ]);
  });

  it("indexes exactly the body the tool card renders (error wins over summary and preview)", () => {
    const tool: ChatToolItem = {
      tool_id: "t-10",
      name: "build",
      status: "error",
      startedAt: 1,
      error: "失败原因 alpha",
      summary: "成功输出 beta",
      preview: "预览 gamma",
    };
    const messages: ChatMessage[] = [
      { id: "a-10", role: "assistant", createdAt: 4, tools: [tool] },
    ];

    expect(toolRenderBody(tool)).toBe("失败原因 alpha");
    expect(searchConversation(messages, "alpha").hits.map((hit) => hit.field)).toEqual(["tool-error"]);
    expect(searchConversation(messages, "beta").hits).toEqual([]);
    expect(searchConversation(messages, "gamma").hits).toEqual([]);
  });

  it("reports hits only inside the lines the file-change card renders", () => {
    const tool: ChatToolItem = {
      tool_id: "t-11",
      name: "write_file",
      status: "done",
      startedAt: 1,
      arguments: { path: "src/rendered.ts", content: "export const kept = 1;" },
    };
    const messages: ChatMessage[] = [
      { id: "a-11", role: "assistant", createdAt: 5, tools: [tool] },
    ];
    expect(searchConversation(messages, "rendered.ts").hits.map((hit) => hit.field)).toEqual([
      "tool-arguments",
    ]);
    expect(searchConversation(messages, "kept").hits.map((hit) => hit.field)).toEqual([
      "tool-arguments",
    ]);
  });

  it("caps the hit list and reports that it was cut", () => {
    const result = searchConversation(
      [{ id: "a-3", role: "assistant", createdAt: 4, text: "命中".repeat(FIND_HIT_LIMIT + 50) }],
      "命中",
      20,
    );
    expect(result.hits).toHaveLength(20);
    expect(result.truncated).toBe(true);
    expect(searchConversation(conversation, "   ").hits).toEqual([]);
  });

  it("picks the DOM match inside the reported message and tool card", () => {
    const root = host(
      '<div data-message-id="a-1"><p>deploy 一</p><div data-tool-id="t-1"><span>deploy 二</span><span>deploy 三</span></div></div>',
    );
    const matches = collectFindMatches(root, "deploy");
    expect(matches).toHaveLength(3);
    expect(pickFindMatch(matches, { messageId: "a-1", toolId: "t-1" }, 1)).toBe(2);
    expect(pickFindMatch(matches, { messageId: "a-1" }, 0)).toBe(0);
    expect(pickFindMatch(matches, { messageId: "missing" }, 0)).toBe(0);
  });
});

describe("hit alignment", () => {
  const geometry = {
    nodeTop: 900,
    containerTop: 100,
    scrollTop: 0,
    clientHeight: 900,
    scrollHeight: 5000,
  };

  it("puts the match a third down the viewport, capped at 160px", () => {
    expect(findAlignScrollTop(geometry)).toBe(640);
    expect(findAlignScrollTop({ ...geometry, clientHeight: 1800, scrollHeight: 9000 })).toBe(640);
    expect(findAlignScrollTop({ ...geometry, clientHeight: 300 })).toBe(700);
  });

  it("clamps to the scrollable range instead of overshooting", () => {
    expect(findAlignScrollTop({ ...geometry, nodeTop: 120 })).toBe(0);
    expect(
      findAlignScrollTop({ ...geometry, nodeTop: 4900, clientHeight: 900, scrollHeight: 5000 }),
    ).toBe(4100);
  });

  it("scrolls the container to the aligned offset only when the active hit changes", () => {
    document.body.innerHTML = "";
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollHeight", { value: 4000, configurable: true });
    scroller.scrollTop = 0;
    scroller.getBoundingClientRect = () => box(100, 600);
    scroller.innerHTML = '<div data-message-id="a-1"><p>needle one</p><p>needle two</p></div>';
    document.body.appendChild(scroller);

    const scrollTo = vi.fn();
    (scroller as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
    const paragraphs = scroller.querySelectorAll("p");
    paragraphs[0].getBoundingClientRect = () => box(500, 20);
    paragraphs[1].getBoundingClientRect = () => box(1300, 20);

    const root = scroller.querySelector<HTMLElement>('[data-message-id="a-1"]');
    const match = applyFindHighlight(root, "needle", { messageId: "a-1", ordinal: 1 });
    expect(match?.range.toString()).toBe("needle");
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo.mock.calls[0][0]).toEqual({
      top: findAlignScrollTop({
        nodeTop: 1300,
        containerTop: 100,
        scrollTop: 0,
        clientHeight: 600,
        scrollHeight: 4000,
      }),
      behavior: "smooth",
    });
    expect(scrollTo.mock.calls[0][0].top).toBe(1040);

    applyFindHighlight(root, "needle", { messageId: "a-1", ordinal: 1 });
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});

describe("FindBar", () => {
  const baseProps = {
    query: "日志",
    activeIndex: 1,
    total: 5,
    hasEarlier: true,
    searchingEarlier: false,
    reachedEarliest: false,
    onChange: () => {},
    onPrev: () => {},
    onNext: () => {},
    onClose: () => {},
    onSearchEarlier: () => {},
  };

  it("shows the current position over the loaded window", () => {
    render(<FindBar {...baseProps} />);
    expect(screen.getByText("第 2 处 / 共 5 处")).toBeTruthy();
  });

  it("warns when the hit list was truncated", () => {
    render(<FindBar {...baseProps} truncated />);
    expect(screen.getByText(new RegExp(`命中超过 ${FIND_HIT_LIMIT} 处`))).toBeTruthy();
  });

  it("steps forward on Enter and backward on Shift+Enter", () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    render(<FindBar {...baseProps} onNext={onNext} onPrev={onPrev} />);
    const input = screen.getByLabelText("查找关键词");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNext).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it("steps with ArrowDown and ArrowUp", () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    render(<FindBar {...baseProps} onNext={onNext} onPrev={onPrev} />);
    const input = screen.getByLabelText("查找关键词");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(onNext).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("debounces the second keystroke instead of searching on every character", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<FindBar {...baseProps} query="" onChange={onChange} />);
    const input = screen.getByLabelText("查找关键词") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "错" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("错");
    fireEvent.change(input, { target: { value: "错误" } });
    expect(input.value).toBe("错误");
    act(() => {
      vi.advanceTimersByTime(FIND_INPUT_DEBOUNCE_MS - 1);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith("错误");
  });

  it("flushes the pending query when Enter lands inside the debounce window", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const onNext = vi.fn();
    render(<FindBar {...baseProps} query="" onChange={onChange} onNext={onNext} />);
    const input = screen.getByLabelText("查找关键词");
    fireEvent.change(input, { target: { value: "超时" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("超时");
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<FindBar {...baseProps} onClose={onClose} />);
    fireEvent.keyDown(screen.getByLabelText("查找关键词"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers to continue into earlier messages when the window has no hit", () => {
    const onSearchEarlier = vi.fn();
    render(<FindBar {...baseProps} total={0} onSearchEarlier={onSearchEarlier} />);
    expect(screen.getByText("无匹配")).toBeTruthy();
    fireEvent.click(screen.getByText("在更早消息中继续搜索"));
    expect(onSearchEarlier).toHaveBeenCalledTimes(1);
  });

  it("reports 已到最早 once the head of the session is reached", () => {
    render(<FindBar {...baseProps} total={0} hasEarlier={false} />);
    expect(screen.getByText("已到最早")).toBeTruthy();
    expect(screen.queryByText("在更早消息中继续搜索")).toBeNull();
  });
});
