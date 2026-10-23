// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MentionChipRow, parseComposerMentions, removeComposerMention } from "./composer-chips";

afterEach(() => cleanup());

describe("parseComposerMentions", () => {
  it("finds backend reference tokens anywhere after whitespace", () => {
    const refs = parseComposerMentions("看下 @file:src/app.ts 和 @session:default/abc");

    expect(refs.map((ref) => ref.text)).toEqual(["@file:src/app.ts", "@session:default/abc"]);
    expect(refs[0]?.start).toBe(3);
    expect(refs[0]?.label).toBe("app.ts");
    expect(refs[0]?.kindLabel).toBe("文件");
    expect(refs[1]?.label).toBe("abc");
  });

  it("recognises bare @diff and @staged references", () => {
    const refs = parseComposerMentions("对比 @diff 和 @staged");

    expect(refs).toHaveLength(2);
    expect(refs[0]?.kind).toBe("simple");
    expect(refs[1]?.text).toBe("@staged");
  });

  it("ignores an @ that is not at a token boundary", () => {
    expect(parseComposerMentions("a@b.com")).toHaveLength(0);
    expect(parseComposerMentions("@file: 还没填值")).toHaveLength(0);
  });
});

describe("removeComposerMention", () => {
  const refs = parseComposerMentions("看 @file:src/a.ts 这个");

  it("splices the token out and keeps the sentence readable", () => {
    const next = removeComposerMention("看 @file:src/a.ts 这个", refs[0]!);

    expect(next.text).toBe("看 这个");
    expect(next.cursor).toBe(2);
  });

  it("drops the whole text when only the token is left", () => {
    const only = parseComposerMentions("@diff");
    expect(removeComposerMention("@diff", only[0]!)).toEqual({ text: "", cursor: 0 });
  });
});

describe("MentionChipRow", () => {
  it("renders one chip per reference and removes it by id", () => {
    const onRemove = vi.fn();
    const refs = parseComposerMentions("@folder:web/src 和 @url:https://example.com");
    render(<MentionChipRow mentions={refs} onRemove={onRemove} />);

    expect(screen.getByLabelText("已引用")).toBeTruthy();
    expect(screen.getByText("src")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "移除引用 @folder:web/src" }));
    expect(onRemove).toHaveBeenCalledWith(refs[0]);
  });

  it("renders nothing without references", () => {
    const { container } = render(<MentionChipRow mentions={[]} onRemove={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});
