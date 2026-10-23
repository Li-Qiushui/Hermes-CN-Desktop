import { describe, expect, it } from "vitest";
import { resolveRowDotState } from "./use-sidebar-session-state";
import { STALL_WATCHDOG_THRESHOLD_MS } from "@/lib/session-activity";
import { createEmptyChatRuntime, type ChatSessionRuntime } from "@/stores/chat";

function session(overrides: Record<string, unknown> = {}) {
  return { id: "s1", title: "有个标题", message_count: 3, preview: "预览", ...overrides };
}

function runtime(overrides: Partial<ChatSessionRuntime> = {}): ChatSessionRuntime {
  return { ...createEmptyChatRuntime(1), ...overrides };
}

function toolRunning(): ChatSessionRuntime {
  return runtime({
    streamStatus: "complete",
    messages: [
      {
        id: "m1",
        role: "assistant",
        parts: [{ type: "tool", state: "running", toolName: "terminal" }],
      },
    ] as unknown as ChatSessionRuntime["messages"],
  });
}

describe("resolveRowDotState", () => {
  it("待审批压过运行中与未读", () => {
    const pending = runtime({
      streamStatus: "streaming",
      pendingPrompts: [
        {
          kind: "clarify",
          promptId: "q1",
          generation: 1,
          sessionId: "s1",
          choices: ["a"],
          multiSelect: false,
          receivedAt: 1,
        },
      ],
    });
    expect(resolveRowDotState(session(), pending, { unread: true, now: 1_000 })).toBe("needs-input");
  });

  it("运行中但后端静默超过看门狗时是 stalled", () => {
    const running = runtime({
      streamStatus: "streaming",
      lastActivityAt: 10_000,
      turnStartedAt: 10_000,
    });
    expect(
      resolveRowDotState(session(), running, {
        unread: false,
        now: 10_000 + STALL_WATCHDOG_THRESHOLD_MS + 1,
      }),
    ).toBe("stalled");
    expect(
      resolveRowDotState(session(), running, {
        unread: false,
        now: 10_000 + STALL_WATCHDOG_THRESHOLD_MS - 1,
      }),
    ).toBe("working");
  });

  it("回合结束但工具还在跑时是 background", () => {
    expect(resolveRowDotState(session(), toolRunning(), { unread: false, now: 1_000 })).toBe(
      "background",
    );
  });

  it("没有运行信号时按未读 / 草稿 / 闲置排", () => {
    expect(resolveRowDotState(session(), undefined, { unread: true, now: 1_000 })).toBe("unread");
    expect(
      resolveRowDotState(session({ title: null, preview: undefined, message_count: 0 }), undefined, {
        unread: false,
        now: 1_000,
      }),
    ).toBe("draft");
    expect(resolveRowDotState(session(), undefined, { unread: false, now: 1_000 })).toBe("idle");
  });
});
