/** @vitest-environment jsdom */
import { MemoryRouter, useLocation } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@hermes/protocol";
import type { ChatMessage } from "./chat-types";
import { EmptyChatGuide, pickRecentSessions, recentSessionTime } from "./empty-chat-guide";
import { MessageTimeline } from "./message-timeline";
import { activeSessionIdAtom } from "@/stores/ui";

const guideMocks = vi.hoisted(() => ({
  createEmptySession: vi.fn(),
  sessions: {} as { data?: { sessions: SessionSummary[] } },
}));

vi.mock("@/hooks/use-create-and-send-session", () => ({
  useCreateEmptySession: () => guideMocks.createEmptySession,
}));

vi.mock("@/hooks/use-sessions", () => ({
  useSessions: () => ({ data: guideMocks.sessions.data }),
}));

let currentPath = "/";

function PathProbe() {
  currentPath = useLocation().pathname;
  return null;
}

function renderGuide(onPick: (text: string) => void = () => {}) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <PathProbe />
      <EmptyChatGuide onPick={onPick} />
    </MemoryRouter>,
  );
}

function summary(id: string, startedAt: number, title = id): SessionSummary {
  return {
    id,
    title,
    model: "model",
    started_at: startedAt,
    ended_at: startedAt,
    message_count: 2,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: null,
  };
}

beforeEach(() => {
  currentPath = "/";
  guideMocks.sessions = {};
  guideMocks.createEmptySession.mockReset();
  guideMocks.createEmptySession.mockResolvedValue("new-session");
  getDefaultStore().set(activeSessionIdAtom, null);
});

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
    renderGuide(onPick);
    const starter = screen.getByText("解释这段报错");
    fireEvent.click(starter);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("解释这段报错");
    expect(onPick).not.toHaveBeenCalledWith("帮我看看这个目录的代码结构");
  });

  it("mentions drag and long-paste affordances", () => {
    renderGuide();
    expect(screen.getByText(/可以把文件拖进来/)).toBeTruthy();
    expect(screen.getByText(/会自动转成附件/)).toBeTruthy();
  });
});

describe("EmptyChatGuide entries", () => {
  it("creates a blank session without filling or sending a first message", async () => {
    const onPick = vi.fn();
    renderGuide(onPick);
    fireEvent.click(screen.getByText("新建空会话"));
    await waitFor(() => expect(guideMocks.createEmptySession).toHaveBeenCalledTimes(1));
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByText("新建空会话")).toBeTruthy();
  });

  it("reports a failed blank session inline instead of silently doing nothing", async () => {
    guideMocks.createEmptySession.mockRejectedValueOnce(new Error("网关没起来"));
    renderGuide();
    fireEvent.click(screen.getByText("新建空会话"));
    const error = await screen.findByText(/新建会话失败：网关没起来/);
    expect(error).toBeTruthy();
  });

  it("lists recent sessions and jumps into one on a single click", async () => {
    guideMocks.sessions = {
      data: {
        sessions: [summary("s-1", 100), summary("s-2", 300), summary("s-3", 200)],
      },
    };
    renderGuide();
    expect(screen.getByText("最近会话")).toBeTruthy();
    fireEvent.click(screen.getByText("s-2"));
    await waitFor(() => expect(currentPath).toBe("/tasks/s-2"));
    expect(getDefaultStore().get(activeSessionIdAtom)).toBe("s-2");
  });

  it("hides the current session from the recent list", () => {
    getDefaultStore().set(activeSessionIdAtom, "s-2");
    guideMocks.sessions = {
      data: { sessions: [summary("s-1", 100), summary("s-2", 300), summary("s-3", 200)] },
    };
    renderGuide();
    expect(screen.queryByText("s-2")).toBeNull();
    expect(screen.getByText("s-3")).toBeTruthy();
  });
});

describe("recent session helpers", () => {
  it("keeps the newest three and drops the active session", () => {
    const picked = pickRecentSessions(
      [summary("a", 10), summary("b", 40), summary("c", 30), summary("d", 20), summary("e", 50)],
      "b",
    );
    expect(picked.map((item) => item.id)).toEqual(["e", "c", "d"]);
  });

  it("formats today as a clock time and older days as a date", () => {
    const now = new Date(2026, 9, 24, 12, 0, 0);
    expect(recentSessionTime(new Date(2026, 9, 24, 9, 5, 0).getTime() / 1000, now)).toBe("09:05");
    expect(recentSessionTime(new Date(2026, 9, 20, 9, 5, 0).getTime() / 1000, now)).toBe("10/20");
    expect(recentSessionTime(undefined, now)).toBe("");
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
