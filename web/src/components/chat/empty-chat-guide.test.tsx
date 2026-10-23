/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "./chat-types";
import { EmptyChatGuide } from "./empty-chat-guide";
import { MessageTimeline } from "./message-timeline";

afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;
  vi.restoreAllMocks();
});

const stubScrollTo = () => {
  (HTMLElement.prototype as unknown as { scrollTo: unknown }).scrollTo = vi.fn();
};

const userMessage: ChatMessage = {
  id: "stored-1",
  role: "user",
  createdAt: 1,
  status: "complete",
  text: "帮我看看这个目录的代码结构",
};

describe("EmptyChatGuide", () => {
  it("offers clickable starters that only fill the composer", () => {
    const onPick = vi.fn();
    render(<EmptyChatGuide onPick={onPick} />);
    const starter = screen.getByText("解释这段报错");
    fireEvent.click(starter);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("解释这段报错");
    expect(onPick).not.toHaveBeenCalledWith("帮我看看这个目录的代码结构");
  });

  it("mentions drag and long-paste affordances", () => {
    render(<EmptyChatGuide onPick={() => {}} />);
    expect(screen.getByText(/可以把文件拖进来/)).toBeTruthy();
    expect(screen.getByText(/会自动转成附件/)).toBeTruthy();
  });
});

describe("MessageTimeline empty guide slot", () => {
  it("renders the guide only while the session has no messages", () => {
    stubScrollTo();
    const { rerender } = render(
      <MemoryRouter>
        <MessageTimeline
          messages={[]}
          emptyGuide={<EmptyChatGuide onPick={() => {}} />}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("继续上次那个任务")).toBeTruthy();

    rerender(
      <MemoryRouter>
        <MessageTimeline
          messages={[userMessage]}
          emptyGuide={<EmptyChatGuide onPick={() => {}} />}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByText("继续上次那个任务")).toBeNull();
    expect(screen.getByText("帮我看看这个目录的代码结构")).toBeTruthy();
  });

  it("keeps the plain empty state when no guide is supplied", () => {
    stubScrollTo();
    render(
      <MemoryRouter>
        <MessageTimeline messages={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByText("暂无对话记录")).toBeTruthy();
    expect(screen.queryByText("继续上次那个任务")).toBeNull();
  });
});
