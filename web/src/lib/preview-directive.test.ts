import { describe, expect, it } from "vitest";

import { describePreviewError, isHtmlPreviewFile, splitPreviewDirectives } from "./preview-directive";

const previews = (text: string) =>
  splitPreviewDirectives(text).filter((segment) => segment.kind === "preview");

describe("splitPreviewDirectives", () => {
  it("拆出独立成段的指令", () => {
    const segments = splitPreviewDirectives('先看这个\n\n::preview{file="demo.html"}\n\n后面还有');
    expect(segments).toEqual([
      { kind: "prose", text: "先看这个\n\n" },
      { kind: "preview", file: "demo.html" },
      { kind: "prose", text: "\n\n后面还有" },
    ]);
  });

  it("识别夹在句子中间的指令", () => {
    const segments = splitPreviewDirectives('看这里 ::preview{file="D:/work/a.html"} 就行');
    expect(segments).toEqual([
      { kind: "prose", text: "看这里 " },
      { kind: "preview", file: "D:/work/a.html" },
      { kind: "prose", text: " 就行" },
    ]);
  });

  it("剥掉一层反引号后仍能识别", () => {
    const segments = splitPreviewDirectives('看这里 `::preview{file="b.html"}` 就行');
    expect(segments).toEqual([
      { kind: "prose", text: "看这里  " },
      { kind: "preview", file: "b.html" },
      { kind: "prose", text: "  就行" },
    ]);
  });

  it("剥掉围栏代码块包装后仍能识别", () => {
    const segments = splitPreviewDirectives('```html\n::preview{file="c.html"}\n```');
    expect(segments).toEqual([{ kind: "preview", file: "c.html" }]);
  });

  it("缺 file 时整段保持原文，不半渲染", () => {
    const text = '::preview{path="d.html"}';
    expect(splitPreviewDirectives(text)).toEqual([{ kind: "prose", text }]);
  });

  it("大括号不闭合时整段保持原文", () => {
    const text = '::preview{file="e.html"\n到这里就结束了';
    expect(splitPreviewDirectives(text)).toEqual([{ kind: "prose", text }]);
  });

  it("普通围栏代码块里的指令不做渲染", () => {
    const text = '```js\nconst x = 1\n::preview{file="f.html"}\n```';
    expect(previews(text)).toHaveLength(0);
  });

  it("不接受非空白前导的伪指令", () => {
    expect(previews('std::preview{file="g.html"}')).toHaveLength(0);
  });

  it("单引号属性也认", () => {
    expect(previews("::preview{file='h.html'}")).toEqual([{ kind: "preview", file: "h.html" }]);
  });

  it("超长文本整体按普通文本处理", () => {
    const text = `${"x".repeat(4900)}\n::preview{file="i.html"}`;
    expect(splitPreviewDirectives(text)).toEqual([{ kind: "prose", text }]);
  });

  it("识别可预览的 html 扩展名", () => {
    expect(isHtmlPreviewFile("a/b/index.html")).toBe(true);
    expect(isHtmlPreviewFile("C:\\tmp\\x.HTM")).toBe(true);
    expect(isHtmlPreviewFile("a/readme.md")).toBe(false);
  });
});

describe("describePreviewError", () => {
  it("404 映射成文件不存在文案，不透出响应体", () => {
    const copy = describePreviewError(new Error('HTTP 404: {"detail": "File not found"}'));

    expect(copy.kind).toBe("missing");
    expect(copy.title).toBe("文件不存在，可能已被删除或移动");
    expect(copy.title).not.toContain("{");
    expect(copy.title).not.toContain("HTTP ");
    expect(copy.hint ?? "").not.toContain("{");
    expect(copy.hint ?? "").not.toContain("HTTP ");
  });

  it("其它错误给通用文案加一行小字", () => {
    const copy = describePreviewError(new Error("HTTP 500: {\"error\":\"boom\"}"));

    expect(copy.kind).toBe("failed");
    expect(copy.title).toBe("预览加载失败");
    expect(copy.hint).toBeTruthy();
    expect(`${copy.title}${copy.hint}`).not.toContain("{");
    expect(`${copy.title}${copy.hint}`).not.toContain("HTTP ");
  });

  it("非 Error 抛值也不炸，走通用文案", () => {
    for (const thrown of [undefined, null, 42, { whatever: true }]) {
      const copy = describePreviewError(thrown);
      expect(copy.kind).toBe("failed");
      expect(copy.title).toBe("预览加载失败");
    }
  });
});
