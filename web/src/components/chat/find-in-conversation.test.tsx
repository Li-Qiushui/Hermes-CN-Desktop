/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearFindHighlights,
  collectFindMatches,
  highlightFindMatches,
  FindBar,
} from "./find-in-conversation";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function host(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
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
    expect(screen.getByText("第 2 / 共 5")).toBeTruthy();
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
