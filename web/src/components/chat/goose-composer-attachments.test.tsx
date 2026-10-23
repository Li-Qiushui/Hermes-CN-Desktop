// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  LARGE_PASTE_ATTACHMENT_THRESHOLD,
  createPastedTextAttachment,
  largePasteNotice,
  pasteCharLabel,
  shouldConvertPasteToAttachment,
} from "./goose-composer-attachments";

describe("large paste policy", () => {
  it("only converts pastes strictly above the 3000 character threshold", () => {
    expect(LARGE_PASTE_ATTACHMENT_THRESHOLD).toBe(3000);
    expect(shouldConvertPasteToAttachment("a".repeat(2999))).toBe(false);
    expect(shouldConvertPasteToAttachment("a".repeat(3000))).toBe(false);
    expect(shouldConvertPasteToAttachment("a".repeat(3001))).toBe(true);
    expect(shouldConvertPasteToAttachment("")).toBe(false);
  });

  it("labels the paste size in Chinese", () => {
    expect(pasteCharLabel("a".repeat(3001))).toBe("3001 字");
    expect(pasteCharLabel("a".repeat(52000))).toBe("5.2 万字");
    expect(largePasteNotice("a".repeat(52000))).toBe("已粘入的 5.2 万字已转为附件");
  });

  it("builds a plain text browser-file attachment the send path already understands", () => {
    const text = "日志行\n".repeat(2000);
    const attachment = createPastedTextAttachment(text);

    expect(attachment.source).toBe("browser");
    expect(attachment.kind).toBe("file");
    expect(attachment.status).toBe("ready");
    expect(attachment.mimeType).toBe("text/plain");
    expect(attachment.name).toMatch(/^pasted-content-\d{6}-[0-9a-f]{1,4}\.txt$/);
    expect(attachment.size).toBe(new TextEncoder().encode(text).length);
    expect(attachment.file).toBeInstanceOf(File);
    expect(attachment.file!.name).toBe(attachment.name);
    expect(attachment.file!.type).toBe("text/plain");
    expect(attachment.previewUrl).toBeUndefined();
  });

  it("keeps every paste a distinct attachment", () => {
    const first = createPastedTextAttachment("x".repeat(4000));
    const second = createPastedTextAttachment("x".repeat(4000));
    expect(first.id).not.toBe(second.id);
    expect(first.name).not.toBe(second.name);
  });
});
