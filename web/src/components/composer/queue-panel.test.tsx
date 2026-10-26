// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueuePanel } from "./queue-panel";
import type { QueuedPromptEntry } from "@/stores/composer-queue";

afterEach(() => cleanup());

function makeEntry(partial: Partial<QueuedPromptEntry> = {}): QueuedPromptEntry {
  return {
    id: "q1",
    text: "帮我写一个测试",
    attachments: [],
    queuedAt: 0,
    ...partial,
  };
}

describe("QueuePanel", () => {
  it("renders nothing with an empty queue", () => {
    const { container } = render(
      <QueuePanel entries={[]} busy={false} editingId={null} onSendNow={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("collapses / expands the queue list", () => {
    render(
      <QueuePanel
        entries={[makeEntry()]}
        busy={false}
        editingId={null}
        onSendNow={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const head = screen.getByRole("button", { name: /已排队 1 条/ });
    expect(screen.getByText("帮我写一个测试")).toBeTruthy();
    fireEvent.click(head);
    expect(screen.queryByText("帮我写一个测试")).toBeNull();
  });

  it("drives edit / send-now / delete actions per entry", () => {
    const onEdit = vi.fn();
    const onSendNow = vi.fn();
    const onDelete = vi.fn();
    const entry = makeEntry();
    render(
      <QueuePanel entries={[entry]} busy={false} editingId={null} onSendNow={onSendNow} onEdit={onEdit} onDelete={onDelete} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑此排队消息" }));
    expect(onEdit).toHaveBeenCalledWith(entry);
    fireEvent.click(screen.getByRole("button", { name: "立即发送此排队消息" }));
    expect(onSendNow).toHaveBeenCalledWith("q1");
    fireEvent.click(screen.getByRole("button", { name: "删除此排队消息" }));
    expect(onDelete).toHaveBeenCalledWith("q1");
  });

  it("keeps send-now usable while the agent is busy", () => {
    const onSendNow = vi.fn();
    render(
      <QueuePanel entries={[makeEntry()]} busy editingId={null} onSendNow={onSendNow} onEdit={vi.fn()} onDelete={vi.fn()} />,
    );
    const sendNow = screen.getByRole("button", { name: "立即发送此排队消息" }) as HTMLButtonElement;
    expect(sendNow.disabled).toBe(false);
    expect(sendNow.getAttribute("title")).toBe("立即发送（不等当前回合结束）");
    fireEvent.click(sendNow);
    expect(onSendNow).toHaveBeenCalledWith("q1");
  });

  it("shows attachment count and empty-prompt preview", () => {
    render(
      <QueuePanel
        entries={[makeEntry({ text: "", attachments: [{ id: "a1", name: "x.png" } as unknown as QueuedPromptEntry["attachments"][number]] })]}
        busy={false}
        editingId={null}
        onSendNow={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("仅附件")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
  });
});

describe("QueuePanel attachment warnings", () => {
  const props = { busy: false, editingId: null, onSendNow: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() };

  it("warns that in-memory attachments die with a restart", () => {
    render(
      <QueuePanel
        {...props}
        entries={[makeEntry({
          text: "带张图",
          attachments: [{ source: "browser", name: "x.png", kind: "image", status: "ready" } as unknown as QueuedPromptEntry["attachments"][number]],
        })]}
      />,
    );

    expect(screen.getByText("附件重开窗口后会丢失")).toBeTruthy();
    expect(document.querySelector("[data-volatile='true']")).toBeTruthy();
  });

  it("marks entries whose attachments were lost on restore instead of hiding them", () => {
    render(
      <QueuePanel
        {...props}
        entries={[makeEntry({ text: "重启前写的", lostAttachments: 2 })]}
      />,
    );

    expect(screen.getByText("2 个附件已丢失，需重新添加")).toBeTruthy();
    expect(document.querySelector("[data-lost='true']")).toBeTruthy();
  });

  it("leaves path attachments unflagged", () => {
    render(
      <QueuePanel
        {...props}
        entries={[makeEntry({
          text: "带路径",
          attachments: [{ source: "path", path: "/a/b.txt", name: "b.txt", kind: "file", status: "ready" } as unknown as QueuedPromptEntry["attachments"][number]],
        })]}
      />,
    );

    expect(screen.queryByText(/附件重开窗口后会丢失/)).toBeNull();
    expect(document.querySelector("[data-volatile]")).toBeNull();
  });
});

describe("QueuePanel delivery failures", () => {
  const props = { busy: false, editingId: null, onEdit: vi.fn(), onDelete: vi.fn() };

  it("keeps the entry and shows the failure inline", () => {
    render(
      <QueuePanel {...props} entries={[makeEntry({ error: "连接超时" })]} onSendNow={vi.fn()} />,
    );

    expect(screen.getByText("帮我写一个测试")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("发送失败：连接超时");
    expect(document.querySelector("[data-failed='true']")).toBeTruthy();
  });

  it("retries the failed entry from the row", () => {
    const onSendNow = vi.fn();
    render(
      <QueuePanel {...props} entries={[makeEntry({ error: "连接超时" })]} onSendNow={onSendNow} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(onSendNow).toHaveBeenCalledWith("q1");
  });

  it("advertises the per-session cap in the header", () => {
    const entries = Array.from({ length: 8 }, (_, index) =>
      makeEntry({ id: `q${index}`, text: `第 ${index + 1} 条` }),
    );
    render(<QueuePanel {...props} entries={entries} onSendNow={vi.fn()} />);

    expect(screen.getByRole("button", { name: /已排队 8 条（上限 8 条）/ })).toBeTruthy();
  });
});

describe("QueuePanel keeps draining after a delete", () => {
  it("asks the parent to send the next entry when an idle queue loses one", async () => {
    const onSendNow = vi.fn();
    const onDelete = vi.fn();
    render(
      <QueuePanel
        entries={[makeEntry({ id: "a" }), makeEntry({ id: "b", text: "第二条" })]}
        busy={false}
        editingId={null}
        onSendNow={onSendNow}
        onEdit={vi.fn()}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "删除此排队消息" })[1]!);
    expect(onDelete).toHaveBeenCalledWith("b");
    expect(onSendNow).not.toHaveBeenCalled();

    await waitFor(() => expect(onSendNow).toHaveBeenCalledWith("a"), { timeout: 1500 });
  });

  it("stays quiet while the agent is still busy", async () => {
    const onSendNow = vi.fn();
    render(
      <QueuePanel
        entries={[makeEntry({ id: "a" }), makeEntry({ id: "b", text: "第二条" })]}
        busy
        editingId={null}
        onSendNow={onSendNow}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "删除此排队消息" })[0]!);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(onSendNow).not.toHaveBeenCalled();
  });
});
