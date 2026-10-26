/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HermesUIMessage } from "@hermes/protocol";

import { MessageTimeline } from "./message-timeline";
import { hermesUIMessagesToChatMessages, mergeHermesUIMessages } from "./message-adapter";

vi.mock("@/lib/local-file-read", () => ({
  readLocalDataUrl: vi.fn(() => Promise.resolve("")),
  readLocalTextFile: vi.fn(),
}));

function uiMessage(overrides: Partial<HermesUIMessage> = {}): HermesUIMessage {
  return {
    id: "m1",
    sessionId: "s1",
    role: "assistant",
    createdAt: 100,
    status: "complete",
    parts: [],
    ...overrides,
  } as HermesUIMessage;
}

const TWO_MEDIA = "MEDIA:/tmp/report.html\nMEDIA:/tmp/bundle.zip";

function rowsWithRole(container: HTMLElement, role: "assistant" | "user"): Element[] {
  return Array.from(container.querySelectorAll("[data-message-index]")).filter(
    (row) => row.querySelector(`[data-role="${role}"]`) !== null,
  );
}

function renderMerged(stored: HermesUIMessage[], live: HermesUIMessage[]) {
  const messages = hermesUIMessagesToChatMessages(mergeHermesUIMessages(stored, live));
  return render(
    <MemoryRouter>
      <MessageTimeline messages={messages} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  (HTMLElement.prototype as unknown as { scrollTo: unknown }).scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;
  vi.restoreAllMocks();
});

describe("MEDIA 通道在时间线上的渲染份数", () => {
  it("一条带 2 个 MEDIA 标记的助手消息：1 个头 + 1 块卡区 + 2 张卡", () => {
    const { container } = renderMerged(
      [uiMessage({ id: "stored-1", parts: [{ type: "text", text: TWO_MEDIA }] })],
      [uiMessage({ id: "live-assistant-1", parts: [{ type: "text", text: TWO_MEDIA }] })],
    );

    expect(rowsWithRole(container, "assistant")).toHaveLength(1);
    expect(container.querySelectorAll('[data-media-channel="true"]')).toHaveLength(1);
    expect(screen.getByText("report.html")).toBeTruthy();
    expect(screen.getByText("bundle.zip")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "复制路径" })).toHaveLength(2);
  });

  it("纯 MEDIA 的助手消息配一条用户消息时：屏幕上只有 1 张助手卡区", () => {
    const { container } = renderMerged(
      [
        uiMessage({
          id: "user-1",
          role: "user",
          createdAt: 90,
          parts: [{ type: "text", text: `MEDIA:/tmp/report.html` }],
        }),
        uiMessage({ id: "stored-2", createdAt: 100, parts: [{ type: "text", text: TWO_MEDIA }] }),
      ],
      [uiMessage({ id: "live-assistant-2", createdAt: 101, parts: [{ type: "text", text: TWO_MEDIA }] })],
    );

    expect(rowsWithRole(container, "assistant")).toHaveLength(1);
    expect(rowsWithRole(container, "user")).toHaveLength(1);
    expect(container.querySelectorAll('[data-media-channel="true"]')).toHaveLength(2);
  });

  it("两个不同的 MEDIA 回合仍然各渲染一份", () => {
    const { container } = renderMerged(
      [
        uiMessage({ id: "stored-1", createdAt: 100, parts: [{ type: "text", text: "MEDIA:/tmp/a.html" }] }),
        uiMessage({ id: "stored-2", createdAt: 200, parts: [{ type: "text", text: "MEDIA:/tmp/b.zip" }] }),
      ],
      [],
    );

    expect(rowsWithRole(container, "assistant")).toHaveLength(2);
    expect(screen.getByText("a.html")).toBeTruthy();
    expect(screen.getByText("b.zip")).toBeTruthy();
  });
});
