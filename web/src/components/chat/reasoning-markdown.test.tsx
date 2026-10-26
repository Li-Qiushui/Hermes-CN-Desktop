/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router-dom";
import { Provider, createStore } from "jotai";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HermesUIMessage } from "@hermes/protocol";

import { showReasoningAtom } from "@/stores/ui";
import { clearDisclosureChoices } from "./activity-disclosure";
import { MessageTimeline } from "./message-timeline";
import { hermesUIMessagesToChatMessages } from "./message-adapter";

vi.mock("@/lib/local-file-read", () => ({
  readLocalDataUrl: vi.fn(() => Promise.resolve("")),
  readLocalTextFile: vi.fn(),
}));

const REASONING = '把 `style="width:155px"` 换掉，**别写死**。';

function reasoningMessage(): HermesUIMessage {
  return {
    id: "m1",
    sessionId: "s1",
    role: "assistant",
    createdAt: 100,
    status: "complete",
    parts: [{ type: "reasoning", text: REASONING }],
  } as HermesUIMessage;
}

const reasoningBody = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>('[class*="reasoningBody"]');

function renderTimeline(message: HermesUIMessage) {
  const store = createStore();
  store.set(showReasoningAtom, true);
  const messages = hermesUIMessagesToChatMessages([message]);
  return render(
    <Provider store={store}>
      <MemoryRouter>
        <MessageTimeline messages={messages} />
      </MemoryRouter>
    </Provider>,
  );
}

beforeEach(() => {
  clearDisclosureChoices();
  (HTMLElement.prototype as unknown as { scrollTo: unknown }).scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;
  vi.restoreAllMocks();
});

describe("推理正文按 markdown 渲染", () => {
  it("反引号渲染成 code 元素，不再是裸反引号文本", async () => {
    const { container } = renderTimeline(reasoningMessage());

    await waitFor(() => {
      expect(reasoningBody(container)?.querySelector("code")).not.toBeNull();
    });
    expect(reasoningBody(container)?.querySelector("code")?.textContent).toBe('style="width:155px"');
    expect(reasoningBody(container)?.textContent).not.toContain("`");
  });

  it("**粗体** 渲染成加粗元素（不是字面星号）", async () => {
    const { container } = renderTimeline(reasoningMessage());

    await waitFor(() => {
      expect(reasoningBody(container)?.querySelector('[data-streamdown="strong"]')).not.toBeNull();
    });
    expect(reasoningBody(container)?.querySelector('[data-streamdown="strong"]')?.textContent).toBe("别写死");
  });

  it("默认展开正文，用户手动收起后才不渲染", async () => {
    const { container } = renderTimeline(reasoningMessage());

    expect(screen.getByRole("button", { name: /推理过程/ })).toBeTruthy();
    expect(reasoningBody(container)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /推理过程/ }));
    expect(reasoningBody(container)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /推理过程/ }));
    expect(reasoningBody(container)).not.toBeNull();
  });

  it("流式期间（status=streaming）推理正文仍然排版：code 不是裸反引号", async () => {
    const { container } = renderTimeline({ ...reasoningMessage(), status: "streaming" });

    await waitFor(() => {
      expect(reasoningBody(container)?.querySelector("code")).not.toBeNull();
    });
    expect(reasoningBody(container)?.querySelector("code")?.textContent).toBe('style="width:155px"');
    expect(reasoningBody(container)?.textContent).not.toContain("`");
  });

  it("流式结束（转 complete）后不自动收起", async () => {
    const streaming = reasoningMessage();
    streaming.status = "streaming";
    const { container, rerender } = renderTimeline(streaming);
    expect(reasoningBody(container)).not.toBeNull();

    const store = createStore();
    store.set(showReasoningAtom, true);
    rerender(
      <Provider store={store}>
        <MemoryRouter>
          <MessageTimeline messages={hermesUIMessagesToChatMessages([reasoningMessage()])} />
        </MemoryRouter>
      </Provider>,
    );

    expect(reasoningBody(container)).not.toBeNull();
  });

  it("用户手动收起后重挂载仍保持收起（手动选择永久优先）", async () => {
    const first = renderTimeline(reasoningMessage());
    fireEvent.click(screen.getByRole("button", { name: /推理过程/ }));
    expect(reasoningBody(first.container)).toBeNull();
    first.unmount();

    const second = renderTimeline(reasoningMessage());
    expect(reasoningBody(second.container)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /推理过程/ }));
    expect(reasoningBody(second.container)).not.toBeNull();
  });

  it("没有推理内容就不出现思考行", () => {
    const message = reasoningMessage();
    message.parts = [];
    const { container } = renderTimeline(message);
    expect(screen.queryByRole("button", { name: /推理过程|正在思考/ })).toBeNull();
    expect(reasoningBody(container)).toBeNull();
  });
});
