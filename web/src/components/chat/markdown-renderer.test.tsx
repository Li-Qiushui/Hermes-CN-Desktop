// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { capturedProps, parseCalls } = vi.hoisted(() => ({
  capturedProps: [] as Array<Record<string, unknown>>,
  parseCalls: { count: 0 },
}));

vi.mock("streamdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("streamdown")>();
  const Streamdown = (props: Record<string, unknown>) => {
    capturedProps.push(props);
    return createElement(actual.Streamdown as never, props as never);
  };
  const parseMarkdownIntoBlocks = (markdown: string) => {
    parseCalls.count += 1;
    return actual.parseMarkdownIntoBlocks(markdown);
  };
  return { ...actual, Streamdown, parseMarkdownIntoBlocks };
});

import { MarkdownText } from "./markdown-renderer";

const latestProps = (): Record<string, unknown> => capturedProps[capturedProps.length - 1] ?? {};

const codeBody = (container: HTMLElement) => container.querySelector('[data-streamdown="code-block-body"]');

const tokenSpans = (container: HTMLElement): HTMLElement[] =>
  Array.from(
    container.querySelectorAll<HTMLElement>('[data-streamdown="code-block-body"] code span[style*="--sdm-c"]'),
  );

const highlightedSpans = (container: HTMLElement): HTMLElement[] =>
  tokenSpans(container).filter((span) => /--shiki-dark:\s*#[0-9a-f]{3,8}/i.test(span.getAttribute("style") ?? ""));

afterEach(() => {
  cleanup();
});

describe("MarkdownText mode", () => {
  it("switches to the static branch once streaming ends", () => {
    const { rerender } = render(createElement(MarkdownText, { text: "hello", streaming: true }));
    expect(latestProps().mode).toBe("streaming");

    rerender(createElement(MarkdownText, { text: "hello", streaming: false }));
    expect(latestProps().mode).toBe("static");

    rerender(createElement(MarkdownText, { text: "hello", streaming: true }));
    expect(latestProps().mode).toBe("streaming");
  });

  it("reuses the parsed block array for unchanged text", () => {
    render(createElement(MarkdownText, { text: "first paragraph\n\nsecond paragraph" }));
    const parseBlocks = latestProps().parseMarkdownIntoBlocksFn as (markdown: string) => string[];

    const first = parseBlocks("first paragraph\n\nsecond paragraph");
    const second = parseBlocks("first paragraph\n\nsecond paragraph");
    const other = parseBlocks("first paragraph\n\nsecond paragraph\n\nthird");

    expect(first.length).toBeGreaterThan(1);
    expect(first.join("")).toBe("first paragraph\n\nsecond paragraph");
    expect(second).toBe(first);
    expect(other).not.toBe(first);
    expect(other.join("")).toBe("first paragraph\n\nsecond paragraph\n\nthird");
  });

  it("does not reparse the document when the stream ends on unchanged text", () => {
    const text = "first paragraph\n\nsecond paragraph\n\n- one\n- two";
    parseCalls.count = 0;
    const { rerender } = render(createElement(MarkdownText, { text, streaming: true }));
    const afterStreaming = parseCalls.count;

    rerender(createElement(MarkdownText, { text, streaming: false }));

    expect(afterStreaming).toBe(1);
    expect(parseCalls.count).toBe(afterStreaming);
  });
});

describe("MarkdownText code blocks", () => {
  it("keeps unknown languages as plain text and keeps the copy control", async () => {
    const { container } = render(
      createElement(MarkdownText, { text: "```notalang\nconst value = 1;\nconsole.log(value);\n```" }),
    );

    await waitFor(() => {
      expect(container.textContent).toContain("console.log(value);");
    });

    expect(highlightedSpans(container)).toHaveLength(0);
    expect(
      tokenSpans(container).every((span) => (span.getAttribute("style") ?? "").includes("inherit")),
    ).toBe(true);
    expect(container.querySelector('[data-streamdown="code-block-copy-button"]')).toBeTruthy();
    expect(codeBody(container)?.textContent ?? "").toContain("console.log(value);");
  });

  it("highlights a known language with light and dark token colors", async () => {
    const { container } = render(createElement(MarkdownText, { text: "```ts\nconst total: number = 42;\n```" }));

    await waitFor(
      () => {
        expect(highlightedSpans(container).length).toBeGreaterThan(0);
      },
      { timeout: 20000 },
    );

    const styles = highlightedSpans(container).map((span) => span.getAttribute("style") ?? "");
    expect(styles.some((style) => /--sdm-c:\s*#D73A49/i.test(style))).toBe(true);
    expect(codeBody(container)?.textContent ?? "").toContain("const total");
  });

  it("reaches a highlighted final state after a throttled streaming burst", async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `const row${index} = ${index};`);
    const textFor = (count: number) => "```ts\n" + lines.slice(0, count).join("\n") + "\n```";

    const { container, rerender } = render(createElement(MarkdownText, { text: textFor(1), streaming: true }));

    for (let count = 2; count <= lines.length; count += 1) {
      rerender(createElement(MarkdownText, { text: textFor(count), streaming: true }));
      await new Promise((resolve) => setTimeout(resolve, 4));
    }

    rerender(createElement(MarkdownText, { text: textFor(lines.length), streaming: false }));

    await waitFor(
      () => {
        expect(highlightedSpans(container).length).toBeGreaterThan(0);
      },
      { timeout: 20000 },
    );

    expect(codeBody(container)?.textContent ?? "").toContain("const row29 = 29;");
    expect(codeBody(container)?.textContent ?? "").not.toContain("```");
  });

  it("renders inline math through the memoized plugin", async () => {
    const { container, rerender } = render(createElement(MarkdownText, { text: "energy $E = mc^2$ here" }));

    await waitFor(() => {
      expect(container.querySelector(".katex")).toBeTruthy();
    });

    rerender(createElement(MarkdownText, { text: "energy $E = mc^2$ and $a^2 + b^2$ here" }));

    await waitFor(() => {
      expect(container.querySelectorAll(".katex").length).toBe(2);
    });
  });

  it("renders a fenced math block as display math", async () => {
    const { container } = render(createElement(MarkdownText, { text: "```math\nx = \\frac{1}{2}\n```" }));

    await waitFor(() => {
      expect(container.querySelector(".katex-display")).toBeTruthy();
    });
  });
});
