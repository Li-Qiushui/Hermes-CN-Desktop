import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./chat-types";
import { chatMessagesEqual, stabilizeChatMessages } from "./message-stability";

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    role: "assistant",
    createdAt: 1,
    text: "hello",
    status: "complete",
    ...overrides,
  };
}

describe("chat message stability", () => {
  it("内容没变时复用旧引用", () => {
    const previous = [makeMessage({ id: "a" }), makeMessage({ id: "b", text: "world" })];
    const next = [makeMessage({ id: "a" }), makeMessage({ id: "b", text: "world" })];
    const stable = stabilizeChatMessages(previous, next);

    expect(stable[0]).toBe(previous[0]);
    expect(stable[1]).toBe(previous[1]);
  });

  it("只有变化的那条换引用（流式场景）", () => {
    const previous = [makeMessage({ id: "a" }), makeMessage({ id: "b", text: "wor" })];
    const next = [makeMessage({ id: "a" }), makeMessage({ id: "b", text: "world" })];
    const stable = stabilizeChatMessages(previous, next);

    expect(stable[0]).toBe(previous[0]);
    expect(stable[1]).not.toBe(previous[1]);
    expect(stable[1].text).toBe("world");
  });

  it("新增消息时保留已有引用", () => {
    const previous = [makeMessage({ id: "a" })];
    const next = [makeMessage({ id: "a" }), makeMessage({ id: "b", text: "new" })];
    const stable = stabilizeChatMessages(previous, next);

    expect(stable).toHaveLength(2);
    expect(stable[0]).toBe(previous[0]);
    expect(stable[1].text).toBe("new");
  });

  it("顺序变化按 id 复用，不会错位", () => {
    const previous = [makeMessage({ id: "a" }), makeMessage({ id: "b" })];
    const next = [makeMessage({ id: "b" }), makeMessage({ id: "a" })];
    const stable = stabilizeChatMessages(previous, next);

    expect(stable.map((m) => m.id)).toEqual(["b", "a"]);
    expect(stable[0]).toBe(previous[1]);
    expect(stable[1]).toBe(previous[0]);
    expect(chatMessagesEqual(previous[0], next[0])).toBe(false);
  });

  it("工具列表换了引用就认为内容变了", () => {
    const tool = { tool_id: "t1", name: "shell", status: "complete" } as never;
    const before = makeMessage({ tools: [tool] });
    const after = makeMessage({ tools: [tool] });
    expect(chatMessagesEqual(before, after)).toBe(false);
    expect(chatMessagesEqual(before, before)).toBe(true);
  });

  it("空的历史输入不做复用", () => {
    const next = [makeMessage()];
    expect(stabilizeChatMessages(undefined, next)).toBe(next);
    expect(stabilizeChatMessages([], next)).toBe(next);
  });
});
