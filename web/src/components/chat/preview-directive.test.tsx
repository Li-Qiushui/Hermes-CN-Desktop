// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readLocalTextFile } = vi.hoisted(() => ({ readLocalTextFile: vi.fn() }));

vi.mock("@/lib/local-file-read", () => ({ readLocalTextFile }));

import { MarkdownText } from "./markdown-renderer";
import { PreviewDirective } from "./preview-directive";

const htmlFile = (text: string) => ({
  binary: false,
  byteSize: text.length,
  mimeType: "text/html",
  path: "D:/work/demo.html",
  text,
  truncated: false,
});

const binaryFile = { binary: true, byteSize: 12, path: "D:/work/demo.html", text: "", truncated: false };

beforeEach(() => {
  readLocalTextFile.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("PreviewDirective", () => {
  it("html 文件渲染成沙箱 iframe，沙箱里没有 allow-same-origin", async () => {
    readLocalTextFile.mockResolvedValue(htmlFile("<h1>你好</h1>"));

    const { container } = render(createElement(PreviewDirective, { file: "D:/work/demo.html" }));

    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe") as HTMLIFrameElement;

    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("srcdoc")).toBe("<h1>你好</h1>");
    expect(readLocalTextFile).toHaveBeenCalledWith("D:/work/demo.html");
  });

  it("非 html 走文件卡，不发请求", async () => {
    const { container, getByText } = render(createElement(PreviewDirective, { file: "D:/work/notes.md" }));

    expect(container.querySelector('[data-preview="card"]')).not.toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(getByText("notes.md")).toBeTruthy();
    expect(getByText("复制路径")).toBeTruthy();
    expect(readLocalTextFile).not.toHaveBeenCalled();
  });

  it("流式期间先出骨架，不读文件", async () => {
    readLocalTextFile.mockResolvedValue(htmlFile("<p>x</p>"));

    const { container, rerender } = render(
      createElement(PreviewDirective, { file: "D:/work/demo.html", streaming: true }),
    );

    expect(container.querySelector('[data-preview="skeleton"]')).not.toBeNull();
    expect(readLocalTextFile).not.toHaveBeenCalled();

    rerender(createElement(PreviewDirective, { file: "D:/work/demo.html", streaming: false }));

    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
  });

  it("二进制文件降级成文件卡", async () => {
    readLocalTextFile.mockResolvedValue(binaryFile);

    const { container, getByText } = render(createElement(PreviewDirective, { file: "D:/work/demo.html" }));

    await waitFor(() => expect(container.querySelector('[data-preview="card"]')).not.toBeNull());
    expect(getByText("该文件是二进制内容，不能内联预览")).toBeTruthy();
  });

  it("读取失败出中文降级卡，重试后能渲染", async () => {
    readLocalTextFile.mockRejectedValueOnce(new Error("读取失败：权限不足"));
    readLocalTextFile.mockResolvedValueOnce(htmlFile("<p>retry</p>"));

    const { container, getByText } = render(createElement(PreviewDirective, { file: "D:/work/demo.html" }));

    await waitFor(() => expect(container.querySelector('[data-preview="error"]')).not.toBeNull());
    expect(getByText("预览加载失败")).toBeTruthy();
    expect(getByText("读取文件时出错，请稍后重试")).toBeTruthy();

    fireEvent.click(getByText("重试"));

    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(readLocalTextFile).toHaveBeenCalledTimes(2);
  });

  it("文件不存在时只说人话，不抄 HTTP 响应体", async () => {
    readLocalTextFile.mockRejectedValueOnce(new Error('HTTP 404: {"detail": "File not found"}'));

    const { container, getByText } = render(createElement(PreviewDirective, { file: "D:/work/gone.html" }));

    await waitFor(() => expect(container.querySelector('[data-preview="error"]')).not.toBeNull());
    expect(getByText("文件不存在，可能已被删除或移动")).toBeTruthy();
    expect(getByText("重试")).toBeTruthy();

    const text = container.querySelector('[data-preview="error"]')?.textContent ?? "";
    expect(text).not.toContain("{");
    expect(text).not.toContain("HTTP ");
    expect(text).not.toContain("File not found");
  });

  it("其它失败也只给通用文案，不带状态码和 JSON", async () => {
    readLocalTextFile.mockRejectedValueOnce(new Error('HTTP 500: {"error": "core exploded"}'));

    const { container, getByText } = render(createElement(PreviewDirective, { file: "D:/work/demo.html" }));

    await waitFor(() => expect(container.querySelector('[data-preview="error"]')).not.toBeNull());
    expect(getByText("预览加载失败")).toBeTruthy();
    expect(getByText("读取文件时出错，请稍后重试")).toBeTruthy();

    const text = container.querySelector('[data-preview="error"]')?.textContent ?? "";
    expect(text).not.toContain("{");
    expect(text).not.toContain("HTTP ");
    expect(text).not.toContain("core exploded");
    expect(text).not.toContain("500");
  });

  it("展开按钮把高度切到 70vh", async () => {
    readLocalTextFile.mockResolvedValue(htmlFile("<p>size</p>"));

    const { container, getByText } = render(createElement(PreviewDirective, { file: "D:/work/demo.html" }));

    await waitFor(() => expect(container.querySelector('[data-preview="frame"]')).not.toBeNull());
    const frame = container.querySelector('[data-preview="frame"]') as HTMLElement;

    expect(frame.style.height).toBe("360px");

    fireEvent.click(getByText("展开"));
    expect(frame.style.height).toBe("70vh");

    fireEvent.click(getByText("收起"));
    expect(frame.style.height).toBe("360px");
  });
});

describe("MarkdownText 接入 preview 指令", () => {
  it("句子中间的指令渲染成预览组件，正文仍走 markdown", async () => {
    readLocalTextFile.mockResolvedValue(htmlFile("<p>inline</p>"));

    const { container } = render(
      createElement(MarkdownText, { text: '看这里 ::preview{file="D:/work/demo.html"} 就行' }),
    );

    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(container.textContent).toContain("看这里");
    expect(container.textContent).toContain("就行");
    expect(container.textContent).not.toContain("::preview");
  });
});
