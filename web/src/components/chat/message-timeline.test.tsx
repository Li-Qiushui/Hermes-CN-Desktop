/** @vitest-environment jsdom */
import ReactDOMServer from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownText } from "./markdown-renderer";
import {
  MessageTimeline,
  copyableMessageText,
  countRowsBelowViewport,
  findLastAnchorIndexAtOrAbove,
  formatMessageTime,
  resolveBottomFollowState,
  shouldAnchorToBottom,
  shouldDetachOnScroll,
  shouldForceBottomOnMessageChange,
  shouldShowJumpToBottom,
} from "./message-timeline";
import type { ChatMessage } from "./chat-types";

// MessageTimeline 内部的资料卡用到 useNavigate，SSR 渲染需要 Router 上下文。
const renderTimeline = (node: ReactElement) =>
  ReactDOMServer.renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

const stubScrollTo = () => {
  const scrollTo = vi.fn();
  (HTMLElement.prototype as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
  return scrollTo;
};

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
  it("keeps bottom auto-follow disabled after an explicit upward scroll", () => {
    expect(resolveBottomFollowState(40, true)).toEqual({
      nearBottom: false,
      userDetachedFromBottom: true,
    });
  });

  it("reattaches bottom auto-follow only after returning to the bottom", () => {
    expect(resolveBottomFollowState(8, true)).toEqual({
      nearBottom: true,
      userDetachedFromBottom: false,
    });
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

  it("renders read-aloud controls only for completed assistant messages", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", createdAt: 1, text: "问题" },
      { id: "assistant-1", role: "assistant", createdAt: 2, status: "complete", text: "回答" },
    ];

    const html = renderTimeline(
      <MessageTimeline messages={messages} />,
    );

    expect(html).toContain('title="朗读回复"');
    expect(html).toContain("朗读");
  });

  it("does not render read-aloud controls for user or streaming assistant messages", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", createdAt: 1, text: "问题" },
      { id: "assistant-1", role: "assistant", createdAt: 2, status: "streaming", text: "回答中" },
    ];

    const html = renderTimeline(
      <MessageTimeline messages={messages} />,
    );

    expect(html).not.toContain('title="朗读回复"');
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

  it("asks the server for an earlier page and shows the loading state", async () => {
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

    const loadButton = Array.from(container.querySelectorAll("button")).find((node) =>
      node.textContent?.includes("加载更早的消息"),
    ) as HTMLButtonElement;
    expect(loadButton).toBeTruthy();

    await act(async () => {
      fireEvent.click(loadButton);
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

    expect(container.textContent).toContain("显示更早的 40 条消息（已加载）");
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
    expect(container.textContent).toContain("显示更早的 40 条消息（已加载）");
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

    const loadButton = Array.from(container.querySelectorAll("button")).find((node) =>
      node.textContent?.includes("加载更早的消息"),
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(loadButton);
    });

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
    expect(shouldAnchorToBottom(false, true, false, 0)).toBe(false);
    expect(shouldAnchorToBottom(false, true, false, 0.5)).toBe(false);
    expect(shouldAnchorToBottom(false, true, false, 24)).toBe(true);
  });

  it("keeps every bottom-follow guard ahead of the scrollTop write", () => {
    expect(shouldAnchorToBottom(true, true, true, 400)).toBe(false);
    expect(shouldAnchorToBottom(false, false, false, 400)).toBe(false);
    expect(shouldAnchorToBottom(false, false, true, 400)).toBe(true);
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

  it("shows the jump-to-bottom control only once the viewport left the bottom", () => {
    expect(shouldShowJumpToBottom(false, 0)).toBe(false);
    expect(shouldShowJumpToBottom(false, 40)).toBe(false);
    expect(shouldShowJumpToBottom(false, 400)).toBe(true);
    expect(shouldShowJumpToBottom(true, 0)).toBe(true);
  });

  it("counts the rows below the viewport with a binary search, including none", () => {
    const tops = [0, 120, 260, 400, 640];
    const belowAt = (limit: number) => countRowsBelowViewport(tops.length, (i) => tops[i] > limit);

    expect(belowAt(1_000)).toBe(0);
    expect(belowAt(400)).toBe(1);
    expect(belowAt(120)).toBe(3);
    expect(belowAt(-1)).toBe(5);
    expect(countRowsBelowViewport(0, () => true)).toBe(0);

    const long = Array.from({ length: 500 }, (_, index) => index * 40);
    expect(countRowsBelowViewport(long.length, (i) => long[i] > 123 * 40)).toBe(376);
  });

  it("renders the jump-to-bottom control only after the user detached", () => {
    const messages: ChatMessage[] = [
      { id: "u-1", role: "user", createdAt: 1, text: "问题" },
      { id: "a-1", role: "assistant", createdAt: 2, text: "回答" },
    ];

    const html = renderTimeline(<MessageTimeline messages={messages} />);

    expect(html).not.toContain("回到底部");
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

  it("reveals the jump control with the count below the viewport and jumps on click", async () => {
    const scrollTo = vi.fn();
    (HTMLElement.prototype as unknown as { scrollTo: unknown }).scrollTo = scrollTo;

    const messages: ChatMessage[] = Array.from({ length: 5 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      createdAt: index + 1,
      status: "complete" as const,
      text: `第 ${index + 1} 条`,
    }));

    const { container } = render(
      <MemoryRouter>
        <MessageTimeline messages={messages} />
      </MemoryRouter>,
    );

    const scroller = container.querySelector('[role="log"]') as HTMLElement;
    Object.defineProperty(scroller, "scrollHeight", { value: 2_400, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
    scroller.scrollTop = 0;

    const rows = Array.from(scroller.querySelectorAll("[data-message-index]"));
    rows.forEach((row, index) => {
      (row as HTMLElement).getBoundingClientRect = () =>
        ({ top: 500 + index * 100, bottom: 600 + index * 100 }) as DOMRect;
    });

    await act(async () => {
      fireEvent.scroll(scroller);
      await new Promise((resolve) => setTimeout(resolve, 32));
    });

    const button = container.querySelector('button[aria-label^="回到底部"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent).toContain("下面还有 5 条");

    await act(async () => {
      fireEvent.click(button);
    });

    expect(scrollTo).toHaveBeenCalled();
    expect(container.querySelector('button[aria-label^="回到底部"]')).toBeNull();
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

});
