/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "./chat-types";
import { ConfirmTruncateDialog, truncateDialogCopy } from "./confirm-truncate-dialog";
import { MessageTimeline } from "./message-timeline";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  (globalThis as any).ResizeObserver = ResizeObserverMock;
  (HTMLElement.prototype as unknown as { scrollTo: unknown }).scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;
  vi.restoreAllMocks();
});

const userAsk: ChatMessage = {
  id: "stored-21",
  role: "user",
  createdAt: 21,
  status: "complete",
  text: "帮我把这批文件重命名",
};

const assistantReply: ChatMessage = {
  id: "stored-22",
  role: "assistant",
  createdAt: 22,
  status: "complete",
  text: "已经改好了",
};

describe("segment delete action", () => {
  it("offers 删除 on the user's own questions", () => {
    const onDeleteMessage = vi.fn();
    render(
      <MemoryRouter>
        <MessageTimeline messages={[userAsk]} onDeleteMessage={onDeleteMessage} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText("删除"));
    expect(onDeleteMessage).toHaveBeenCalledWith(userAsk);
  });

  it("does not offer 删除 on assistant replies", () => {
    render(
      <MemoryRouter>
        <MessageTimeline
          messages={[userAsk, assistantReply]}
          onDeleteMessage={() => {}}
          onRetryMessage={() => {}}
        />
      </MemoryRouter>,
    );
    expect(screen.getAllByText("删除")).toHaveLength(1);
  });

  it("shows 定位中 while the kernel row is being resolved", () => {
    render(
      <MemoryRouter>
        <MessageTimeline
          messages={[userAsk]}
          onDeleteMessage={() => {}}
          correctionPendingMessageId={userAsk.id}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByText("删除")).toBeNull();
    expect(screen.getByText("定位中")).toBeTruthy();
  });

  it("keeps 删除 hidden when no handler is wired", () => {
    render(
      <MemoryRouter>
        <MessageTimeline messages={[userAsk]} />
      </MemoryRouter>,
    );
    expect(screen.queryByText("删除")).toBeNull();
  });
});

describe("delete confirmation copy", () => {
  it("spells out that the question and everything after it goes away", () => {
    const copy = truncateDialogCopy(3, "delete");
    expect(copy.title).toBe("删除这条提问及之后的消息？");
    expect(copy.description).toContain("将删除这条提问及其之后的全部消息");
    expect(copy.description).toContain("共 4 条");
    expect(copy.confirmLabel).toBe("删除");
  });

  it("still defaults to the resend wording", () => {
    expect(truncateDialogCopy(2).title).toBe("删除后续消息并重发？");
    expect(truncateDialogCopy(2).confirmLabel).toBe("删除后续并重发");
  });

  it("renders the delete wording inside the shared dialog", async () => {
    render(
      <ConfirmTruncateDialog
        open
        removedCount={2}
        mode="delete"
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("删除这条提问及之后的消息？");
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "删除后续并重发" })).toBeNull();
  });
});
