// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { ConfirmTruncateDialog, truncateRemovalSummary } from "./confirm-truncate-dialog";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  (globalThis as any).ResizeObserver = ResizeObserverMock;
  document.body.innerHTML = "";
});

interface HarnessProps {
  removedCount: number | null;
  onCancel?: () => void;
  onConfirm?: () => void;
}

function Harness({ removedCount, onCancel, onConfirm }: HarnessProps) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <ConfirmTruncateDialog
        open={open}
        removedCount={removedCount}
        onCancel={() => {
          onCancel?.();
          setOpen(false);
        }}
        onConfirm={() => {
          onConfirm?.();
          setOpen(false);
        }}
      />
    </>
  );
}

function FocusHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open-confirm
      </button>
      <ConfirmTruncateDialog
        open={open}
        removedCount={1}
        onCancel={() => setOpen(false)}
        onConfirm={() => setOpen(false)}
      />
    </>
  );
}

describe("ConfirmTruncateDialog", () => {
  it("以 alertdialog 暴露，初始焦点落在取消上", async () => {
    render(<Harness removedCount={3} />);

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
    });
  });

  it("文案说明会删除后续 N 条且不可撤销", async () => {
    render(<Harness removedCount={3} />);

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("它之后的 3 条消息");
    expect(dialog.textContent).toContain("删了没法恢复");
  });

  it("拿不到条数时写「所有消息」", async () => {
    render(<Harness removedCount={null} />);

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("它之后的所有消息");
  });

  it("危险按钮用 danger 描边，不是实心主色", async () => {
    render(<Harness removedCount={2} />);

    const confirm = await screen.findByRole("button", { name: "删除后续并重发" });
    expect(confirm.getAttribute("data-tone")).toBe("danger");
    expect(confirm.getAttribute("data-variant")).toBe("outline");
  });

  it("点确认回调 onConfirm", async () => {
    const onConfirm = vi.fn();
    render(<Harness removedCount={2} onConfirm={onConfirm} />);

    fireEvent.click(await screen.findByRole("button", { name: "删除后续并重发" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("Esc 关闭按取消处理", async () => {
    const onCancel = vi.fn();
    render(<Harness removedCount={2} onCancel={onCancel} />);

    await screen.findByRole("alertdialog");
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("点遮罩关闭按取消处理", async () => {
    const onCancel = vi.fn();
    render(<Harness removedCount={2} onCancel={onCancel} />);

    await screen.findByRole("alertdialog");
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  it("关闭后焦点回到触发按钮", async () => {
    render(<FocusHarness />);

    const trigger = screen.getByRole("button", { name: "open-confirm" });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole("alertdialog");

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe("truncateRemovalSummary", () => {
  it("有精确条数时用数字", () => {
    expect(truncateRemovalSummary(4)).toBe("它之后的 4 条消息（回复和后续提问）");
  });

  it("null 时退回「所有消息」", () => {
    expect(truncateRemovalSummary(null)).toBe("它之后的所有消息（回复和后续提问）");
  });
});
