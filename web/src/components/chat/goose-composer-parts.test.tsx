// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComposerAttachment } from "./composer-types";
import { AttachmentTray } from "./attachment-preview";
import { createPastedTextAttachment, isAttachmentBusy } from "./goose-composer-attachments";
import { ContextIndicator } from "./goose-composer-context";
import type { ComposerContextUsage } from "./composer-types";

afterEach(() => cleanup());

const attachment: ComposerAttachment = {
  id: "att-1",
  source: "browser",
  name: "demo.txt",
  kind: "file",
  status: "ready",
  size: 2048,
};

describe("AttachmentTray", () => {
  it("renders nothing with no attachments", () => {
    const { container } = render(<AttachmentTray attachments={[]} onRemove={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("removes an attachment via its button", () => {
    const onRemove = vi.fn();
    render(<AttachmentTray attachments={[attachment]} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "移除 demo.txt" }));
    expect(onRemove).toHaveBeenCalledWith("att-1");
  });

  it("previews an image attachment as a zoomable thumbnail", () => {
    const image: ComposerAttachment = {
      ...attachment,
      id: "att-img",
      name: "shot.png",
      kind: "image",
      previewUrl: "blob:preview",
    };
    render(<AttachmentTray attachments={[image]} onRemove={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "查看大图：shot.png" }));
    expect(screen.getByRole("dialog", { name: "查看大图：shot.png" })).toBeTruthy();
  });

  it("labels a large pasted text attachment with its character count", () => {
    const pasted = createPastedTextAttachment("a".repeat(4200));
    render(<AttachmentTray attachments={[pasted]} onRemove={vi.fn()} />);

    expect(screen.getByText("粘贴内容 4200 字")).toBeTruthy();
    expect(screen.getByRole("button", { name: `移除 ${pasted.name}` })).toBeTruthy();
  });

  it("disables the remove button while uploading", () => {
    const onRemove = vi.fn();
    render(
      <AttachmentTray
        attachments={[{ ...attachment, status: "uploading", progress: 50 }]}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "移除 demo.txt" }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(isAttachmentBusy({ ...attachment, status: "uploading" })).toBe(true);
  });
});

describe("ContextIndicator", () => {
  const usage: ComposerContextUsage = {
    used: 90_000,
    max: 200_000,
    model: "fake-model",
    estimated: false,
  };

  it("toggles the context popover and shows usage", () => {
    render(<ContextIndicator usage={usage} />);
    const button = screen.getByRole("button", { name: "上下文窗口" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(button);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/90.0k \/ 200k/)).toBeTruthy();
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
