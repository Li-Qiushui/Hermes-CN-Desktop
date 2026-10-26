/** @vitest-environment jsdom */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ReactDOMServer from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarkdownText } from "./markdown-renderer";
import {
  MessageTimeline,
  TRANSCRIPT_REPIN_THRESHOLD_PX,
  TRANSCRIPT_SCROLL_GESTURE_WINDOW_MS,
  clearTranscriptReadingBookmarks,
  copyableMessageText,
  countUnreadSinceBaseline,
  findLastAnchorIndexAtOrAbove,
  formatMessageTime,
  isInteractiveGestureTarget,
  isScrollGestureKeystroke,
  readTranscriptReadingBookmark,
  reduceTranscriptScroll,
  rememberTranscriptReadingBookmark,
  resolveShowReasoning,
  shouldAnchorToBottom,
  shouldDetachOnScroll,
  shouldForceBottomOnMessageChange,
  shouldShowJumpToBottom,
  transcriptRevealOwnership,
} from "./message-timeline";
import { clearDisclosureChoices } from "./activity-disclosure";
import type { ChatMessage, ChatToolItem } from "./chat-types";
import { hermesUIMessagesToChatMessages } from "./message-adapter";

// MessageTimeline 内部的资料卡用到 useNavigate，SSR 渲染需要 Router 上下文。
const renderTimeline = (node: ReactElement) =>
  ReactDOMServer.renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

const stubScrollTo = () => {
  const scrollTo = vi.fn();
  (HTMLElement.prototype as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
  return scrollTo;
};

beforeEach(() => {
  // 阅读位书签与折叠选择都是模块级内存态：每个用例从干净状态开始。
  clearTranscriptReadingBookmarks();
  clearDisclosureChoices();
});

afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;
  vi.restoreAllMocks();
});

const skillInvocationText = [
  '[IMPORTANT: The user has invoked the "codex" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]',
  "",
  "# Codex",
  "",
  "Always use a PTY.",
].join("\n");

describe("MessageTimeline", () => {
  it("releases bottom-follow on a gesture-driven upward scroll of a single pixel", () => {
    expect(reduceTranscriptScroll({
      scrollTop: 999,
      lastScrollTop: 1000,
      scrollHeight: 2_400,
      clientHeight: 400,
      wasPinned: true,
      gesturing: true,
    })).toEqual({ pinned: false, releasedFollow: true, repinned: false });
  });

  it("keeps the follow state untouched when the scroll was not user-driven", () => {
    // 200ms 手势窗口外的一律按程序/布局噪声处理：pinned 保持不变，不许退出跟随。
    expect(reduceTranscriptScroll({
      scrollTop: 800,
      lastScrollTop: 1000,
      scrollHeight: 2_400,
      clientHeight: 400,
      wasPinned: true,
      gesturing: false,
    })).toEqual({ pinned: true, releasedFollow: false, repinned: false });
    expect(reduceTranscriptScroll({
      scrollTop: 800,
      lastScrollTop: 1000,
      scrollHeight: 2_400,
      clientHeight: 400,
      wasPinned: false,
      gesturing: false,
    })).toEqual({ pinned: false, releasedFollow: false, repinned: false });
  });

  it("re-pins only when a downward gesture lands inside the 48px band", () => {
    // 2_400 - 1_960 - 400 = 40px 距底：落在 48px 带里；1_900 距底 100px，仍在带外。
    const base = {
      lastScrollTop: 1_900,
      scrollHeight: 2_400,
      clientHeight: 400,
      wasPinned: false,
      gesturing: true,
    };
    expect(reduceTranscriptScroll({ ...base, scrollTop: 1_960 })).toEqual({
      pinned: true,
      releasedFollow: false,
      repinned: true,
    });
    expect(reduceTranscriptScroll({ ...base, scrollTop: 1_900 }).pinned).toBe(false);
    expect(TRANSCRIPT_REPIN_THRESHOLD_PX).toBe(48);
    expect(TRANSCRIPT_SCROLL_GESTURE_WINDOW_MS).toBe(200);
  });

  it("recognises only scroll keystrokes and non-interactive targets as gestures", () => {
    ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].forEach((key) => {
      expect(isScrollGestureKeystroke(key)).toBe(true);
    });
    expect(isScrollGestureKeystroke("a")).toBe(false);

    expect(isInteractiveGestureTarget({ tagName: "BUTTON" })).toBe(true);
    expect(isInteractiveGestureTarget({ tagName: "div", isContentEditable: true })).toBe(true);
    expect(isInteractiveGestureTarget({ tagName: "DIV", closest: () => ({}) })).toBe(true);
    expect(isInteractiveGestureTarget({ tagName: "DIV", closest: () => null })).toBe(false);
    expect(isInteractiveGestureTarget(null)).toBe(false);
  });

  it("treats a genuine user upward scroll as a bottom-detach gesture", () => {
    expect(shouldDetachOnScroll(800, 1000, false)).toBe(true);
  });

  it("does not detach while a programmatic turn jump animates upward", () => {
    // The smooth scrollTo from scrollToTurn drives scrollTop down too; without the
    // guard handleScroll would cancel its own jump. This locks in the fix.
    expect(shouldDetachOnScroll(800, 1000, true)).toBe(false);
  });

  it("does not detach when scrolling downward", () => {
    expect(shouldDetachOnScroll(1000, 800, false)).toBe(false);
  });

  it("forces bottom positioning when history first loads or the session changes", () => {
    expect(shouldForceBottomOnMessageChange(0, 8, false, undefined, "user-4")).toBe(true);
    expect(shouldForceBottomOnMessageChange(8, 6, true, "user-4", "user-3")).toBe(true);
  });

  it("forces bottom positioning for a newly appended user message", () => {
    expect(shouldForceBottomOnMessageChange(8, 10, false, "user-4", "user-5")).toBe(true);
  });

  it("keeps an upward-scrolled user detached for assistant-only updates", () => {
    expect(shouldForceBottomOnMessageChange(8, 9, false, "user-4", "user-4")).toBe(false);
  });

  it("uses the optimistic progress model instead of stale session usage", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: 1,
        status: "streaming",
        blocks: [{ type: "progress", text: "正在唤醒Hermes..." }],
      },
    ];

    const html = renderTimeline(
      <MessageTimeline
        messages={messages}
        turnStartedAt={1}
        sessionUsage={{ model: "deepseek-v4-flash" } as any}
        progressModel="qwen3.6-plus"
      />,
    );

    expect(html).toContain("qwen3.6-plus");
    expect(html).not.toContain("deepseek-v4-flash");
  });

  it("shows live context tokens instead of cumulative session totals", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: 1,
        status: "streaming",
        blocks: [{ type: "progress", text: "正在分析项目..." }],
      },
    ];

    const html = renderTimeline(
      <MessageTimeline
        messages={messages}
        turnStartedAt={1}
        sessionUsage={{
          model: "deepseek-v4-flash",
          total: 1_033_698,
          input: 1_027_212,
          output: 6_486,
          context_used: 87_382,
        } as any}
      />,
    );

    expect(html).toContain("87.4k tokens");
    expect(html).not.toContain("1.0M tokens");
  });


  it("renders Obsidian deep links without the blocked indicator", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text="[Twitter 时间线](obsidian://open?vault=Hermes&file=Twitter%20%E6%97%B6%E9%97%B4%E7%BA%BF)" />,
    );

    expect(html).toContain("href=\"obsidian://open?vault=Hermes&amp;file=Twitter%20%E6%97%B6%E9%97%B4%E7%BA%BF\"");
    expect(html).toContain("Twitter 时间线");
    expect(html).not.toContain("[blocked]");
  });



  it("renders footnote anchors as in-page links", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={"正文引用[^1]\n\n[^1]: 这里是脚注内容"} />,
    );

    expect(html).toContain('href="#user-content-fn-1"');
    expect(html).toContain('href="#user-content-fnref-1"');
    expect(html).toContain("这里是脚注内容");
    expect(html).not.toContain('target="_blank"');
  });

  it("keeps safe relative Markdown links renderable", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text="[内部帮助](/about)" />,
    );

    expect(html).toContain("href=\"/about\"");
    expect(html).toContain("内部帮助");
  });

  it("renders controlled rich inline Markdown formatting", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={'<small style="font-size: 12px; color: #999">06 月 07 日 05:30</small> · <span data-tone="muted" data-size="small">浏览 152</span>'} />,
    );

    expect(html).toContain("06 月 07 日 05:30");
    expect(html).toContain("浏览 152");
    expect(html).toContain("font-size:12px");
    expect(html).toContain("color:#999");
  });

  it("drops unsafe inline styles from rich formatting tags", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={'<span style="background-image: url(javascript:alert(1)); font-size: 200px">日期</span>'} />,
    );

    expect(html).toContain("日期");
    expect(html).not.toContain("javascript");
    expect(html).not.toContain("background-image");
    expect(html).not.toContain("200px");
  });


  it("renders a copy button on fenced code blocks", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={"```ts\nconst value = 1;\n```"} />,
    );

    expect(html).toContain('data-streamdown="code-block-copy-button"');
    expect(html).toContain('title="复制代码"');
  });

  it("does not render code block controls for inline code", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={"行内 `code` 不需要复制按钮"} />,
    );

    expect(html).not.toContain('data-streamdown="code-block-copy-button"');
  });

  it("routes Mermaid fences away from the plain code block renderer", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={"```mermaid\ngraph TD\n  A[开始] --> B{条件判断}\n  B -->|是| C[处理]\n```"} />,
    );

    expect(html).not.toContain('data-language="mermaid"');
    expect(html).not.toContain('data-streamdown="code-block"');
  });

  it("renders Markdown image syntax as an image preview", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text="结果图：![趋势图](https://example.test/chart.png)" />,
    );

    expect(html).toContain("https://example.test/chart.png");
    expect(html).toContain("alt=\"趋势图\"");
  });

  it("routes a Windows local-path Markdown image to the local preview instead of blocking it", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText
        text={"模型生成图片：![生成图](D:\\Hermes-CN-Desktop\\e2e\\.runtime\\hermes-home\\images\\generated previews\\model output.png)"}
      />,
    );

    // rehype-harden must not swallow the drive-letter path as a blocked image.
    expect(html).not.toContain("[Image blocked");
    // It must reach MessageImage's local-path handling (async media fetch →
    // loading placeholder in SSR), with the POSIX-style drive path mapped back.
    expect(html).toContain("图片加载中");
    expect(html).toContain("generated%20previews");
    expect(html).toContain("/D:/Hermes-CN-Desktop/e2e/.runtime/hermes-home/images");
  });

  it("renders single-dollar inline LaTeX formulas", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={String.raw`设 $\boldsymbol{v}_i \in \mathbb{R}^n$ 且 $A\boldsymbol{v}_i = \boldsymbol{0}$。`} />,
    );

    expect(html).toContain("katex");
    expect(html).toContain('class="katex"');
    expect(html).toContain("style=\"height:");
    expect(html).not.toContain("_richInline");
    expect(html).not.toContain("$\\boldsymbol");
  });

  it("renders TeX parenthesis and bracket math delimiters", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText
        text={String.raw`两个球体 \(S_1(c_1,r_1)\) 和 \(S_2(c_2,r_2)\) 的条件：\[\|\mathbf{c}_1-\mathbf{c}_2\|\le r_1+r_2\]`}
      />,
    );

    expect(html).toContain("katex");
    expect(html).toContain("katex-display");
    expect(html).not.toContain("\\(");
    expect(html).not.toContain("\\[");
  });

  it("does not normalize TeX delimiters inside code", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={"代码 `\\(x_1\\)` 保持字面量。"} />,
    );

    expect(html).toContain("\\(x_1\\)");
  });

  it("starts resolving local image URLs through the gateway media endpoint", () => {
    const messages: ChatMessage[] = [
      {
        id: "user-image",
        role: "user",
        createdAt: 1,
        images: [{ url: "/Users/enzo/Downloads/chart.png", alt: "chart.png", name: "chart.png" }],
      },
    ];

    const html = renderTimeline(
      <MessageTimeline messages={messages} />,
    );

    expect(html).toContain("图片加载中");
    expect(html).toContain("chart.png");
    expect(html).toContain("/Users/enzo/Downloads/chart.png");
  });

  it("shows turn navigation for multi-turn conversations", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", createdAt: 1, text: "第一轮问题" },
      { id: "assistant-1", role: "assistant", createdAt: 2, text: "第一轮回答" },
      { id: "skill-1", role: "user", createdAt: 2.5, text: skillInvocationText },
      { id: "user-2", role: "user", createdAt: 3, text: "第二轮追问" },
      { id: "assistant-2", role: "assistant", createdAt: 4, text: "第二轮回答" },
    ];

    const html = renderTimeline(
      <MessageTimeline messages={messages} />,
    );

    expect(html).toContain("aria-label=\"对话轮次定位\"");
    expect(html).toContain("aria-label=\"定位到第 1 轮对话\"");
    expect(html).toContain("aria-label=\"定位到第 2 轮对话\"");
    expect(html).not.toContain("aria-label=\"定位到第 3 轮对话\"");
    expect(html.match(/data-turn-anchor=\"true\"/g)).toHaveLength(2);
  });

  it("renders the kernel auto-continue frame as a Chinese system notice, not a user bubble", () => {
    const frame = "[System note: Your previous turn was interrupted mid-run (attempt 1).]";
    const messages = hermesUIMessagesToChatMessages([
      {
        id: "auto-continue-1",
        sessionId: "s1",
        role: "user",
        createdAt: 1,
        status: "complete",
        parts: [{ type: "text", text: frame }],
      },
      {
        id: "assistant-1",
        sessionId: "s1",
        role: "assistant",
        createdAt: 2,
        status: "complete",
        parts: [{ type: "text", text: "继续跑完了" }],
      },
    ]);

    const html = renderTimeline(<MessageTimeline messages={messages} />);

    expect(html).toContain('data-role="system"');
    expect(html).toContain("内核已自动续跑被中断的本轮，已执行的命令可能重复");
    expect(html).not.toContain("[System note");
    expect(html).not.toContain('data-role="user"');
  });

  it("renders injected Skill content as a full-width system notice without user actions", () => {
    const html = renderTimeline(
      <MessageTimeline
        messages={[{
          id: "skill-1",
          role: "user",
          createdAt: 1,
          text: skillInvocationText,
        }]}
      />,
    );

    expect(html).toContain('data-role="system"');
    expect(html).toContain('data-system-kind="skill-invocation"');
    expect(html).toContain('data-kind="skill-invocation"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Skill 指令已加载");
    expect(html).toContain('data-skill-invocation="true"');
    expect(html).not.toContain('data-role="user"');
    expect(html).not.toContain('data-turn-anchor="true"');
    expect(html).not.toContain("复制");
  });

  it("renders kernel async-delegation reports as subagent result notices, not user bubbles", () => {
    const html = renderTimeline(
      <MessageTimeline
        messages={[{
          id: "async-1",
          role: "user",
          createdAt: 1,
          text: [
            "[ASYNC DELEGATION BATCH COMPLETE — deleg_9b163957]",
            "A background fan-out unit you dispatched earlier — 1 subagent(s) — has finished.",
            "",
            "Dispatched: 2026-10-23 13:47:50 (2m57s ago)",
            "Role: leaf   Model: deepseek-v4.1-flash   Total duration: 177.53s",
            "",
            "--- ✓ TASK 1/1: 审计改动  (status=completed, api_calls=27, 176.96s) ---",
            "结论：可以提交。",
          ].join("\n"),
        }]}
      />,
    );

    expect(html).toContain('data-role="system"');
    expect(html).toContain('data-system-kind="kernel-notice"');
    expect(html).toContain('data-kind="kernel-notice"');
    expect(html).toContain('role="status"');
    expect(html).toContain("子代理任务结果");
    expect(html).toContain("deleg_9b163957");
    expect(html).toContain("结论：可以提交。");
    expect(html).toContain("--- ✓ TASK 1/1: 审计改动");
    expect(html).not.toContain('data-role="user"');
    expect(html).not.toContain('data-turn-anchor="true"');
  });

  it("marks a failed subagent notice as a failure", () => {
    const html = renderTimeline(
      <MessageTimeline
        messages={[{
          id: "async-failed",
          role: "user",
          createdAt: 1,
          text: "[ASYNC DELEGATION TASK FAILED — deleg_zz9, task 2/3]\nOne subagent in a background fan-out you dispatched has failed.",
        }]}
      />,
    );

    expect(html).toContain("子代理任务失败");
    expect(html).toContain("deleg_zz9");
    expect(html).not.toContain('data-role="user"');
  });

  it("does not count a subagent notice as a conversation turn", () => {
    const html = renderTimeline(
      <MessageTimeline
        messages={[
          { id: "user-1", role: "user", createdAt: 1, text: "第一轮" },
          { id: "assistant-1", role: "assistant", createdAt: 2, text: "回答一" },
          {
            id: "async-1",
            role: "user",
            createdAt: 3,
            text: "[ASYNC DELEGATION COMPLETE — deleg_abc]\n--- RESULT ---\ndone",
          },
          { id: "user-2", role: "user", createdAt: 4, text: "第二轮" },
          { id: "assistant-2", role: "assistant", createdAt: 5, text: "回答二" },
        ]}
      />,
    );

    expect(html.match(/data-turn-anchor="true"/g)).toHaveLength(2);
    expect(html).not.toContain('aria-label="定位到第 3 轮对话"');
  });

  it("does not show turn navigation for a single user turn", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", createdAt: 1, text: "只有一轮" },
      { id: "assistant-1", role: "assistant", createdAt: 2, text: "回答" },
    ];

    const html = renderTimeline(
      <MessageTimeline messages={messages} />,
    );

    expect(html).not.toContain("对话轮次定位");
  });
  it("falls back to session usage stats for the latest completed assistant message", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", createdAt: 1, text: "问题" },
      { id: "assistant-1", role: "assistant", createdAt: 2, status: "complete", text: "回答" },
    ];

    const html = renderTimeline(
      <MessageTimeline
        messages={messages}
        sessionUsage={{
          model: "deepseek-v4-flash",
          input: 900,
          output: 300,
          total: 1200,
          cache_read: 100,
          calls: 1,
        } as any}
      />,
    );

    expect(html).toContain("1.2k");
    expect(html).toContain('title="详细统计"');
  });

  it("keeps the detailed stats button on theme tokens instead of a hard-coded light surface", () => {
    const cssFile = [
      "src/components/chat/message-timeline.module.css",
      "web/src/components/chat/message-timeline.module.css",
    ]
      .map((relative) => resolve(process.cwd(), relative))
      .find((file) => existsSync(file)) ?? "";
    const block = /\.messageStatsToggle \{[^}]*\}/.exec(readFileSync(cssFile, "utf8"))?.[0] ?? "";

    expect(block).not.toBe("");
    expect(block).toContain("border: 0");
    expect(block).toContain("background: transparent");
    expect(block).not.toMatch(/#|rgba?\(|white(?!-space)/);
  });

  it("keeps the message action bar free of read-aloud controls", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", createdAt: 1, text: "问题" },
      { id: "assistant-1", role: "assistant", createdAt: 2, status: "complete", text: "回答" },
    ];

    const html = renderTimeline(
      <MessageTimeline
        messages={messages}
        onEditMessage={() => {}}
        onRetryMessage={() => {}}
        onDeleteMessage={() => {}}
      />,
    );

    expect(html).not.toContain("data-speech-state");
    expect(html).not.toMatch(/lucide-volume/);
    expect(html).not.toMatch(/<button[^>]*aria-pressed/);
    expect(html).toContain("复制");
    expect(html).toContain("编辑");
    expect(html).toContain("重试");
    expect(html).toContain("删除");
  });

  it("renders only the tail window and an earlier-messages entry for very long conversations", () => {
    const messages: ChatMessage[] = Array.from({ length: 100 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      createdAt: index + 1,
      status: "complete" as const,
      text: `第 ${index + 1} 条`,
    }));

    const html = renderTimeline(<MessageTimeline messages={messages} />);

    expect(html.match(/data-turn-anchor="true"/g)).toHaveLength(30);
    expect(html).toContain("显示更早的 40 条消息");
    expect(html).toContain("第 100 条");
    expect(html).not.toContain("<p>第 39 条</p>");
  });

  it("renders every message without a window below the long-conversation threshold", () => {
    const messages: ChatMessage[] = Array.from({ length: 80 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      createdAt: index + 1,
      status: "complete" as const,
      text: `第 ${index + 1} 条`,
    }));

    const html = renderTimeline(<MessageTimeline messages={messages} />);

    expect(html.match(/data-turn-anchor="true"/g)).toHaveLength(40);
    expect(html).not.toContain("显示更早的");
    expect(html).toContain("第 1 条");
  });

  it("renders message rows without sender name or avatar", () => {
    const messages: ChatMessage[] = [
      { id: "u-1", role: "user", createdAt: 1, status: "complete", text: "帮我看看这个报错" },
      { id: "a-1", role: "assistant", createdAt: 2, status: "complete", text: "问题出在依赖版本" },
    ];

    const html = renderTimeline(<MessageTimeline messages={messages} />);

    expect(html).not.toContain("头像");
    expect(html).not.toContain("查看 ");
    expect(html).not.toContain("Hermes");
    expect(html).toContain("帮我看看这个报错");
    expect(html).toContain("问题出在依赖版本");
    expect(html).toContain("复制");
  });

  it("asks the server for an earlier page only after the local window is exhausted", async () => {
    stubScrollTo();
    const messages: ChatMessage[] = Array.from({ length: 100 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      createdAt: index + 1,
      status: "complete" as const,
      text: `第 ${index + 1} 条`,
    }));
    const onLoadEarlier = vi.fn().mockResolvedValue(undefined);

    const { container, rerender } = render(
      <MemoryRouter>
        <MessageTimeline messages={messages} hasEarlier onLoadEarlier={onLoadEarlier} />
      </MemoryRouter>,
    );

    const earlierButton = () =>
      container.querySelector("[data-earlier-mode]") as HTMLButtonElement | null;

    expect(earlierButton()?.getAttribute("data-earlier-mode")).toBe("local");
    expect(earlierButton()?.textContent).toContain("显示更早的 40 条消息");

    await act(async () => {
      fireEvent.click(earlierButton()!);
    });
    expect(onLoadEarlier).not.toHaveBeenCalled();
    expect(container.querySelectorAll("[data-message-index]")).toHaveLength(100);
    expect(earlierButton()?.getAttribute("data-earlier-mode")).toBe("server");
    expect(earlierButton()?.textContent).toContain("加载更早的消息");

    await act(async () => {
      fireEvent.click(earlierButton()!);
    });
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);

    rerender(
      <MemoryRouter>
        <MessageTimeline
          messages={messages}
          hasEarlier
          isLoadingEarlier
          onLoadEarlier={onLoadEarlier}
        />
      </MemoryRouter>,
    );
    const loadingButton = Array.from(container.querySelectorAll("button")).find((node) =>
      node.textContent?.includes("加载中…"),
    ) as HTMLButtonElement;
    expect(loadingButton).toBeTruthy();
    expect(loadingButton.disabled).toBe(true);
  });

  it("shows the earlier-page error with a retry that re-requests", async () => {
    stubScrollTo();
    const messages: ChatMessage[] = Array.from({ length: 100 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      createdAt: index + 1,
      status: "complete" as const,
      text: `第 ${index + 1} 条`,
    }));
    const onLoadEarlier = vi.fn().mockResolvedValue(undefined);

    const { container } = render(
      <MemoryRouter>
        <MessageTimeline
          messages={messages}
          hasEarlier
          loadEarlierError={new Error("network down")}
          onLoadEarlier={onLoadEarlier}
        />
      </MemoryRouter>,
    );

    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain("network down");

    const retry = Array.from(container.querySelectorAll("button")).find((node) =>
      node.textContent?.includes("重试"),
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it("reveals already-loaded rows locally without firing another request", async () => {
    stubScrollTo();
    const messages: ChatMessage[] = Array.from({ length: 100 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      createdAt: index + 1,
      status: "complete" as const,
      text: `第 ${index + 1} 条`,
    }));
    const onLoadEarlier = vi.fn().mockResolvedValue(undefined);

    const { container } = render(
      <MemoryRouter>
        <MessageTimeline messages={messages} hasEarlier onLoadEarlier={onLoadEarlier} />
      </MemoryRouter>,
    );

    expect(container.textContent).toContain("显示更早的 40 条消息");
    expect(container.querySelectorAll("[data-message-index]")).toHaveLength(60);

    const reveal = Array.from(container.querySelectorAll("button")).find((node) =>
      node.textContent?.includes("显示更早的"),
    ) as HTMLButtonElement;

    await act(async () => {
      fireEvent.click(reveal);
    });

    expect(onLoadEarlier).not.toHaveBeenCalled();
    expect(container.querySelectorAll("[data-message-index]")).toHaveLength(100);
  });

  it("keeps the render window on the prepended rows instead of jumping to the tail", () => {
    const scrollTo = stubScrollTo();
    const build = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, index) => ({
        id: `${prefix}-${index}`,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        createdAt: index + 1,
        status: "complete" as const,
        text: `${prefix}${index + 1}`,
      }));
    const head = build(300, "第");
    const earlier = build(100, "更早");

    const { container, rerender } = render(
      <MemoryRouter>
        <MessageTimeline messages={head} hasEarlier onLoadEarlier={() => undefined} />
      </MemoryRouter>,
    );

    expect(container.querySelectorAll("[data-message-index]")).toHaveLength(60);
    expect(container.querySelector('[data-message-index="240"]')?.textContent).toContain("第241");
    scrollTo.mockClear();

    rerender(
      <MemoryRouter>
        <MessageTimeline
          messages={[...earlier, ...head]}
          hasEarlier
          onLoadEarlier={() => undefined}
        />
      </MemoryRouter>,
    );

    const rows = container.querySelectorAll("[data-message-index]");
    expect(rows).toHaveLength(100);
    expect(rows[0].getAttribute("data-message-index")).toBe("300");
    expect(rows[0].textContent).toContain("第201");
    expect(scrollTo).not.toHaveBeenCalled();
    expect(container.querySelector('[data-message-index="340"]')?.textContent).toContain("第241");
    expect(container.textContent).toContain("显示更早的 40 条消息");
  });

  it("switches the earlier entry to 已到最早 once the first page is reached", async () => {
    stubScrollTo();
    const messages: ChatMessage[] = Array.from({ length: 100 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      createdAt: index + 1,
      status: "complete" as const,
      text: `第 ${index + 1} 条`,
    }));
    const onLoadEarlier = vi.fn().mockResolvedValue(undefined);

    const { container, rerender } = render(
      <MemoryRouter>
        <MessageTimeline messages={messages} hasEarlier onLoadEarlier={onLoadEarlier} />
      </MemoryRouter>,
    );

    const earlierButton = () =>
      container.querySelector("[data-earlier-mode]") as HTMLButtonElement | null;

    await act(async () => {
      fireEvent.click(earlierButton()!);
    });
    await act(async () => {
      fireEvent.click(earlierButton()!);
    });
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);

    rerender(
      <MemoryRouter>
        <MessageTimeline messages={messages} hasEarlier={false} onLoadEarlier={onLoadEarlier} />
      </MemoryRouter>,
    );

    expect(container.textContent).toContain("已到最早");
    expect(container.textContent).not.toContain("加载更早的消息");
  });

  it("skips the bottom-follow scrollTop write when the container is already at the bottom", () => {
    // ResizeObserver fires every frame while streaming; writing scrollTop unconditionally
    // forces a layout even when nothing is left to follow.
    expect(shouldAnchorToBottom(true, 0)).toBe(false);
    expect(shouldAnchorToBottom(true, 0.5)).toBe(false);
    expect(shouldAnchorToBottom(true, 24)).toBe(true);
  });

  it("never anchors the viewport while the reader has released follow", () => {
    expect(shouldAnchorToBottom(false, 400)).toBe(false);
    expect(shouldAnchorToBottom(false, 0)).toBe(false);
  });

  it("locates the active turn with a binary search instead of a per-anchor scan", () => {
    const tops = [0, 100, 250, 320, 500];
    const resolved = (threshold: number) =>
      findLastAnchorIndexAtOrAbove(tops.length, (index) => tops[index] <= threshold);

    expect(resolved(-10)).toBe(-1);
    expect(resolved(0)).toBe(0);
    expect(resolved(260)).toBe(2);
    expect(resolved(500)).toBe(4);
    expect(resolved(9_999)).toBe(4);

    const longTops = Array.from({ length: 400 }, (_, index) => index * 32);
    const target = 123 * 32 + 5;
    expect(findLastAnchorIndexAtOrAbove(longTops.length, (index) => longTops[index] <= target)).toBe(123);
  });

  it("returns no anchor hit for an empty turn list", () => {
    expect(findLastAnchorIndexAtOrAbove(0, () => true)).toBe(-1);
  });

  it("shows the jump-to-latest control only once the reader released follow", () => {
    expect(shouldShowJumpToBottom(true)).toBe(false);
    expect(shouldShowJumpToBottom(false)).toBe(true);
  });

  it("counts only the messages appended after the reader released follow", () => {
    expect(countUnreadSinceBaseline(5, 5)).toBe(0);
    expect(countUnreadSinceBaseline(7, 5)).toBe(2);
    expect(countUnreadSinceBaseline(3, 5)).toBe(0);
  });

  it("renders the jump-to-bottom control only after the user detached", () => {
    const messages: ChatMessage[] = [
      { id: "u-1", role: "user", createdAt: 1, text: "问题" },
      { id: "a-1", role: "assistant", createdAt: 2, text: "回答" },
    ];

    const html = renderTimeline(<MessageTimeline messages={messages} />);

    expect(html).not.toContain("跳到最新");
  });

  it("restores the reading anchor of a session the reader had scrolled away from", async () => {
    const scrollTo = stubScrollTo();
    const messages = fiveMessages();
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    // 每行 100px 高，按当前 scrollTop 折算到视口：行锚点才有意义。
    HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement) {
      const messageId = this.dataset?.messageId;
      const scroller = document.querySelector('[role="log"]');
      const offset = scroller instanceof HTMLElement ? scroller.scrollTop : 0;
      const matches = messageId ? /^m-(\d)$/.exec(messageId) : null;
      const index = matches ? Number(matches[1]) : -1;
      if (index < 0) return { top: 0, bottom: 0 } as DOMRect;
      return { top: index * 100 - offset, bottom: index * 100 - offset + 100 } as DOMRect;
    };

    try {
      const first = render(
        <MemoryRouter>
          <MessageTimeline messages={messages} sessionId="s-restore" />
        </MemoryRouter>,
      );
      const firstScroller = primeScroller(first.container);

      await act(async () => {
        firstScroller.scrollTop = 1_200;
        fireEvent.scroll(firstScroller);
        fireEvent.wheel(firstScroller, { deltaY: -120 });
        firstScroller.scrollTop = 200;
        fireEvent.scroll(firstScroller);
      });
      expect(readTranscriptReadingBookmark("s-restore")?.pinned).toBe(false);
      expect(readTranscriptReadingBookmark("s-restore")?.messageId).toBe("m-2");
      first.unmount();

      const second = render(
        <MemoryRouter>
          <MessageTimeline messages={messages} sessionId="s-restore" />
        </MemoryRouter>,
      );
      const secondScroller = primeScroller(second.container);

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 16));
      });

      expect(secondScroller.scrollTop).toBe(200);
      expect(second.container.querySelector('button[aria-label^="跳到最新"]')).not.toBeNull();
      expect(scrollTo).not.toHaveBeenCalledWith(expect.objectContaining({ top: 2_000 }));
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  });

  it("sends a session that was left pinned straight back to the bottom", async () => {
    const scrollTo = stubScrollTo();
    const { container } = render(
      <MemoryRouter>
        <MessageTimeline messages={fiveMessages()} sessionId="s-pinned" />
      </MemoryRouter>,
    );
    const scroller = primeScroller(container);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });

    expect(readTranscriptReadingBookmark("s-pinned")?.pinned ?? true).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 2_000, behavior: "auto" });
    expect(scroller).not.toBeNull();
  });

  it("keeps a failed tool row collapsed and shows the error in the row head", () => {
    stubScrollTo();
    const message: ChatMessage = {
      id: "m-tool-failed",
      role: "assistant",
      createdAt: 1,
      status: "complete",
      text: "",
      tools: [
        {
          tool_id: "call-failed",
          name: "terminal",
          status: "error",
          startedAt: 1_000,
          completedAt: 1_200,
          error: "bash: command not found",
        },
      ],
    };

    const { container } = render(
      <MemoryRouter>
        <MessageTimeline messages={[message]} />
      </MemoryRouter>,
    );

    const card = container.querySelector('[data-tool-id="call-failed"]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.querySelector('[data-open="true"]')).toBeNull();
    expect(card.textContent).toContain("bash: command not found");
  });

  it("copies only the assistant body, never the reasoning", () => {
    expect(copyableMessageText({
      id: "a-1",
      role: "assistant",
      createdAt: 1,
      text: "正文",
      reasoning: "内心独白",
    })).toBe("正文");

    expect(copyableMessageText({
      id: "a-2",
      role: "assistant",
      createdAt: 2,
      blocks: [
        { type: "reasoning", text: "先想想" },
        { type: "text", text: "最终答复" },
        { type: "reasoning", text: "再想想" },
      ],
    })).toBe("最终答复");

    expect(copyableMessageText({
      id: "a-3",
      role: "assistant",
      createdAt: 3,
      blocks: [{ type: "reasoning", text: "只有独白" }],
    })).toBeUndefined();

    expect(copyableMessageText({
      id: "u-1",
      role: "user",
      createdAt: 4,
      text: "  用户原话  ",
    })).toBe("用户原话");
  });

  const fiveMessages = (): ChatMessage[] => Array.from({ length: 5 }, (_, index) => ({
    id: `m-${index}`,
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    createdAt: index + 1,
    status: "complete" as const,
    text: `第 ${index + 1} 条`,
  }));

  const primeScroller = (container: HTMLElement): HTMLElement => {
    const scroller = container.querySelector('[role="log"]') as HTMLElement;
    Object.defineProperty(scroller, "scrollHeight", { value: 2_400, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
    return scroller;
  };

  it("releases follow only after a real wheel gesture, then jumps back to latest on click", async () => {
    const scrollTo = stubScrollTo();
    const { container } = render(
      <MemoryRouter>
        <MessageTimeline messages={fiveMessages()} />
      </MemoryRouter>,
    );
    const scroller = primeScroller(container);

    await act(async () => {
      scroller.scrollTop = 2_000;
      fireEvent.scroll(scroller);
      await new Promise((resolve) => setTimeout(resolve, 32));
    });
    expect(container.querySelector('button[aria-label^="跳到最新"]')).toBeNull();

    await act(async () => {
      fireEvent.wheel(scroller, { deltaY: -120 });
      scroller.scrollTop = 1_200;
      fireEvent.scroll(scroller);
      await new Promise((resolve) => setTimeout(resolve, 32));
    });

    const button = container.querySelector('button[aria-label^="跳到最新"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent).toContain("跳到最新");
    expect(button.textContent).not.toContain("下面还有");

    scrollTo.mockClear();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(scrollTo).toHaveBeenCalled();
    expect(container.querySelector('button[aria-label^="跳到最新"]')).toBeNull();
  });

  it("ignores an upward scroll that happens outside the 200ms gesture window", async () => {
    stubScrollTo();
    const { container } = render(
      <MemoryRouter>
        <MessageTimeline messages={fiveMessages()} />
      </MemoryRouter>,
    );
    const scroller = primeScroller(container);

    await act(async () => {
      scroller.scrollTop = 2_000;
      fireEvent.scroll(scroller);
    });
    // 布局/程序造成的 scrollTop 递减：不是手势，跟随状态原样保持。
    await act(async () => {
      scroller.scrollTop = 1_200;
      fireEvent.scroll(scroller);
      await new Promise((resolve) => setTimeout(resolve, 32));
    });

    expect(container.querySelector('button[aria-label^="跳到最新"]')).toBeNull();
  });

  it("counts only messages that arrive after the reader released follow", async () => {
    stubScrollTo();
    const messages = fiveMessages();
    const { container, rerender } = render(
      <MemoryRouter>
        <MessageTimeline messages={messages} />
      </MemoryRouter>,
    );
    const scroller = primeScroller(container);

    await act(async () => {
      scroller.scrollTop = 2_000;
      fireEvent.scroll(scroller);
      fireEvent.wheel(scroller, { deltaY: -120 });
      scroller.scrollTop = 1_200;
      fireEvent.scroll(scroller);
      await new Promise((resolve) => setTimeout(resolve, 32));
    });

    rerender(
      <MemoryRouter>
        <MessageTimeline
          messages={[
            ...messages,
            { id: "m-5", role: "assistant", createdAt: 6, status: "complete", text: "第 6 条" },
            { id: "m-6", role: "assistant", createdAt: 7, status: "complete", text: "第 7 条" },
          ]}
        />
      </MemoryRouter>,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 32));
    });

    const button = container.querySelector('button[aria-label^="跳到最新"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent).toContain("2 条新消息");
    expect(button.textContent).not.toContain("下面还有");
  });

  it("finds text inside a collapsed tool card, counts it, and auto-expands it", async () => {
    stubScrollTo();
    const messages: ChatMessage[] = [
      { id: "u-1", role: "user", createdAt: 1, status: "complete", text: "跑一下测试" },
      {
        id: "a-1",
        role: "assistant",
        createdAt: 2,
        status: "complete",
        tools: [
          {
            tool_id: "t-1",
            name: "terminal",
            status: "done",
            startedAt: 1,
            completedAt: 2,
            summary: "第一行\nhidden-needle 出现在这里",
          },
        ],
      },
    ];

    const { container } = render(
      <MemoryRouter>
        <MessageTimeline messages={messages} />
      </MemoryRouter>,
    );

    expect(container.textContent).not.toContain("hidden-needle");
    // 活动组（≤4 项）保持展开，工具行本身仍折叠：命中藏在未展开的正文里。
    const collapsed = container.querySelector('[data-tool-id="t-1"]') as HTMLElement;
    expect(collapsed).not.toBeNull();
    expect(collapsed.querySelector('[data-open="true"]')).toBeNull();

    await act(async () => {
      fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    });
    const input = container.querySelector('input[aria-label="查找关键词"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "hidden-needle" } });
    });

    expect(container.querySelector("[data-find-counter]")?.textContent).toBe("第 1 处 / 共 1 处");
    const card = container.querySelector('[data-tool-id="t-1"]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("hidden-needle");
    expect(card.querySelector('[data-open="true"]')).not.toBeNull();
  });

  it("marks the matched node so the hit is visibly highlighted, not just counted", async () => {
    stubScrollTo();
    const messages: ChatMessage[] = [
      { id: "u-1", role: "user", createdAt: 1, status: "complete", text: "跑一下 tick 循环" },
      {
        id: "a-1",
        role: "assistant",
        createdAt: 2,
        status: "complete",
        tools: [
          {
            tool_id: "t-1",
            name: "terminal",
            status: "done",
            startedAt: 1,
            completedAt: 2,
            summary: "tick-6\ntick-7\ntick-8",
          },
        ],
      },
    ];

    const { container } = render(
      <MemoryRouter>
        <MessageTimeline messages={messages} />
      </MemoryRouter>,
    );

    await act(async () => {
      fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    });
    const input = container.querySelector('input[aria-label="查找关键词"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "tick-7" } });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });

    const hit = container.querySelector('[data-find-hit="active"]') as HTMLElement | null;
    expect(hit).not.toBeNull();
    expect(hit?.textContent).toContain("tick-7");

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(container.querySelector("[data-find-hit]")).toBeNull();
  });

  it("keeps the highlight marker after the card's own DOM is rewritten", async () => {
    stubScrollTo();
    const messages: ChatMessage[] = [
      {
        id: "a-1",
        role: "assistant",
        createdAt: 2,
        status: "complete",
        tools: [
          {
            tool_id: "t-1",
            name: "terminal",
            status: "done",
            startedAt: 1,
            completedAt: 2,
            summary: "tick-6\ntick-7",
          },
        ],
      },
    ];

    const { container } = render(
      <MemoryRouter>
        <MessageTimeline messages={messages} />
      </MemoryRouter>,
    );

    await act(async () => {
      fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    });
    const input = container.querySelector('input[aria-label="查找关键词"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "tick-7" } });
    });

    const surface = container.querySelector('[data-tool-id="t-1"]') as HTMLElement;
    expect(surface).not.toBeNull();
    const firstHit = surface.querySelector('[data-find-hit="active"]') as HTMLElement | null;
    expect(firstHit).not.toBeNull();

    await act(async () => {
      const textNode = firstHit?.firstChild as Text | null;
      const body = textNode?.data ?? "";
      textNode?.replaceData(0, body.length, body);
      await new Promise((resolve) => setTimeout(resolve, 16));
    });

    expect(surface.querySelector('[data-find-hit="active"]')).not.toBeNull();
  });

  it("shows an interrupted tool run as 已中断 instead of a normal finish", async () => {
    stubScrollTo();
    const messages: ChatMessage[] = [
      {
        id: "a-1",
        role: "assistant",
        createdAt: 1_000,
        status: "complete",
        tools: [
          {
            tool_id: "t-1",
            name: "terminal",
            status: "done",
            startedAt: 1_000,
            completedAt: 19_000,
            context: "echo step1; sleep 60; echo step3",
            summary: "step1\n\n[Command interrupted]",
          },
        ],
      },
    ];

    const { container } = render(
      <MemoryRouter>
        <MessageTimeline messages={messages} />
      </MemoryRouter>,
    );

    const activity = container.querySelector("[data-interrupted]") as HTMLElement | null;
    expect(activity).not.toBeNull();
    expect(container.textContent).toContain("已中断");
    expect(container.textContent).not.toContain("运行了终端命令");
    expect(container.textContent).toContain("· 18s");
  });

  it("leaves a normally finished tool run without the interrupted hint", async () => {
    stubScrollTo();
    const messages: ChatMessage[] = [
      {
        id: "a-1",
        role: "assistant",
        createdAt: 1_000,
        status: "complete",
        tools: [
          {
            tool_id: "t-1",
            name: "terminal",
            status: "done",
            startedAt: 1_000,
            completedAt: 27_000,
            context: "echo step1",
            summary: "step1",
          },
        ],
      },
    ];

    const { container } = render(
      <MemoryRouter>
        <MessageTimeline messages={messages} />
      </MemoryRouter>,
    );

    expect(container.querySelector("[data-interrupted]")).toBeNull();
    expect(container.textContent).toContain("运行了终端命令");
  });

  it("strips the kernel steer wrapper and shows a short Chinese note instead", async () => {
    stubScrollTo();
    const steerText = [
      "",
      "",
      "[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output and not a new delivery when replayed from conversation history]",
      "别等了，只总结一句",
      "[/OUT-OF-BAND USER MESSAGE]",
    ].join("\n");
    const messages: ChatMessage[] = [
      { id: "u-1", role: "user", createdAt: 1, status: "complete", text: steerText },
      { id: "a-1", role: "assistant", createdAt: 2, status: "complete", text: "好" },
    ];

    const { container } = render(
      <MemoryRouter>
        <MessageTimeline messages={messages} />
      </MemoryRouter>,
    );

    expect(container.textContent).toContain("别等了，只总结一句");
    expect(container.textContent).toContain("（你在本轮运行中插话）");
    expect(container.textContent).not.toContain("OUT-OF-BAND");
    expect(container.textContent).not.toContain("not tool output");

    const copy = Array.from(container.querySelectorAll("button")).find(
      (node) => node.textContent === "复制",
    ) as HTMLButtonElement;
    expect(copy).not.toBeUndefined();
    expect(copyableMessageText(messages[0])).toBe("别等了，只总结一句");
  });

  it("jumps into history that the render window had dropped", async () => {
    stubScrollTo();
    const messages: ChatMessage[] = Array.from({ length: 100 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      createdAt: index + 1,
      status: "complete" as const,
      text: index === 0 ? "最早那条 needle-at-zero" : `第 ${index + 1} 条`,
    }));

    const { container } = render(
      <MemoryRouter>
        <MessageTimeline messages={messages} />
      </MemoryRouter>,
    );

    expect(container.textContent).not.toContain("needle-at-zero");

    await act(async () => {
      fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    });
    const input = container.querySelector('input[aria-label="查找关键词"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "needle-at-zero" } });
    });

    expect(container.querySelector("[data-find-counter]")?.textContent).toBe("第 1 处 / 共 1 处");
    expect(container.textContent).toContain("needle-at-zero");
  });

  it("steps through hits across messages and keeps the counter in sync", async () => {
    stubScrollTo();
    const messages: ChatMessage[] = [
      { id: "u-1", role: "user", createdAt: 1, status: "complete", text: "needle 在第一条" },
      { id: "a-1", role: "assistant", createdAt: 2, status: "complete", text: "needle 在第二条" },
    ];

    const { container } = render(
      <MemoryRouter>
        <MessageTimeline messages={messages} />
      </MemoryRouter>,
    );

    await act(async () => {
      fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    });
    const input = container.querySelector('input[aria-label="查找关键词"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "needle" } });
    });
    expect(container.querySelector("[data-find-counter]")?.textContent).toBe("第 1 处 / 共 2 处");

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(container.querySelector("[data-find-counter]")?.textContent).toBe("第 2 处 / 共 2 处");

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    });
    expect(container.querySelector("[data-find-counter]")?.textContent).toBe("第 1 处 / 共 2 处");
  });

  it("uses relative time inside the day and falls back to the clock past an hour", () => {
    const now = new Date(2026, 9, 23, 15, 30, 0).getTime();

    expect(formatMessageTime(now - 20_000, now)).toBe("刚刚");
    expect(formatMessageTime(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(formatMessageTime(now - 59 * 60_000, now)).toBe("59 分钟前");

    const hourAgo = now - 60 * 60_000;
    expect(formatMessageTime(hourAgo, now)).toBe(
      new Date(hourAgo).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    );

    const yesterday = new Date(2026, 9, 22, 9, 5, 0).getTime();
    expect(formatMessageTime(yesterday, now)).toBe(
      new Date(yesterday).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    );
  });

  it("exposes edit on user turns and retry on assistant turns", async () => {
    stubScrollTo();
    const messages: ChatMessage[] = [
      { id: "stored-11", role: "user", createdAt: 1, status: "complete", text: "帮我看下日志" },
      { id: "stored-12", role: "assistant", createdAt: 2, status: "complete", text: "日志没问题" },
    ];
    const onEditMessage = vi.fn();
    const onRetryMessage = vi.fn();

    const { container } = render(
      <MemoryRouter>
        <MessageTimeline
          messages={messages}
          onEditMessage={onEditMessage}
          onRetryMessage={onRetryMessage}
        />
      </MemoryRouter>,
    );

    const buttons = Array.from(container.querySelectorAll("button"));
    const edit = buttons.find((node) => node.textContent === "编辑") as HTMLButtonElement;
    const retry = buttons.find((node) => node.textContent === "重试") as HTMLButtonElement;
    expect(edit).toBeTruthy();
    expect(retry).toBeTruthy();
    expect(edit.title).toBe("编辑并重发");

    await act(async () => {
      fireEvent.click(edit);
    });
    expect(onEditMessage).toHaveBeenCalledWith(messages[0]);

    await act(async () => {
      fireEvent.click(retry);
    });
    expect(onRetryMessage).toHaveBeenCalledWith(messages[0]);
  });

  it("hides the correction actions when the route wires no handler", () => {
    const html = renderTimeline(
      <MessageTimeline
        messages={[
          { id: "stored-1", role: "user", createdAt: 1, status: "complete", text: "问题" },
          { id: "stored-2", role: "assistant", createdAt: 2, status: "complete", text: "回答" },
        ]}
      />,
    );

    expect(html).not.toContain("编辑");
    expect(html).not.toContain("重试");
  });

  it("disables both correction actions while the turn is streaming", async () => {
    stubScrollTo();
    const messages: ChatMessage[] = [
      { id: "stored-21", role: "user", createdAt: 1, status: "complete", text: "再试一次" },
      { id: "stored-22", role: "assistant", createdAt: 2, status: "complete", text: "好的" },
    ];
    const onEditMessage = vi.fn();
    const onRetryMessage = vi.fn();

    const { container } = render(
      <MemoryRouter>
        <MessageTimeline
          messages={messages}
          onEditMessage={onEditMessage}
          onRetryMessage={onRetryMessage}
          correctionLocked
          correctionLockedReason="正在生成回复，等这轮结束再纠正"
        />
      </MemoryRouter>,
    );

    const buttons = Array.from(container.querySelectorAll("button"));
    const edit = buttons.find((node) => node.textContent === "编辑") as HTMLButtonElement;
    const retry = buttons.find((node) => node.textContent === "重试") as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(retry.disabled).toBe(true);
    expect(edit.title).toBe("正在生成回复，等这轮结束再纠正");

    await act(async () => {
      fireEvent.click(edit);
      fireEvent.click(retry);
    });
    expect(onEditMessage).not.toHaveBeenCalled();
    expect(onRetryMessage).not.toHaveBeenCalled();
  });

  it("never offers retry on a reply that is still streaming", () => {
    const html = renderTimeline(
      <MessageTimeline
        messages={[
          { id: "stored-31", role: "user", createdAt: 1, status: "complete", text: "写个脚本" },
          { id: "stored-32", role: "assistant", createdAt: 2, status: "streaming", text: "正在写" },
        ]}
        onEditMessage={vi.fn()}
        onRetryMessage={vi.fn()}
      />,
    );

    expect(html).not.toContain("重试");
  });

  it("warns in the title that attachments do not come back with an edit", () => {
    const html = renderTimeline(
      <MessageTimeline
        messages={[
          {
            id: "stored-41",
            role: "user",
            createdAt: 1,
            status: "complete",
            text: "看图",
            images: [{ url: "blob:shot", name: "shot.png" }],
          },
        ]}
        onEditMessage={vi.fn()}
      />,
    );

    expect(html).toContain("附件不会被带回输入框");
  });

  it("turns both correction buttons into a pending spinner while the row is being resolved", async () => {
    stubScrollTo();
    const messages: ChatMessage[] = [
      { id: "live-user-1750000000000", role: "user", createdAt: 1, status: "complete", text: "再看一遍" },
      { id: "live-assistant-1750000000000", role: "assistant", createdAt: 2, status: "complete", text: "看完" },
    ];
    const onEditMessage = vi.fn();
    const onRetryMessage = vi.fn();

    const { container } = render(
      <MemoryRouter>
        <MessageTimeline
          messages={messages}
          onEditMessage={onEditMessage}
          onRetryMessage={onRetryMessage}
          correctionPendingMessageId="live-user-1750000000000"
        />
      </MemoryRouter>,
    );

    const pending = Array.from(
      container.querySelectorAll('button[data-correction-pending="true"]'),
    ) as HTMLButtonElement[];
    expect(pending).toHaveLength(2);
    for (const node of pending) {
      expect(node.textContent).toBe("定位中");
      expect(node.disabled).toBe(true);
      expect(node.title).toBe("正在重载会话记录，定位这条提问在内核里的位置");
    }

    await act(async () => {
      for (const node of pending) fireEvent.click(node);
    });
    expect(onEditMessage).not.toHaveBeenCalled();
    expect(onRetryMessage).not.toHaveBeenCalled();
  });

  it("renders file-write tools as their own cards outside the collapsed chain", () => {
    const message: ChatMessage = {
      id: "m-tools-1",
      role: "assistant",
      createdAt: 1,
      status: "complete",
      text: "",
      tools: [
        {
          tool_id: "call-write",
          name: "write_file",
          status: "done",
          startedAt: 1,
          completedAt: 2,
          arguments: { path: "src/a.ts", content: "const a = 1;\n" },
        },
        {
          tool_id: "call-terminal",
          name: "terminal",
          status: "done",
          startedAt: 2,
          completedAt: 3,
          arguments: { command: "ls" },
          summary: "a.ts",
        } as never,
      ],
    };

    const html = renderTimeline(<MessageTimeline messages={[message]} />);

    expect(html).toContain('data-file-write="true"');
    expect(html).toContain("src/a.ts");
    expect(html).toContain("+1");
    expect(html).toContain("完成");
  });

  it("folds file-write cards beyond five behind a summary entry", () => {
    const tools = Array.from({ length: 7 }, (_, index) => ({
      tool_id: `call-write-${index}`,
      name: "write_file",
      status: "done" as const,
      startedAt: index,
      completedAt: index + 1,
      arguments: { path: `src/f-${index}.ts`, content: "x\n" },
    }));
    const message: ChatMessage = {
      id: "m-tools-2",
      role: "assistant",
      createdAt: 1,
      status: "complete",
      text: "",
      tools: tools as never,
    };

    const html = renderTimeline(<MessageTimeline messages={[message]} />);

    expect(html.match(/data-file-write="true"/g)).toHaveLength(5);
    expect(html).toContain("还有 2 个文件变更");
  });

  it("never renders tail text for a running tool card while its elapsed time keeps ticking", () => {
    stubScrollTo();
    const startedAt = 1_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(startedAt + 2_000);
    try {
      const message: ChatMessage = {
        id: "m-tool-running",
        role: "assistant",
        createdAt: 1,
        status: "streaming",
        text: "",
        tools: [
          {
            tool_id: "call-running",
            name: "terminal",
            status: "running",
            startedAt,
            tail: ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6"].join("\n"),
          },
        ],
      };

      const { container } = render(
        <MemoryRouter>
          <MessageTimeline messages={[message]} />
        </MemoryRouter>,
      );

      // 运行中的活动组自动展开（#15），但工具行本身仍保持折叠（#14）。
      const summary = container.querySelector("button[data-open]") as HTMLButtonElement;
      expect(summary.textContent).toContain("正在运行终端命令");
      expect(summary.textContent).toContain("2.0s");
      expect(summary.getAttribute("data-open")).toBe("true");

      const header = container.querySelector("button[data-expandable]") as HTMLButtonElement;
      expect(header).not.toBeNull();
      expect(header.textContent).toContain("2.0s");
      expect(container.querySelector('[data-testid="tool-tail"]')).toBeNull();
      expect(container.textContent).not.toContain("line 1");

      act(() => {
        vi.advanceTimersByTime(4_000);
      });

      expect(header.textContent).toContain("6.0s");
      expect(summary.textContent).toContain("6.0s");
      expect(container.textContent).not.toContain("line 1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the full output of a finished tool card available behind expand", () => {
    stubScrollTo();
    const output = Array.from({ length: 12 }, (_, index) => `output line ${index + 1}`).join("\n");
    const message: ChatMessage = {
      id: "m-tool-done",
      role: "assistant",
      createdAt: 1,
      status: "complete",
      text: "",
      tools: [
        {
          tool_id: "call-done",
          name: "terminal",
          status: "done",
          startedAt: 1_000,
          completedAt: 2_500,
          summary: output,
        },
      ],
    };

    const { container } = render(
      <MemoryRouter>
        <MessageTimeline messages={[message]} />
      </MemoryRouter>,
    );

    expect(container.textContent).not.toContain("output line 1");

    const summary = container.querySelector("button[data-open]") as HTMLButtonElement;
    expect(summary.textContent).toContain("运行了终端命令");
    expect(summary.textContent).toContain("1.5s");
    expect(summary.getAttribute("data-open")).toBe("true");

    const header = container.querySelector("button[data-expandable]") as HTMLButtonElement;
    expect(header.textContent).toContain("terminal");
    fireEvent.click(header);

    expect(container.textContent).toContain("output line 1");
    expect(container.textContent).toContain("output line 12");
    expect(container.querySelector('[data-testid="tool-tail"]')).toBeNull();
  });

  const longMessages = (count: number): ChatMessage[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      createdAt: index + 1,
      status: "complete" as const,
      text: `第 ${index + 1} 条`,
    }));

  const scrollToTop = (scroller: HTMLElement) => {
    Object.defineProperty(scroller, "scrollHeight", { value: 4_000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
    scroller.scrollTop = 3_500;
    fireEvent.scroll(scroller);
    // 贴底跟随只由真实手势解除：上滚前先给一个滚轮手势。
    fireEvent.wheel(scroller, { deltaY: -120 });
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
  };

  it("auto-expands the local render window when the user scrolls to the top", async () => {
    stubScrollTo();
    const onLoadEarlier = vi.fn().mockResolvedValue(undefined);

    const { container } = render(
      <MemoryRouter>
        <MessageTimeline messages={longMessages(100)} hasEarlier onLoadEarlier={onLoadEarlier} />
      </MemoryRouter>,
    );

    expect(container.querySelectorAll("[data-message-index]")).toHaveLength(60);

    const scroller = container.querySelector('[role="log"]') as HTMLElement;
    await act(async () => {
      scrollToTop(scroller);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelectorAll("[data-message-index]")).toHaveLength(100);
    expect(container.textContent).toContain("第 1 条");
    expect(onLoadEarlier).not.toHaveBeenCalled();
    const mode = container.querySelector("[data-earlier-mode]");
    expect(mode?.getAttribute("data-earlier-mode")).toBe("server");
  });

  it("requests an earlier page on top scroll once the local window is exhausted", async () => {
    stubScrollTo();
    const onLoadEarlier = vi.fn().mockResolvedValue(undefined);

    const { container } = render(
      <MemoryRouter>
        <MessageTimeline messages={longMessages(60)} hasEarlier onLoadEarlier={onLoadEarlier} />
      </MemoryRouter>,
    );

    expect(container.querySelectorAll("[data-message-index]")).toHaveLength(60);

    const scroller = container.querySelector('[role="log"]') as HTMLElement;
    await act(async () => {
      scrollToTop(scroller);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onLoadEarlier).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.scroll(scroller);
    });
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it("copies a whole tool group as markdown from the group header", async () => {
    stubScrollTo();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    const message: ChatMessage = {
      id: "m-group",
      role: "assistant",
      createdAt: 1,
      status: "complete",
      text: "跑完了",
      tools: [
        { tool_id: "t1", name: "read_file", status: "done", startedAt: 1, completedAt: 2, context: "web/src", arguments: { path: "a.ts" }, summary: "export const a = 1;" },
        { tool_id: "t2", name: "read_file", status: "done", startedAt: 2, completedAt: 3, context: "web/src", arguments: { path: "b.ts" }, summary: "export const b = 2;" },
      ],
    };

    const { container } = render(
      <MemoryRouter>
        <MessageTimeline messages={[message]} />
      </MemoryRouter>,
    );

    const summary = Array.from(container.querySelectorAll("button")).find((node) =>
      node.textContent?.includes("使用了"),
    ) as HTMLButtonElement;
    expect(summary).toBeTruthy();
    expect(summary.getAttribute("data-open")).toBe("true");

    const groupCopy = Array.from(container.querySelectorAll("button")).find((node) =>
      node.textContent?.includes("复制组"),
    ) as HTMLButtonElement;
    expect(groupCopy).toBeTruthy();

    await act(async () => {
      fireEvent.click(groupCopy);
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("### read_file");
    expect(copied).toContain('"path": "a.ts"');
    expect(copied).toContain('"path": "b.ts"');
    expect(copied).toContain("export const b = 2;");
  });

  it("copies the whole turn including tool summaries from the message actions", async () => {
    stubScrollTo();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    const roundTool = {
      tool_id: "t1",
      name: "terminal",
      status: "done",
      startedAt: 1,
      completedAt: 2,
      arguments: { command: "pnpm test" },
      summary: "ok",
    } as unknown as ChatToolItem;

    const message: ChatMessage = {
      id: "m-round",
      role: "assistant",
      createdAt: 1,
      status: "complete",
      text: "先说结论",
      blocks: [
        { type: "text", text: "先说结论" },
        { type: "tool", tool: roundTool },
        { type: "text", text: "测试通过" },
      ],
    };

    const { container } = render(
      <MemoryRouter>
        <MessageTimeline messages={[message]} />
      </MemoryRouter>,
    );

    const roundCopy = Array.from(container.querySelectorAll("button")).find((node) =>
      node.textContent?.includes("复制整轮"),
    ) as HTMLButtonElement;
    expect(roundCopy).toBeTruthy();

    await act(async () => {
      fireEvent.click(roundCopy);
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied.startsWith("## Hermes")).toBe(true);
    expect(copied.indexOf("先说结论")).toBeLessThan(copied.indexOf("### terminal"));
    expect(copied.indexOf("### terminal")).toBeLessThan(copied.indexOf("测试通过"));
    expect(copied).toContain('"command": "pnpm test"');
  });

});
