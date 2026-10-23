// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const counter = vi.hoisted(() => ({ highlight: 0, cached: 0 }));

vi.mock("@streamdown/code", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@streamdown/code")>();
  return {
    ...actual,
    createCodePlugin: (options?: Parameters<typeof actual.createCodePlugin>[0]) => {
      const plugin = actual.createCodePlugin(options);
      return {
        ...plugin,
        highlight: (request: Parameters<typeof plugin.highlight>[0], callback?: Parameters<typeof plugin.highlight>[1]) => {
          counter.highlight += 1;
          const result = plugin.highlight(request, (tokens) => {
            counter.cached += 1;
            callback?.(tokens);
          });
          if (result) counter.cached += 1;
          return result;
        },
      };
    },
  };
});

import { MarkdownText } from "./markdown-renderer";

const highlightedSpans = (container: HTMLElement): HTMLElement[] =>
  Array.from(
    container.querySelectorAll<HTMLElement>('[data-streamdown="code-block-body"] code span[style*="--sdm-c"]'),
  ).filter((span) => /--shiki-dark:\s*#[0-9a-f]{3,8}/i.test(span.getAttribute("style") ?? ""));

afterEach(() => {
  cleanup();
});

describe("MarkdownText code highlight throttling", () => {
  it("coalesces a growing streaming code block instead of highlighting every delta", async () => {
    const lines = Array.from({ length: 40 }, (_, index) => `const item${index} = ${index * 2};`);
    const textFor = (count: number) => "```ts\n" + lines.slice(0, count).join("\n") + "\n```";

    const { container, rerender } = render(createElement(MarkdownText, { text: textFor(1), streaming: true }));

    for (let count = 2; count <= lines.length; count += 1) {
      rerender(createElement(MarkdownText, { text: textFor(count), streaming: true }));
      await new Promise((resolve) => setTimeout(resolve, 3));
    }

    rerender(createElement(MarkdownText, { text: textFor(lines.length), streaming: false }));

    await waitFor(
      () => {
        expect(highlightedSpans(container).length).toBeGreaterThan(0);
      },
      { timeout: 20000 },
    );

    expect(counter.highlight).toBeGreaterThan(0);
    expect(counter.highlight).toBeLessThan(lines.length / 2);
    expect(container.querySelector('[data-streamdown="code-block-body"]')?.textContent ?? "").toContain(
      "const item39 = 78;",
    );
  }, 30000);
});
